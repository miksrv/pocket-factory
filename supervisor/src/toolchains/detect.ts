import fs from 'node:fs'
import path from 'node:path'

import YAML from 'yaml'

/**
 * What a checkout needs to build and test, read from the files the ecosystem
 * already keeps: the Go toolchain line, `.nvmrc`, `composer.json`, a compose
 * file with the services the tests expect. Pure file reading, no process
 * spawned, so the project form can ask for it on every open.
 */

export type ToolName = 'go' | 'node' | 'php' | 'python' | 'ruby' | 'java' | 'bun' | 'deno'

export interface ToolNeed {
    tool: ToolName
    /** The version or range the file names, as written ("1.25.1", "20", "^8.2"); null when the file only says "needed". */
    version: string | null
    /** The file that says so, relative to the checkout. */
    source: string
}

export interface ServiceNeed {
    /** The compose file, relative to the checkout. */
    file: string
    /** Service names in the file. */
    services: string[]
}

export interface Needs {
    tools: ToolNeed[]
    services: ServiceNeed[]
}

/** Where a repository keeps its parts: the root and these first-level directories are read. */
const SUBDIRS = ['server', 'client', 'api', 'web', 'backend', 'frontend', 'app', 'ui', 'cmd']
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const COMPOSE_DIRS = ['', 'config', 'docker', 'deploy', 'install/docker', 'dev', '.devcontainer']
/** Marker files are small; anything bigger is not one. */
const MAX_BYTES = 256 * 1024

function readSmall(file: string): string | null {
    // One descriptor for the check and the read: the file cannot be swapped between them.
    let fd: number | null = null
    try {
        fd = fs.openSync(file, 'r')
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size > MAX_BYTES) return null
        return fs.readFileSync(fd, 'utf8')
    } catch {
        return null
    } finally {
        if (fd !== null) fs.closeSync(fd)
    }
}

function json(text: string | null): Record<string, unknown> | null {
    if (!text) return null
    try {
        const parsed: unknown = JSON.parse(text)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
    } catch {
        return null
    }
}

/**
 * The version a `mise.toml` tool line names: `"20"`, `["20", "18"]` (the first),
 * `{ version = "3.12", virtualenv = ".venv" }`; null when the form is unknown.
 */
export function miseTomlVersion(value: string): string | null {
    const v = value.trim()
    const quoted = /^["']([^"']+)["']/.exec(v)
    if (quoted) return quoted[1]
    if (v.startsWith('[')) return /["']([^"']+)["']/.exec(v)?.[1] ?? null
    if (v.startsWith('{')) return /version\s*=\s*["']([^"']+)["']/.exec(v)?.[1] ?? null
    return null
}

/**
 * Whether an installed version satisfies a range the way composer / npm read it:
 * `^8.1` (same major, at least 8.1), `~8.1` (same major.minor), `>=8.1`, `>8.0`,
 * `8.2.*` / `8.2` (prefix), `<9`, alternatives with `||`, conjunctions by space or
 * comma. Unknown operators count as not satisfied. Compared on major.minor.patch.
 */
export function versionSatisfies(version: string, range: string): boolean {
    const nums = (v: string) => (lowestVersion(v) ?? '0').split('.').map(Number)
    const cmp = (a: number[], b: number[]) => {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const d = (a[i] ?? 0) - (b[i] ?? 0)
            if (d) return d
        }
        return 0
    }
    const have = nums(version)
    const one = (term: string): boolean => {
        const t = term.trim()
        if (!t || t === '*') return true
        const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+)*(?:\.\*)?)$/.exec(t)
        if (!m) return false
        const op = m[1] ?? ''
        const want = nums(m[2])
        const parts = m[2].replace(/\.\*$/, '').split('.').length
        if (op === '^') return have[0] === want[0] && cmp(have, want) >= 0
        if (op === '~') return have[0] === want[0] && (parts < 2 || have[1] === want[1]) && cmp(have, want) >= 0
        if (op === '>=') return cmp(have, want) >= 0
        if (op === '>') return cmp(have, want) > 0
        if (op === '<=') return cmp(have, want) <= 0
        if (op === '<') return cmp(have, want) < 0
        // `8.2`, `8.2.*`, `=8.2.34`: the named part must match.
        return want.slice(0, parts).every((n, i) => (have[i] ?? 0) === n)
    }
    return range.split('||').some((alt) =>
        alt
            .split(/\s*,\s*|\s+/)
            .filter(Boolean)
            .every(one)
    )
}

/** `^8.2 || ^8.3` → "8.2": the lowest major.minor a range admits is the one to install. */
export function lowestVersion(range: string): string | null {
    const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range)
    if (!match) return null
    return [match[1], match[2], match[3]].filter((p) => p !== undefined).join('.')
}

