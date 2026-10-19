import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import type { Config } from '../config.js'
import { createLogger } from '../logger.js'
import type { Store } from '../store/index.js'
import { killByMark } from './executor.js'
import type { Approval, DiagnoseCheck, SandboxInfo, Sbx } from './sbx.js'

const log = createLogger('sandbox')

/** The prefix of every sandbox the factory made; the owner's own (`probe`) are never touched. */
export const SANDBOX_PREFIX = 'pf-'
/** The factory's own sandbox: project-less chats, chat titles, the limits probe, `claude mcp list`. */
export const FACTORY_SANDBOX = 'pf-factory'

/** What the manager needs to know about projects, from the catalog. */
export interface SandboxRefs {
    /** A project's checkout on disk, or null. */
    projectPath: (slug: string) => string | null
    projects: () => string[]
    /** The hosts the sandbox must reach (its project's `network:`, `hosts:`, routines' Trac sites). */
    network: (project: string | null) => string[]
    /** A sandbox kept up by something besides a run (an open preview). */
    pinned: (name: string) => boolean
    /** A host the owner allowed from an approval goes into the project file's `network:`. */
    allowNetwork: (project: string, resource: string) => void
}

/** A blocked request with the project its sandbox belongs to. */
export interface PendingApproval extends Approval {
    project: string | null
    seen_at: string
}

export interface SandboxView {
    name: string
    /** The project it belongs to; null for the factory's own. */
    project: string | null
    status: string
    workspaces: string[]
    /** Runs going on in it now (tasks, scripts, side calls). */
    active: number
    last_used_at: string | null
    created_at: string | null
    pinned: boolean
}

export interface SandboxStatus {
    mode: 'sbx' | 'local'
    /** The daemon answered the last check; null before the first one (and in local mode). */
    ok: boolean | null
    error: string | null
    version: string | null
    /** The Docker account (`sbx login`) as `diagnose` says; null when unknown. */
    docker_login: boolean | null
    /** The Claude login stored with the daemon (`sbx secret ls`: anthropic). */
    claude_login: boolean | null
    sandboxes: SandboxView[]
    approvals: PendingApproval[]
    checked_at: string | null
}

export interface ManagerEvents {
    /** A request a sandbox's policy held back, seen for the first time. */
    approval: [approval: PendingApproval]
}

/** How long `sbx ls` is trusted inside `ensure`, so a burst of tasks does not list once each. */
const LIST_TTL_MS = 5_000
/** The status the UI polls is refreshed in the background at most this often. */
const STATUS_TTL_MS = 60_000
/** Approvals are looked at this often while anything runs in a sandbox. */
const APPROVALS_EVERY_MS = 5_000
const IDLE_EVERY_MS = 60_000
/** Bumped when the one-time setup inside a sandbox changes: existing sandboxes get it again. */
const SETUP_VERSION = 1
/** The wrappers that give git and gh a token per repository owner, copied into every sandbox. */
const HELPERS = ['gh', 'gh-token', 'git-credential-owner']

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** `pf-<slug>`: a project slug as sbx accepts it (lower case, letters, digits, hyphens, periods). */
export function sandboxName(project: string | null): string {
    if (!project) return FACTORY_SANDBOX
    const slug = project
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 60)
    // A project named "factory" must not take the factory's own sandbox.
    return `${SANDBOX_PREFIX}${slug === 'factory' ? 'factory-project' : slug || 'project'}`
}

/** Whether `file` is `dir` or inside it. */
const under = (file: string, dir: string) => file === dir || file.startsWith(dir.replace(/\/+$/, '') + '/')

/**
 * One persistent Docker Sandbox per project (`pf-<slug>`) and one for the factory itself
 * (`pf-factory`): made on first use with the checkout, `data/claude`, `data/config` and
 * `data/inbox` mounted at their own paths, set up once (the GitHub wrappers, git's identity, the
 * SSH keys, a placeholder login file the proxy fills in), given the network rules its project
 * needs, stopped when idle and never removed but by the owner's Reset.
 */
