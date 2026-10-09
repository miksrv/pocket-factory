import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { createLogger } from '../logger.js'
import { detectNeeds, lowestVersion, miseSpec, type Needs, type ToolNeed } from './detect.js'
import { type DockerInfo, DockerSidecar } from './docker.js'
import { isMiseSpec, Mise, type MiseInstall } from './mise.js'

const run = promisify(execFile)
const log = createLogger('toolchains')

/** The sizes and lists the Settings page shows are spawned processes and `du`: refreshed this often at most. */
const CACHE_MS = 60_000

export interface ToolVersion extends MiseInstall {
    size_kb: number | null
    /** Project slugs whose checkout resolves to this version. */
    used_by: string[]
}

export interface ToolchainsOverview {
    mise: { version: string | null; data_dir: string; size_kb: number | null; tools: ToolVersion[] }
    /** What the image carries besides mise: PHP with composer. */
    image: { php: string | null; composer: string | null }
    docker: DockerInfo
}

export interface ProjectTool extends ToolNeed {
    /** What `mise install` would get. */
    spec: string
    /** `installed`: mise has it; `image`: the image carries it (PHP); `missing`: install it; `unknown`: mise is not available here. */
    status: 'installed' | 'image' | 'missing' | 'unknown'
    /** The version in use for this checkout, when known. */
    installed_version: string | null
}

export interface ProjectToolchain extends Needs {
    slug: string
    path: string | null
    tools: ProjectTool[]
    docker: { enabled: boolean }
}

export interface ToolchainsHealth {
    mise: string | null
    tools: number
    size_kb: number | null
    php: string | null
    docker: { enabled: boolean; reachable: boolean; version: string | null; running: number; error: string | null }
}

export interface ToolchainsWorkspace {
    projectPath: (slug: string) => string | null
    projects: () => string[]
}

async function diskKb(dir: string): Promise<number | null> {
    try {
        const { stdout } = await run('du', ['-sk', dir], { timeout: 60_000 })
        return Number(stdout.split('\t')[0]) || 0
    } catch {
        return null
    }
}

async function versionOf(cmd: string, args: string[]): Promise<string | null> {
    try {
        const { stdout } = await run(cmd, args, { timeout: 10_000, env: process.env })
        return stdout.trim().split('\n')[0] || null
    } catch {
        return null
    }
}

/**
 * Toolchains for the agents: mise-installed runtimes on /data/tools, PHP from
 * the image, services on the dind sidecar. Reads for the UI are cached a
 * minute; writes (install, remove, prune, stop) drop the cache.
 */
export class Toolchains {
    readonly mise: Mise
    readonly docker: DockerSidecar
    private overviewCache: { at: number; value: Promise<ToolchainsOverview> } | null = null
    private healthCache: { at: number; value: Promise<ToolchainsHealth> } | null = null

    constructor(
        private readonly workspace: ToolchainsWorkspace,
        private readonly dataDir = process.env.MISE_DATA_DIR ??
            path.join(process.env.DATA_ROOT ?? 'data', 'tools', 'mise'),
        mise = new Mise(),
        docker = new DockerSidecar()
    ) {
        this.mise = mise
        this.docker = docker
    }

    invalidate(): void {
        this.overviewCache = null
        this.healthCache = null
    }

    overview(): Promise<ToolchainsOverview> {
        if (!this.overviewCache || Date.now() - this.overviewCache.at > CACHE_MS)
            this.overviewCache = { at: Date.now(), value: this.buildOverview() }
        return this.overviewCache.value
    }

    private async buildOverview(): Promise<ToolchainsOverview> {
        const [version, php, composer, docker] = await Promise.all([
            this.mise.version(),
            versionOf('php', ['-r', 'echo PHP_VERSION;']),
            versionOf('composer', ['--version', '--no-ansi']),
            this.docker.info()
        ])
        let tools: ToolVersion[] = []
        let size: number | null = null
        if (version) {
            const [installed, usage] = await Promise.all([this.mise.installed(), this.usage()])
            size = await diskKb(this.dataDir)
            tools = await Promise.all(
                installed.map(async (t) => ({
                    ...t,
                    size_kb: await diskKb(t.install_path),
                    used_by: usage.get(`${t.tool}@${t.version}`) ?? []
                }))
            )
        }
        return {
            mise: { version, data_dir: this.dataDir, size_kb: size, tools },
            image: { php, composer: composer?.replace(/^Composer version /, '') ?? null },
            docker
        }
    }

