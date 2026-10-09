import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createLogger } from '../logger.js'
import { detectNeeds, miseSpec, type Needs, type ToolNeed, versionSatisfies } from './detect.js'
import { type DockerContainer, type DockerInfo, DockerSidecar } from './docker.js'
import { isMiseSpec, Mise, type MiseInstall } from './mise.js'

const run = promisify(execFile)
const log = createLogger('toolchains')

/** The sizes and lists the Settings page shows are spawned processes and `du`: refreshed this often at most. */
const CACHE_MS = 60_000

export interface ToolVersion extends MiseInstall {
    size_kb: number | null
    /** Project slugs whose checkout resolves to this version. */
    used_by: string[]
    /** `source` relative to the workspaces root when it lies there ("geometki/client/.nvmrc"). */
    asked_by: string | null
}

export interface ToolchainContainer extends DockerContainer {
    /** The project whose checkout the compose file ran in, when it is one of the factory's. */
    project: string | null
}

export interface ToolchainsOverview {
    mise: {
        /** null: no factory mise here (MISE_DATA_DIR unset, as under `yarn dev`) or none on PATH; a listing that failed is in `error`. */
        version: string | null
        data_dir: string
        size_kb: number | null
        tools: ToolVersion[]
        error: string | null
    }
    /** What the image carries besides mise: PHP with composer. */
    image: { php: string | null; composer: string | null }
    docker: Omit<DockerInfo, 'containers'> & { containers: ToolchainContainer[] }
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
    /** The workspaces root: compose directories and version files under it are reported relative to it. */
    root: string
    projectPath: (slug: string) => string | null
    projects: () => string[]
}