export class SandboxManager extends EventEmitter<ManagerEvents> {
    private listing: { at: number; value: Promise<SandboxInfo[]> } | null = null
    /** One `ensure` per sandbox at a time: two tasks of a project must not both create it. */
    private readonly ensuring = new Map<string, Promise<string>>()
    /** Runs in flight per sandbox, and when the last one touched it. */
    private readonly active = new Map<string, number>()
    private readonly touched = new Map<string, number>()
    /** Sandboxes whose leftover runs (a previous supervisor's) were killed since start. */
    private readonly swept = new Set<string>()
    private readonly pending = new Map<string, PendingApproval>()
    private snapshot: SandboxStatus
    private refreshing: Promise<void> | null = null
    private readonly timers: NodeJS.Timeout[] = []
    private approvalsBusy = false
    /** Idle stops in flight: an `ensure` waits for one rather than exec into a VM going down. */
    private readonly stopping = new Map<string, Promise<void>>()
    /** Rule updates one after another per sandbox: they read and write the same `meta` row. */
    private readonly ruling = new Map<string, Promise<void>>()

    constructor(
        private readonly sbx: Sbx,
        private readonly store: Store,
        private readonly config: Config,
        private readonly refs: SandboxRefs
    ) {
        super()
        this.snapshot = {
            mode: config.sandbox.mode,
            ok: null,
            error: null,
            version: null,
            docker_login: null,
            claude_login: null,
            sandboxes: [],
            approvals: [],
            checked_at: null
        }
    }

    get enabled(): boolean {
        return this.config.sandbox.mode === 'sbx'
    }

    start(): void {
        if (!this.enabled) return
        const idle = setInterval(() => void this.idleStop(), IDLE_EVERY_MS)
        const approvals = setInterval(() => void this.pollApprovals(), APPROVALS_EVERY_MS)
        idle.unref()
        approvals.unref()
        this.timers.push(idle, approvals)
        void this.refresh()
    }

    stop(): void {
        for (const timer of this.timers.splice(0)) clearInterval(timer)
    }

    nameFor(project: string | null): string {
        return sandboxName(project)
    }

    /** The project a `pf-*` sandbox belongs to (null for the factory's own or a stranger). */
    projectOf(name: string): string | null {
        if (name === FACTORY_SANDBOX) return null
        return this.refs.projects().find((p) => sandboxName(p) === name) ?? null
    }

    /** A run started in the sandbox; the returned function ends it. */
    hold(name: string): () => void {
        this.active.set(name, (this.active.get(name) ?? 0) + 1)
        this.touched.set(name, Date.now())
        let released = false
        return () => {
            if (released) return
            released = true
            this.active.set(name, Math.max(0, (this.active.get(name) ?? 1) - 1))
            this.touched.set(name, Date.now())
        }
    }

    activeRuns(name: string): number {
        return this.active.get(name) ?? 0
    }

    private list(fresh = false): Promise<SandboxInfo[]> {
        if (fresh || !this.listing || Date.now() - this.listing.at > LIST_TTL_MS) {
            const value = this.sbx.ls()
            this.listing = { at: Date.now(), value }
            value.catch(() => {
                if (this.listing?.value === value) this.listing = null
            })
        }
        return this.listing.value
    }

    /**
     * The sandbox of a project (or the factory's), made and set up if it is not there yet; the
     * name for `sbx exec`. Its network rules follow the project file on every call. Rejects with
     * sbx's own words when it cannot be made (no Docker login, no KVM, a checkout that is gone).
     */
    ensure(project: string | null, cwd?: string): Promise<string> {
        const name = sandboxName(project)
        const busy = this.ensuring.get(name)
        if (busy) return busy.then((n) => (cwd ? this.mounted(n, cwd).then(() => n) : n))
        const job = this.prepare(name, project, cwd).finally(() => this.ensuring.delete(name))
        this.ensuring.set(name, job)
        return job
    }

    /** A run's directory must be one the sandbox mounts (a checkout moved since it was made is not). */
    private async mounted(name: string, cwd: string): Promise<void> {
        const found = (await this.list()).find((s) => s.name === name)
        const dirs = (found?.workspaces ?? []).map((w) => w.replace(/:ro$/, ''))
        if (dirs.length && !dirs.some((dir) => under(cwd, dir)))
            throw new Error(
                `${name} does not mount ${cwd} (it was made for ${dirs[0]}): Reset the sandbox in Settings → Sandboxes`
            )
    }

