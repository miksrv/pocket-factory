import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

import type { Config } from '../config.js'
import { createLogger } from '../logger.js'
import type { PreviewRow, Store } from '../store/index.js'
import type { SandboxManager } from './manager.js'
import type { Sbx } from './sbx.js'

const log = createLogger('preview')

const KEYS_META = 'preview.keys'
const TTL_EVERY_MS = 60_000

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface Preview extends PreviewRow {
    /** The address the owner opens: signs in, then lands on `base`. */
    url: string
    /** The path the app is served under (`/preview/<project>/<key>/`), what `PREVIEW_BASE` holds. */
    base: string
    /** When a preview nobody stops ends by itself; null = never. */
    expires_at: string | null
}

export interface PreviewEvents {
    opened: [preview: Preview]
    /** Stopped by the agent, the owner, a reset, the TTL, or found gone at start. */
    closed: [preview: Preview, reason: string]
}

/**
 * One preview per project: the agent starts its app in the sandbox and calls the factory's
 * `preview` tool with the port; the port is published on the host (`sbx ports --publish
 * <PREVIEW_BIND>:<host port>:<port>`), and the factory proxies `/preview/<project>/<key>/…` to it.
 *
 * The app's JavaScript is the agent's, so it runs under `CSP: sandbox` without `allow-same-origin`
 * (an opaque origin that cannot call `/api` as the owner). Such a page sends no cookies with its own
 * module scripts and fetches, so the path itself carries the access: `<key>` is a random value per
 * project, given out only after the owner signed in at `/preview/<project>/`, and changed by a Reset.
 * Without a sandbox (`SANDBOX=local`) the app is on the supervisor's own host and port.
 */
export class Previews extends EventEmitter<PreviewEvents> {
    private timer: NodeJS.Timeout | null = null

    constructor(
        private readonly store: Store,
        private readonly config: Config,
        private readonly sbx: Sbx | null,
        private readonly manager: SandboxManager
    ) {
        super()
    }

    private get sandboxed(): boolean {
        return this.config.sandbox.mode === 'sbx' && this.sbx !== null
    }

