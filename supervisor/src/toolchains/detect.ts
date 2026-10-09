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
    try {
        const stat = fs.statSync(file)
        if (!stat.isFile() || stat.size > MAX_BYTES) return null
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
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
    const mise = readSmall(at('mise.toml')) ?? readSmall(at('.mise.toml'))
    if (mise) {
        for (const line of mise.split('\n')) {
            const m = /^\s*(go|node|php|python|ruby|java|bun|deno)\s*=\s*["']?([^"'\s]+)/.exec(line)
            if (m) push(m[1] as ToolName, m[2], rel('mise.toml'))
        }
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