    private async prepare(name: string, project: string | null, cwd?: string): Promise<string> {
        await this.stopping.get(name)
        const workspace = project ? this.refs.projectPath(project) : this.config.paths.workspacesRoot
        if (!workspace) throw new Error(`project "${project}" has no checkout on disk`)
        let found: SandboxInfo | undefined
        try {
            found = (await this.list()).find((s) => s.name === name)
        } catch (error) {
            throw new Error(`Docker Sandboxes: ${message(error)}`, { cause: error })
        }
        if (!found) {
            const mounts = this.mounts(workspace)
            log.info(`creating sandbox ${name} (${mounts.join(', ')})`)
            try {
                await this.sbx.create(name, mounts, {
                    memory: this.config.sandbox.memory || undefined,
                    cpus: this.config.sandbox.cpus || undefined
                })
            } catch (error) {
                throw new Error(`Docker Sandboxes could not create ${name}: ${message(error)}`, { cause: error })
            }
            this.listing = null
            this.store.setMeta(`sandbox.setup.${name}`, null)
            this.store.setMeta(`sandbox.rules.${name}`, {})
            this.swept.add(name)
        } else if (!this.swept.has(name)) {
            // A previous supervisor's runs outlive it inside the VM (killing `sbx exec` does not reach
            // them): they are gone before anything new starts there, as the restart recovery assumes.
            this.swept.add(name)
            // Only the CLIs: a dev server they left behind may be serving an open preview.
            if (found.status === 'running') {
                await this.sbx
                    .exec(name, ['sh', '-c', killByMark('*', 'SIGKILL', true)], { timeoutMs: 30_000 })
                    .catch((error: unknown) => log.warn(`${name}: could not clear old runs: ${message(error)}`))
            }
        }
        if (found) {
            if (cwd) await this.mounted(name, cwd)
            // Started here, not by the run's own `sbx exec`: a sandbox that cannot start (a mount whose
            // host path is gone) fails the task with sbx's words instead of looking like a CLI that died.
            if (found.status !== 'running') {
                try {
                    await this.sbx.exec(name, ['true'], { timeoutMs: 5 * 60_000 })
                } catch (error) {
                    throw new Error(`Docker Sandboxes could not start ${name}: ${message(error)}`, { cause: error })
                }
                this.listing = null
            }
        }
        if (this.store.getMeta<number>(`sandbox.setup.${name}`) !== SETUP_VERSION) {
            try {
                await this.setup(name)
                this.store.setMeta(`sandbox.setup.${name}`, SETUP_VERSION)
            } catch (error) {
                // A task can still run without the wrappers (git push asks the proxy's token): say so, go on.
                log.warn(`${name}: setup failed, retried on the next run: ${message(error)}`)
            }
        }
        await this.syncRules(name, project).catch((error: unknown) =>
            log.warn(`${name}: network rules not applied: ${message(error)}`)
        )
        this.touched.set(name, Date.now())
        return name
    }

    /** Mounted read-write at their own paths, so every path means the same inside and out (spike S3). */
    private mounts(workspace: string): string[] {
        const { dataRoot, configRoot } = this.config.paths
        const inbox = path.join(dataRoot, 'inbox')
        fs.mkdirSync(inbox, { recursive: true })
        fs.mkdirSync(configRoot, { recursive: true })
        const dirs = [workspace, this.config.claude.configDir, configRoot, inbox]
        const ssh = path.join(dataRoot, 'secrets', 'ssh')
        const list = [...new Set(dirs)]
        if (fs.existsSync(ssh)) list.push(`${ssh}:ro`)
        return list
    }