    start(): void {
        this.timer = setInterval(() => void this.expire(), TTL_EVERY_MS)
        this.timer.unref()
        void this.reconcile()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** The project's path key, made on first use. */
    key(project: string): string {
        const keys = this.store.getMeta<Record<string, string>>(KEYS_META) ?? {}
        if (keys[project]) return keys[project]
        const key = randomBytes(16).toString('hex')
        this.store.setMeta(KEYS_META, { ...keys, [project]: key })
        return key
    }

    /** A new key: every address handed out before stops working (a Reset). */
    rotate(project: string): void {
        const keys = this.store.getMeta<Record<string, string>>(KEYS_META) ?? {}
        delete keys[project]
        this.store.setMeta(KEYS_META, keys)
    }

    base(project: string): string {
        return `/preview/${encodeURIComponent(project)}/${this.key(project)}/`
    }

    /** The address to give the owner: the factory's sign-in first, then the app. */
    url(project: string): string {
        return `${this.config.web.publicUrl ?? ''}/preview/${encodeURIComponent(project)}/`
    }

    private view(row: PreviewRow): Preview {
        const ttl = this.config.preview.ttlMs
        return {
            ...row,
            url: this.url(row.project),
            base: this.base(row.project),
            expires_at: ttl > 0 ? new Date(Date.parse(row.created_at) + ttl).toISOString() : null
        }
    }

    get(project: string): Preview | null {
        const row = this.store.getPreview(project)
        return row ? this.view(row) : null
    }

    list(): Preview[] {
        return this.store.listPreviews().map((row) => this.view(row))
    }

    /** Whether a sandbox serves a preview now (the idle stop leaves it up). */
    pinned(sandbox: string): boolean {
        return this.store.listPreviews().some((p) => p.sandbox === sandbox)
    }

    /** Where the proxy sends a project's requests, or null when it has no preview. */
    upstream(project: string): { host: string; port: number; preview: Preview } | null {
        const preview = this.get(project)
        if (!preview) return null
        return {
            host: this.sandboxed ? this.config.preview.upstreamHost : '127.0.0.1',
            port: preview.host_port,
            preview
        }
    }

    /** Publish the app's port and record it; a project's earlier preview is replaced. */
    async open(
        project: string,
        port: number,
        options: { strip?: boolean; taskId?: string | null } = {}
    ): Promise<Preview> {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port must be 1–65535, got ${port}`)
        // Without a sandbox the port is on the supervisor's own host: never the factory itself.
        if (!this.sandboxed && port === this.config.web.port)
            throw new Error(`port ${port} is the factory's own; run the app on another port`)
        const sandbox = this.manager.nameFor(project)
        const old = this.store.getPreview(project)
        let hostPort = port
        if (this.sandboxed) {
            if (old) await this.unpublish(old)
            hostPort = await this.publish(sandbox, port, project)
        }
        const row = this.store.setPreview({
            project,
            sandbox,
            port,
            host_port: hostPort,
            strip: Boolean(options.strip),
            task_id: options.taskId ?? null
        })
        const preview = this.view(row)
        log.info(`${project}: preview of port ${port}${this.sandboxed ? ` on host port ${hostPort}` : ''}`)
        this.emit('opened', preview)
        return preview
    }

    /** The first free host port of PREVIEW_PORTS that sbx takes. */
    private async publish(sandbox: string, port: number, project: string): Promise<number> {
        const [first, last] = this.config.preview.ports
        const taken = new Set(
            this.store
                .listPreviews()
                .filter((p) => p.project !== project)
                .map((p) => p.host_port)
        )
        let lastError: unknown = null
        for (let hostPort = first; hostPort <= last; hostPort++) {
            if (taken.has(hostPort)) continue
            try {
                await this.sbx!.publish(sandbox, this.config.preview.bind, hostPort, port)
                return hostPort
            } catch (error) {
                lastError = error
                // A port another program holds: the next one. Anything else is the answer.
                if (!/in use|already|bind|allocated/i.test(message(error))) break
            }
        }
        throw new Error(`could not publish port ${port}: ${lastError ? message(lastError) : 'PREVIEW_PORTS is full'}`)
    }

    private async unpublish(row: PreviewRow): Promise<void> {
        if (!this.sandboxed) return
        await this.sbx!.unpublish(row.sandbox, this.config.preview.bind, row.host_port, row.port).catch(
            (error: unknown) => log.warn(`${row.project}: unpublish failed: ${message(error)}`)
        )
    }

    /** Stop a project's preview; false when it had none. */
    async close(project: string, reason: string): Promise<boolean> {
        const row = this.store.getPreview(project)
        if (!row) return false
        await this.unpublish(row)
        this.store.deletePreview(project)
        log.info(`${project}: preview closed (${reason})`)
        this.emit('closed', this.view(row), reason)
        return true
    }

    /** Previews whose time is up end by themselves. */
    async expire(now = Date.now()): Promise<void> {
        const ttl = this.config.preview.ttlMs
        if (ttl <= 0) return
        for (const row of this.store.listPreviews())
            if (now - Date.parse(row.created_at) >= ttl)
                await this.close(row.project, `open for ${Math.round(ttl / 3_600_000)} h`)
    }

    /** At start: a row whose binding sbx no longer has (the sandbox was removed by hand) is dropped. */
    async reconcile(): Promise<void> {
        if (!this.sandboxed) return
        let names: Set<string>
        try {
            names = new Set((await this.sbx!.ls()).map((s) => s.name))
        } catch (error) {
            log.warn(`previews not checked: ${message(error)}`)
            return
        }
        for (const row of this.store.listPreviews()) {
            if (names.has(row.sandbox)) continue
            this.store.deletePreview(row.project)
            log.info(`${row.project}: preview dropped, its sandbox is gone`)
            this.emit('closed', this.view(row), 'its sandbox is gone')
        }
    }
}