function toolsIn(dir: string, prefix: string): ToolNeed[] {
    const at = (name: string) => path.join(dir, name)
    const rel = (name: string) => (prefix ? `${prefix}/${name}` : name)
    const out: ToolNeed[] = []
    const push = (tool: ToolName, version: string | null, source: string) => {
        if (!out.some((n) => n.tool === tool)) out.push({ tool, version, source })
    }

    // mise.toml / .tool-versions name tools outright; they win over the ecosystem files.
    for (const file of ['mise.toml', '.mise.toml']) {
        const mise = readSmall(at(file))
        if (!mise) continue
        for (const line of mise.split('\n')) {
            const m = /^\s*(go|node|php|python|ruby|java|bun|deno)\s*=\s*(.+)$/.exec(line)
            if (m) push(m[1] as ToolName, miseTomlVersion(m[2]), rel(file))
        }
        break
    }
    const toolVersions = readSmall(at('.tool-versions'))
    if (toolVersions) {
        for (const line of toolVersions.split('\n')) {
            const m = /^\s*(golang|go|nodejs|node|php|python|ruby|java|bun|deno)\s+(\S+)/.exec(line)
            if (m)
                push(
                    (m[1] === 'golang' ? 'go' : m[1] === 'nodejs' ? 'node' : m[1]) as ToolName,
                    m[2],
                    rel('.tool-versions')
                )
        }
    }

    const goMod = readSmall(at('go.mod'))
    if (goMod) {
        // `toolchain go1.25.1` is the version the module is built with; the `go` directive is only the minimum.
        const toolchain = /^toolchain\s+go(\S+)/m.exec(goMod)
        const directive = /^go\s+(\S+)/m.exec(goMod)
        push('go', toolchain?.[1] ?? directive?.[1] ?? null, rel('go.mod'))
    }
    const goVersion = readSmall(at('.go-version'))
    if (goVersion?.trim()) push('go', goVersion.trim(), rel('.go-version'))

    for (const file of ['.nvmrc', '.node-version']) {
        const text = readSmall(at(file))?.trim()
        if (text) push('node', text.replace(/^v/, ''), rel(file))
    }
    const pkg = json(readSmall(at('package.json')))
    if (pkg) {
        const engines = pkg.engines as Record<string, unknown> | undefined
        const node = typeof engines?.node === 'string' ? engines.node : null
        push('node', node, rel('package.json'))
        const packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager : ''
        if (packageManager.startsWith('bun@')) push('bun', packageManager.slice(4), rel('package.json'))
    }

    const composer = json(readSmall(at('composer.json')))
    if (composer) {
        const require = composer.require as Record<string, unknown> | undefined
        push('php', typeof require?.php === 'string' ? require.php : null, rel('composer.json'))
    }
    const phpVersion = readSmall(at('.php-version'))
    if (phpVersion?.trim()) push('php', phpVersion.trim(), rel('.php-version'))

    const pythonVersion = readSmall(at('.python-version'))
    if (pythonVersion?.trim()) push('python', pythonVersion.trim().split('\n')[0], rel('.python-version'))
    const pyproject = readSmall(at('pyproject.toml'))
    if (pyproject) {
        const m = /^requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)
        push('python', m?.[1] ?? null, rel('pyproject.toml'))
    }
    if (readSmall(at('requirements.txt')) !== null) push('python', null, rel('requirements.txt'))
    const runtime = readSmall(at('runtime.txt'))
    if (runtime) {
        const m = /python-(\S+)/.exec(runtime)
        if (m) push('python', m[1], rel('runtime.txt'))
    }

    const rubyVersion = readSmall(at('.ruby-version'))
    if (rubyVersion?.trim()) push('ruby', rubyVersion.trim(), rel('.ruby-version'))
    if (readSmall(at('Gemfile')) !== null) push('ruby', null, rel('Gemfile'))

    if (readSmall(at('pom.xml')) !== null) push('java', null, rel('pom.xml'))
    if (readSmall(at('build.gradle')) !== null || readSmall(at('build.gradle.kts')) !== null)
        push('java', null, rel('build.gradle'))

    return out
}

function servicesIn(root: string): ServiceNeed[] {
    const out: ServiceNeed[] = []
    for (const dir of COMPOSE_DIRS) {
        for (const name of COMPOSE_FILES) {
            const rel = dir ? `${dir}/${name}` : name
            const text = readSmall(path.join(root, rel))
            if (text === null) continue
            let services: string[]
            try {
                const doc = YAML.parse(text) as { services?: Record<string, unknown> } | null
                services = doc?.services && typeof doc.services === 'object' ? Object.keys(doc.services) : []
            } catch {
                services = []
            }
            out.push({ file: rel, services })
        }
    }
    return out
}

/** The needs of a checkout: tools from the root and its common sub-projects (first match per tool wins), compose services. */
export function detectNeeds(root: string): Needs {
    if (!fs.existsSync(root)) return { tools: [], services: [] }
    const tools: ToolNeed[] = []
    const seen = new Set<ToolName>()
    for (const sub of ['', ...SUBDIRS]) {
        const dir = sub ? path.join(root, sub) : root
        if (sub && !fs.existsSync(dir)) continue
        for (const need of toolsIn(dir, sub)) {
            if (seen.has(need.tool)) continue
            seen.add(need.tool)
            tools.push(need)
        }
    }
    return { tools, services: servicesIn(root) }
}

/** The `tool@version` mise installs for a need; a range becomes its lowest version, no version = latest. */
export function miseSpec(need: Pick<ToolNeed, 'tool' | 'version'>): string {
    const version = need.version ? lowestVersion(need.version) : null
    return version ? `${need.tool}@${version}` : need.tool
}