    /**
     * Once per sandbox (and again when SETUP_VERSION moves): the factory's git and gh wrappers in
     * `~/.local/bin` (ahead of `/usr/bin` on the VM's PATH), git's credential helper and identity,
     * the SSH keys and the factory's known_hosts, and a `.credentials.json` in `data/claude` when it
     * has none: the CLI wants the file, the sandbox's proxy swaps its tokens for the real login.
     */
    private async setup(name: string): Promise<void> {
        const { dataRoot, configRoot } = this.config.paths
        const helpers = this.config.sandbox.helpersDir
        await this.sbx.exec(name, ['sh', '-c', 'mkdir -p "$HOME/.local/bin"'])
        for (const helper of HELPERS) {
            const source = helpers ? path.join(helpers, helper) : null
            if (source && fs.existsSync(source)) await this.sbx.cp(source, `${name}:/home/agent/.local/bin/${helper}`)
        }
        const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
        const credentials = path.join(this.config.claude.configDir, '.credentials.json')
        const ssh = path.join(dataRoot, 'secrets', 'ssh')
        const identity = this.config.sandbox.gitIdentity
        // The agents' files name the container's paths (`/data/config/projects/…`): the same names lead to the mounts here.
        const links: Array<[string, string]> = [
            ['claude', this.config.claude.configDir],
            ['config', configRoot],
            ['inbox', path.join(dataRoot, 'inbox')],
            ['secrets', path.join(dataRoot, 'secrets')],
            ['workspaces', this.config.paths.workspacesRoot]
        ]
        const lines = [
            'set -e',
            `chmod +x ${HELPERS.map((h) => `"$HOME/.local/bin/${h}"`).join(' ')} 2>/dev/null || true`,
            `git config --global credential.https://github.com.helper "$HOME/.local/bin/git-credential-owner"`,
            'git config --global credential.https://github.com.useHttpPath true',
            `git config --global --replace-all safe.directory '*'`,
            ...(identity.name ? [`git config --global user.name ${q(identity.name)}`] : []),
            ...(identity.email ? [`git config --global user.email ${q(identity.email)}`] : []),
            `[ -e ${q(credentials)} ] || cp "$HOME/.claude/.credentials.json" ${q(credentials)} 2>/dev/null || true`,
            `[ -d ${q(ssh)} ] && [ ! -e "$HOME/.ssh" ] && ln -s ${q(ssh)} "$HOME/.ssh" || true`,
            `printf 'Host *\\n    UserKnownHostsFile %s\\n' ${q(path.join(configRoot, 'known_hosts'))} | sudo tee /etc/ssh/ssh_config.d/pocket-factory.conf >/dev/null || true`,
            'sudo mkdir -p /data',
            ...links
                .filter(([name, target]) => target !== `/data/${name}`)
                .map(([name, target]) => `sudo ln -sfn ${q(target)} /data/${name}`)
        ]
        await this.sbx.exec(name, ['sh', '-c', lines.join('\n')])
        log.info(`${name}: set up`)
    }

    /**
     * The sandbox's own allow rules: the supervisor's address (the gateway, the factory's MCP) and
     * what its project needs. Rules the factory added are remembered by id in `meta`
     * (`sandbox.rules.<name>`), so a host dropped from the project file loses its rule and the
     * owner's own `sbx policy` rules are never touched.
     */
    syncRules(name: string, project: string | null): Promise<void> {
        if (!this.enabled) return Promise.resolve()
        const job = (this.ruling.get(name) ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.applyRules(name, project))
        this.ruling.set(name, job)
        void job
            .finally(() => {
                if (this.ruling.get(name) === job) this.ruling.delete(name)
            })
            .catch(() => undefined)
        return job
    }

    private async applyRules(name: string, project: string | null): Promise<void> {
        // The host itself, as the VM names it, is `localhost` to the policy (spike S7): an SSH host `user@host.docker.internal`.
        const wanted = new Set(
            [...this.factoryResources(), ...this.refs.network(project)].map((r) =>
                r.replace(/^host\.docker\.internal(?=:|$)/, 'localhost')
            )
        )
        const known = this.store.getMeta<Record<string, string>>(`sandbox.rules.${name}`) ?? {}
        const next: Record<string, string> = {}
        for (const [resource, id] of Object.entries(known)) {
            if (wanted.has(resource)) next[resource] = id
            else await this.sbx.policyRemove(name, id).catch((error: unknown) => log.warn(`${name}: ${message(error)}`))
        }
        for (const resource of wanted) {
            if (next[resource]) continue
            const id = await this.sbx.policyAllow(name, resource)
            if (id) next[resource] = id
            else log.warn(`${name}: sbx gave no id for the rule on ${resource}; it is not tracked`)
            log.info(`${name}: allowed ${resource}`)
        }
        this.store.setMeta(`sandbox.rules.${name}`, next)
    }