/** "not yet probed": what `health()` answers until the first background probe lands. */
const PENDING_HEALTH: ToolchainsHealth = {
    mise: null,
    tools: 0,
    size_kb: null,
    php: null,
    docker: { enabled: false, reachable: false, version: null, running: 0, error: null }
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
 * the image, services on the dind sidecar. The overview (processes and `du`)
 * is cached a minute and never rejects; `health()` for the status heartbeat
 * answers from the cache at once and refreshes in the background, so a sidecar
 * that is down or a slow `du` never holds a request. Writes (install, remove,
 * prune, stop) drop the cache.
 *
 * The factory's mise is the one `MISE_DATA_DIR` points at (set by the image).
 * Without that variable (`yarn dev` on a laptop) a mise on PATH is the
 * developer's own and is left alone: nothing is listed, removed or pruned.
 */
export class Toolchains {
    readonly mise: Mise
    readonly docker: DockerSidecar
    /** The factory's mise exists only where the image set its data directory. */
    readonly miseConfigured: boolean
    private overviewCache: { at: number; value: Promise<ToolchainsOverview> } | null = null
    private refreshing: Promise<void> | null = null
    private lastHealth: ToolchainsHealth | null = null

    constructor(
        private readonly workspace: ToolchainsWorkspace,
        private readonly dataDir = process.env.MISE_DATA_DIR ?? '',
        mise = new Mise(),
        docker = new DockerSidecar()
    ) {
        this.mise = mise
        this.docker = docker
        this.miseConfigured = Boolean(dataDir)
    }

    invalidate(): void {
        this.overviewCache = null
    }

    /** The cached overview, built on first use and after CACHE_MS; a build that fails is not kept. */
    overview(): Promise<ToolchainsOverview> {
        if (!this.overviewCache || Date.now() - this.overviewCache.at > CACHE_MS) {
            const value = this.buildOverview()
            this.overviewCache = { at: Date.now(), value }
            value.catch(() => {
                if (this.overviewCache?.value === value) this.overviewCache = null
            })
        }
        return this.overviewCache.value
    }

    private async buildOverview(): Promise<ToolchainsOverview> {
        const [version, php, composer, docker] = await Promise.all([
            this.miseConfigured ? this.mise.version() : Promise.resolve(null),
            versionOf('php', ['-r', 'echo PHP_VERSION;']),
            versionOf('composer', ['--version', '--no-ansi']),
            this.docker.info()
        ])
        let tools: ToolVersion[] = []
        let size: number | null = null
        let error: string | null = null
        if (version) {
            try {
                const [installed, usage, total] = await Promise.all([
                    this.mise.installed(),
                    this.usage(),
                    diskKb(this.dataDir)
                ])
                size = total
                tools = await Promise.all(
                    installed.map(async (t) => ({
                        ...t,
                        size_kb: await diskKb(t.install_path),
                        used_by: usage.get(`${t.tool}@${t.version}`) ?? [],
                        asked_by: t.source ? this.relative(t.source) : null
                    }))
                )
            } catch (e) {
                error = (e as Error).message.split('\n')[0]
                log.warn(`mise could not list its installs: ${error}`)
            }
        }
        return {
            mise: { version, data_dir: this.dataDir, size_kb: size, tools, error },
            image: { php, composer: composer?.replace(/^Composer version /, '') ?? null },
            docker: {
                ...docker,
                containers: docker.containers.map((c) => ({ ...c, project: this.projectOf(c.compose.working_dir) }))
            }
        }
    }

    /** A path under the workspaces root, relative to it; else as given. */
    private relative(file: string): string {
        const root = this.workspace.root.replace(/\/+$/, '') + '/'
        return file.startsWith(root) ? file.slice(root.length) : file
    }

    /** The project whose checkout holds `dir`, when it is one of the factory's. */
    private projectOf(dir: string | null): string | null {
        if (!dir) return null
        for (const slug of this.workspace.projects()) {
            const checkout = this.workspace.projectPath(slug)?.replace(/\/+$/, '')
            if (checkout && (dir === checkout || dir.startsWith(checkout + '/'))) return slug
        }
        return null
    }

    /** Which projects resolve to which installed version: `tool@version` → slugs. */
    private async usage(): Promise<Map<string, string[]>> {
        const out = new Map<string, string[]>()
        const slugs = this.workspace.projects()
        const resolved = await Promise.all(
            slugs.map(async (slug) => {
                const dir = this.workspace.projectPath(slug)
                if (!dir) return []
                try {
                    return await this.mise.current(dir)
                } catch {
                    return [] // a checkout mise cannot read is simply not counted
                }
            })
        )
        slugs.forEach((slug, i) => {
            for (const c of resolved[i]) {
                const key = `${c.tool}@${c.version}`
                out.set(key, [...(out.get(key) ?? []), slug])
            }
        })
        return out
    }

    /**
     * The summary for `/api/status`: the last overview's figures at once; a stale or
     * missing overview is rebuilt in the background, a build in progress is waited for
     * only briefly. Never rejects.
     */
    async health(): Promise<ToolchainsHealth> {
        const fresh = this.overviewCache && Date.now() - this.overviewCache.at <= CACHE_MS
        if (!fresh && !this.refreshing) {
            this.refreshing = this.overview()
                .then(() => undefined)
                .catch(() => undefined)
                .finally(() => {
                    this.refreshing = null
                })
        }
        const cached = this.overviewCache?.value
        if (!cached) return this.lastHealth ?? PENDING_HEALTH
        const settled = await Promise.race([
            cached.then((o) => o).catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))
        ])
        if (!settled) return this.lastHealth ?? PENDING_HEALTH
        this.lastHealth = {
            mise: settled.mise.version,
            tools: settled.mise.tools.length,
            size_kb: settled.mise.size_kb,
            php: settled.image.php,
            docker: {
                enabled: settled.docker.enabled,
                reachable: settled.docker.reachable,
                version: settled.docker.version,
                running: settled.docker.containers.filter((c) => c.state === 'running').length,
                error: settled.docker.error
            }
        }
        return this.lastHealth
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
            // PHP comes from the image: good when the image's version satisfies the checkout's range.
            if (need.tool === 'php' && o.image.php && (!need.version || versionSatisfies(o.image.php, need.version)))
                return { ...need, spec, status: 'image', installed_version: o.image.php }
            if (!o.mise.version) return { ...need, spec, status: 'unknown', installed_version: null }
            return { ...need, spec, status: 'missing', installed_version: resolved?.version ?? null }
        })
        return { slug, path: dir, tools, services: needs.services, docker: { enabled: this.docker.enabled } }
    }

    private requireMise(): void {
        if (!this.miseConfigured)
            throw new Error('no factory mise here (MISE_DATA_DIR is not set): run in the container')
    }

    async install(spec: string): Promise<string> {
        if (!isMiseSpec(spec)) throw new Error(`not a tool spec: "${spec}"`)
        this.requireMise()
        log.info(`mise install ${spec}`)
        const out = await this.mise.install(spec)
        this.invalidate()
        return out
    }

    async uninstall(tool: string, version: string): Promise<string> {
        const spec = `${tool}@${version}`
        if (!isMiseSpec(spec)) throw new Error(`not a tool spec: "${spec}"`)
        this.requireMise()
        log.info(`mise uninstall ${spec}`)
        const out = await this.mise.uninstall(spec)
        this.invalidate()
        return out
    }

    /** Versions no checkout asks for any more, plus Docker's stopped containers, dangling images and build cache. */
    async prune(): Promise<{ mise: string; docker: string | null }> {
        this.requireMise()
        const mise = await this.mise.prune()
        const docker = this.docker.enabled ? await this.docker.prune() : null
        this.invalidate()
        log.info(`pruned: mise ${mise.trim().split('\n').pop() ?? ''}${docker ? `; docker reclaimed ${docker}` : ''}`)
        return { mise, docker }
    }

    async stopContainer(id: string): Promise<void> {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) throw new Error('not a container id')
        await this.docker.stop(id)
        this.invalidate()
    }

    async dockerPrune(): Promise<string> {
        const out = await this.docker.prune()
        this.invalidate()
        return out
    }
}