    /** Which projects resolve to which installed version: `tool@version` → slugs. */
    private async usage(): Promise<Map<string, string[]>> {
        const out = new Map<string, string[]>()
        for (const slug of this.workspace.projects()) {
            const dir = this.workspace.projectPath(slug)
            if (!dir) continue
            try {
                for (const c of await this.mise.current(dir)) {
                    const key = `${c.tool}@${c.version}`
                    out.set(key, [...(out.get(key) ?? []), slug])
                }
            } catch {
                // a checkout mise cannot read is simply not counted
            }
        }
        return out
    }

    health(): Promise<ToolchainsHealth> {
        if (!this.healthCache || Date.now() - this.healthCache.at > CACHE_MS)
            this.healthCache = { at: Date.now(), value: this.buildHealth() }
        return this.healthCache.value
    }

    private async buildHealth(): Promise<ToolchainsHealth> {
        const o = await this.overview()
        return {
            mise: o.mise.version,
            tools: o.mise.tools.length,
            size_kb: o.mise.size_kb,
            php: o.image.php,
            docker: {
                enabled: o.docker.enabled,
                reachable: o.docker.reachable,
                version: o.docker.version,
                running: o.docker.containers.filter((c) => c.state === 'running').length,
                error: o.docker.error
            }
        }
    }

    /** The needs of a project's checkout with what the factory has for each. */
    async project(slug: string): Promise<ProjectToolchain> {
        const dir = this.workspace.projectPath(slug)
        const needs = dir ? detectNeeds(dir) : { tools: [], services: [] }
        const o = await this.overview()
        let current = new Map<string, { version: string; installed: boolean }>()
        if (dir && o.mise.version) {
            try {
                current = new Map((await this.mise.current(dir)).map((c) => [c.tool, c]))
            } catch (error) {
                log.warn(`mise could not read ${dir}: ${(error as Error).message.split('\n')[0]}`)
            }
        }
        const tools: ProjectTool[] = needs.tools.map((need) => {
            const spec = miseSpec(need)
            const resolved = current.get(need.tool)
            if (resolved?.installed) return { ...need, spec, status: 'installed', installed_version: resolved.version }
            // PHP comes from the image: good when the major.minor the checkout wants is the image's.
            if (need.tool === 'php' && o.image.php) {
                const wanted = need.version ? lowestVersion(need.version) : null
                if (!wanted || o.image.php.startsWith(wanted))
                    return { ...need, spec, status: 'image', installed_version: o.image.php }
            }
            if (!o.mise.version) return { ...need, spec, status: 'unknown', installed_version: null }
            return { ...need, spec, status: 'missing', installed_version: resolved?.version ?? null }
        })
        return { slug, path: dir, tools, services: needs.services, docker: { enabled: this.docker.enabled } }
    }

    async install(spec: string): Promise<string> {
        if (!isMiseSpec(spec)) throw new Error(`not a tool spec: "${spec}"`)
        log.info(`mise install ${spec}`)
        const out = await this.mise.install(spec)
        this.invalidate()
        return out
    }

    async uninstall(tool: string, version: string): Promise<string> {
        const spec = `${tool}@${version}`
        if (!isMiseSpec(spec)) throw new Error(`not a tool spec: "${spec}"`)
        log.info(`mise uninstall ${spec}`)
        const out = await this.mise.uninstall(spec)
        this.invalidate()
        return out
    }

    /** Versions no checkout asks for any more, plus Docker's stopped containers, dangling images and build cache. */
    async prune(): Promise<{ mise: string; docker: string | null }> {
        const mise = await this.mise.prune()
        const docker = this.docker.enabled ? await this.docker.prune() : null
        this.invalidate()
        log.info(`pruned: mise ${mise.trim().split('\n').pop() ?? ''}${docker ? `; docker reclaimed ${docker}` : ''}`)
        return { mise, docker }
    }

    async stopContainer(id: string): Promise<void> {
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw new Error('not a container id')
        await this.docker.stop(id)
        this.invalidate()
    }

    async dockerPrune(): Promise<string> {
        const out = await this.docker.prune()
        this.invalidate()
        return out
    }
}