    /** The supervisor as the VM reaches it: `host.docker.internal:<port>` goes to the host's loopback, which the policy calls `localhost` (spike S7). */
    private factoryResources(): string[] {
        try {
            const url = new URL(this.config.sandbox.factoryUrl)
            const port = url.port || (url.protocol === 'https:' ? '443' : '80')
            const host = url.hostname === 'host.docker.internal' ? 'localhost' : url.hostname
            return [`${host}:${port}`]
        } catch {
            return []
        }
    }

    /** Re-apply every known sandbox's rules (a project file or a routine changed). */
    async syncAll(): Promise<void> {
        if (!this.enabled) return
        const names = new Set((await this.list(true)).map((s) => s.name))
        for (const project of [null, ...this.refs.projects()]) {
            const name = sandboxName(project)
            if (names.has(name))
                await this.syncRules(name, project).catch((error: unknown) => log.warn(`${name}: ${message(error)}`))
        }
    }

    /** Stop a sandbox now (the owner's Stop); its state stays. */
    async stopSandbox(name: string): Promise<void> {
        if (!name.startsWith(SANDBOX_PREFIX)) throw new Error(`${name} is not one of the factory's sandboxes`)
        if (this.activeRuns(name)) throw new Error(`${name} is running a task; stop the task first`)
        await this.sbx.stop(name)
        this.listing = null
        await this.refresh()
    }

    /**
     * Remove a project's sandbox with everything installed in it; the next task makes a new one.
     * The checkout and `data/` are not touched (they are mounts). The caller unpublishes previews.
     */
    async reset(name: string): Promise<void> {
        if (!name.startsWith(SANDBOX_PREFIX)) throw new Error(`${name} is not one of the factory's sandboxes`)
        if (this.activeRuns(name) || this.ensuring.has(name))
            throw new Error(`${name} is running a task; stop the task first`)
        await this.sbx.rm(name)
        this.store.setMeta(`sandbox.rules.${name}`, {})
        this.store.setMeta(`sandbox.setup.${name}`, null)
        this.swept.delete(name)
        this.listing = null
        log.info(`${name}: removed by the owner`)
        await this.refresh()
    }

    /** Stop the factory's sandboxes nobody used for `SANDBOX_IDLE_MIN`; a stopped one starts again in ~2 s. */
    async idleStop(): Promise<void> {
        const idleMs = this.config.sandbox.idleMs
        if (!this.enabled || idleMs <= 0) return
        let sandboxes: SandboxInfo[]
        try {
            sandboxes = await this.list(true)
        } catch {
            return
        }
        for (const s of sandboxes) {
            if (!s.name.startsWith(SANDBOX_PREFIX) || s.status !== 'running') continue
            if (this.activeRuns(s.name) || this.ensuring.has(s.name) || this.refs.pinned(s.name)) continue
            const last = Math.max(this.touched.get(s.name) ?? 0, s.last_used_at ? Date.parse(s.last_used_at) || 0 : 0)
            if (Date.now() - last < idleMs) continue
            const stop = this.sbx.stop(s.name).then(
                () => log.info(`${s.name}: stopped after ${Math.round(idleMs / 60_000)} min idle`),
                (error: unknown) => log.warn(`${s.name}: idle stop failed: ${message(error)}`)
            )
            this.stopping.set(s.name, stop)
            await stop
            this.stopping.delete(s.name)
            this.listing = null
        }
        this.listing = null
    }

    // ---- approvals --------------------------------------------------------

    /** Requests the policy held back; looked at only while a run goes on (no event stream is known). */
    async pollApprovals(force = false): Promise<void> {
        if (!this.enabled || this.approvalsBusy) return
        const running = [...this.active.values()].some((n) => n > 0)
        if (!running && !force) return
        this.approvalsBusy = true
        try {
            const list = (await this.sbx.approvals()).filter((a) => a.sandbox.startsWith(SANDBOX_PREFIX))
            const ids = new Set(list.map((a) => a.id))
            for (const id of this.pending.keys()) if (!ids.has(id)) this.pending.delete(id)
            for (const approval of list) {
                if (this.pending.has(approval.id)) continue
                const pending: PendingApproval = {
                    ...approval,
                    project: this.projectOf(approval.sandbox),
                    seen_at: new Date().toISOString()
                }
                this.pending.set(approval.id, pending)
                log.info(`${approval.sandbox}: blocked ${approval.resource}`)
                this.emit('approval', pending)
            }
        } catch (error) {
            log.debug(`approvals: ${message(error)}`)
        } finally {
            this.approvalsBusy = false
        }
    }

    approvals(): PendingApproval[] {
        return [...this.pending.values()]
    }

    approval(id: string): PendingApproval | undefined {
        return this.pending.get(id)
    }

    /**
     * The owner allows a blocked host: for a project it goes into the project file's `network:` and
     * becomes the sandbox's rule; the factory's own sandbox gets sbx's own allow. Deny dismisses it.
     */
    async decide(id: string, allow: boolean): Promise<PendingApproval> {
        const approval = this.pending.get(id)
        if (!approval) throw new Error('this request is no longer pending')
        if (allow && approval.project) {
            this.refs.allowNetwork(approval.project, approval.resource)
            await this.syncRules(approval.sandbox, approval.project)
            await this.sbx.respond(id, 'dismiss').catch(() => undefined)
        } else {
            await this.sbx.respond(id, allow ? 'allow' : 'dismiss')
        }
        this.pending.delete(id)
        log.info(`${approval.sandbox}: ${approval.resource} ${allow ? 'allowed' : 'denied'} by the owner`)
        return approval
    }

    // ---- status -------------------------------------------------------------

    /**
     * What Settings and `/api/status` show: the answer on hand at once, a fresh one in the
     * background when it is older than a minute, so a dead daemon never stalls a poll.
     */
    status(): SandboxStatus {
        if (this.enabled) {
            const at = this.snapshot.checked_at ? Date.parse(this.snapshot.checked_at) : 0
            if (Date.now() - at > STATUS_TTL_MS) void this.refresh()
        }
        return { ...this.snapshot, sandboxes: this.views(this.snapshot.sandboxes), approvals: this.approvals() }
    }

    private views(list: SandboxView[]): SandboxView[] {
        return list.map((s) => ({ ...s, active: this.activeRuns(s.name), pinned: this.refs.pinned(s.name) }))
    }

    refresh(): Promise<void> {
        if (!this.enabled) return Promise.resolve()
        this.refreshing ??= this.check().finally(() => {
            this.refreshing = null
        })
        return this.refreshing
    }

    private async check(): Promise<void> {
        const next: SandboxStatus = { ...this.snapshot, checked_at: new Date().toISOString() }
        try {
            const [version, sandboxes] = await Promise.all([this.sbx.version(), this.list(true)])
            next.ok = true
            next.error = null
            next.version = version
            next.sandboxes = sandboxes
                .filter((s) => s.name.startsWith(SANDBOX_PREFIX))
                .map((s) => ({
                    name: s.name,
                    project: this.projectOf(s.name),
                    status: s.status,
                    workspaces: s.workspaces,
                    active: 0,
                    last_used_at: s.last_used_at,
                    created_at: s.created_at,
                    pinned: false
                }))
        } catch (error) {
            next.ok = false
            next.error = message(error)
        }
        const [login, checks] = await Promise.all([
            this.sbx.claudeLogin().catch(() => null),
            this.sbx.diagnose().catch((): DiagnoseCheck[] => [])
        ])
        next.claude_login = login
        const auth = checks.find((c) => c.name === 'Authentication')
        next.docker_login = auth ? auth.status === 'pass' : null
        this.snapshot = next
    }
}
