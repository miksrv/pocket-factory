import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { McpLogins, type McpLoginView } from '../claude/mcpLogin.js'
import { DEFAULT_MODEL, isModelAlias, MODEL_ALIASES, MODEL_META_KEY, type ModelAlias } from '../claude/models.js'
import {
    type AskResponse,
    type McpServerStatus,
    type RateLimits,
    runClaude,
    type RunHandle,
    type RunResult,
    RunTimeout
} from '../claude/runner.js'
import type { Config } from '../config.js'
import { type Attachment, attachmentNote, Inbox } from '../files/inbox.js'
import {
    type ChangedFile,
    createPullRequest,
    filePatch,
    findPullRequest,
    listFiles,
    measure,
    type PullRequest,
    snapshotSync,
    type TaskGit
} from '../git/changes.js'
import { createLogger } from '../logger.js'
import type {
    Ask,
    AskQuestion,
    Channel,
    Conversation,
    RateLimitSnapshot,
    Store,
    Task,
    TaskEvent,
    TaskSource
} from '../store/index.js'
import { type DockerContainer, DockerSidecar } from '../toolchains/docker.js'

const log = createLogger('tasks')

/**
 * What the session manager needs to know about projects and transcripts;
 * provided by the catalog and the transcript index so that this module
 * stays free of file-format details.
 */
export interface Workspace {
    /** Checkout directory of a project slug, or null when the project or its directory does not exist. */
    projectPath: (slug: string) => string | null
    /** MCP servers a project's checkout declares (`.mcp.json` names) and the ones its project file allows (`mcp:`), if restricted. */
    projectMcp: (slug: string) => { declared: string[]; allowed: string[] | null }
    /** Names of the servers agent files declare inline in `mcpServers:` (role-owned servers, started for that sub-agent only). */
    agentMcp: () => string[]
    /** Claude Code's directory slug of the cwd a session was recorded under, or null when the transcript is unknown. */
    sessionWorkspace: (sessionId: string) => string | null
}

/** Claude Code names a session's directory after its cwd with every non-alphanumeric character as "-". */
export const claudeSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export interface TaskServiceEvents {
    /** A task row changed (queued → running → done / failed / cancelled, or its `ask` was set, advanced or cleared). */
    task: [task: Task]
    /** Streamed output for a running task. */
    event: [event: TaskEvent]
    /** The CLI reported the subscription's rate-limit status (during a task or a probe). */
    limits: [snapshot: RateLimitSnapshot]
}

const fmtTokens = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One Haiku turn should not take longer than this; a hung probe would block `/usage refresh` for good. */
const PROBE_TIMEOUT_MS = 5 * 60_000

/**
 * How many supervisor restarts a task survives: it goes back to the queue and
 * resumes its session that many times, then fails. One is enough for a deploy
 * or a reboot; a task that keeps taking the supervisor down must not loop.
 */
const MAX_RESTARTS = 1

/** How many times one task may go back to the queue to wait for a window reset before it fails for good. */
const MAX_LIMIT_WAITS = 3

/** A minute past the reset, so the first call after it does not land on the old window. */
const RESET_MARGIN_MS = 60_000

/** Uploads older than this are removed at start. */
const INBOX_KEEP_DAYS = 30

/** How often the worker looks for queued tasks whose wait for a window reset is over. */
const WAKE_INTERVAL_MS = 30_000
/**
 * A running task's turns, tokens and wall-clock are written to its row this
 * often (the first model call at once), so the task page and the list show a
 * long run moving instead of 0 turns and 0s until the result lands.
 */
const PROGRESS_EVERY_MS = 5_000

/**
 * When a failed run was refused for the subscription limit, the time the
 * window resets; null for any other failure. The CLI's `rate_limit_event`
 * says `rejected` and names the reset; older wordings put it in the result
 * text ("Claude AI usage limit reached|<epoch>"), newer ones only say it in
 * words, so the exhausted window's own reset is the last resort.
 */
export function limitReset(result: { isError: boolean; text: string; rateLimits: RateLimits | null }): Date | null {
    if (!result.isError) return null
    const limits = result.rateLimits
    const rejected = limits?.status === 'rejected'
    // The CLI's own wordings only: a generic "rate limit reached" (an API 429) is not the subscription.
    const said = /usage limit|hit your (?:usage |session |weekly )?limit|out of (?:extra )?usage/i.test(result.text)
    if (!rejected && !said) return null
    const candidates: Array<string | null | undefined> = []
    // The event's reset is about the window it names, which matters only when that window refused.
    if (rejected && limits?.resets_at) candidates.push(limits.resets_at)
    const epoch = /\|(\d{10})\b/.exec(result.text)
    if (epoch) candidates.push(new Date(Number(epoch[1]) * 1000).toISOString())
    const named = !rejected
        ? null
        : limits?.window?.startsWith('seven_day')
          ? limits.seven_day
          : limits?.window === 'five_hour'
            ? limits.five_hour
            : null
    if (named) candidates.push(named.resets_at)
    for (const w of [limits?.five_hour, limits?.seven_day]) if (w && w.used >= 0.99) candidates.push(w.resets_at)
    const at = candidates
        .map((c) => (c ? new Date(c) : null))
        .find((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    return at ?? null
}

/** The questions of an `AskUserQuestion` call, as far as the input is well-formed. */
export function askQuestions(ask: Ask): AskQuestion[] {
    const questions = ask.kind === 'question' ? ask.input.questions : undefined
    return Array.isArray(questions)
        ? questions.filter((q): q is AskQuestion => Boolean(q) && typeof (q as AskQuestion).question === 'string')
        : []
}

/** Questions the owner has not answered yet, in order. */
export const openQuestions = (ask: Ask): AskQuestion[] => askQuestions(ask).filter((q) => !(q.question in ask.answers))

/**
 * How the owner answers an `Ask`: for a question, answers by question text
 * (any subset; the rest stay open); for a permission, allow or deny.
 */
export type Answer =
    { answers: Record<string, string> } | { behavior: 'allow' } | { behavior: 'deny'; message?: string }

/**
 * Variables the CLI (and so every Bash call of the agent) must not see: they
 * belong to the supervisor, not to the work. Compose hands the whole .env to
 * the container; a prompt injection that reads `env` would otherwise walk
 * away with the bot token and the UI password. GitHub tokens and MCP
 * secrets (`${VAR}` in mcp.json) stay, the agent needs them.
 */
const PRIVATE_ENV = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ALLOWED_USER_IDS',
    'WEB_AUTH_USER',
    'WEB_AUTH_PASSWORD',
    'GROQ_API_KEY'
]

/**
 * The warning appended to a reply that did not see the end of its sub-agents' work: some were
 * still running when the result came (`claude -p` has no "later"), or the CLI stopped some
 * after the orchestrator's last turn, so nobody saw that they did not finish. Empty when neither.
 */
export function cutOffNote(result: Pick<RunResult, 'openAgentsAtResult' | 'stoppedAgentsAtResult'>): string {
    const open = result.openAgentsAtResult
    const stopped = result.stoppedAgentsAtResult
    if (open > 0)
        return `⚠️ The reply came while ${open === 1 ? 'a sub-agent was' : `${open} sub-agents were`} still working: whatever they did after it reached nobody. Say "continue" to pick it up.`
    if (stopped > 0)
        return `⚠️ ${stopped === 1 ? 'A sub-agent' : `${stopped} sub-agents`} stopped before finishing, after this reply was written: the work is incomplete. Say "continue" to pick it up.`
    return ''
}

/**
 * Which workspace a tool call touches: the first workspace directory name
 * that appears as a path segment in the call's input (file paths, `cd x`,
 * `x/src/...`). Names shorter than three characters are too ambiguous.
 */
/** A server in the registry, as stored in `meta`. */
interface StoredMcp {
    name: string
    status: string
    /** `connector` (claude.ai account), `plugin`, `project:<slug>`, `factory` (data/config/mcp.json) or the CLI's own word. */
    source: string | null
    seen_at: string | null
    /** The URL (or command) as `claude mcp list` printed it; the same URL under two names is one server. */
    target?: string | null
}

/** What a session start or `claude mcp list` says about a server. */
type RegistryUpdate = McpServerStatus & { target?: string | null }

export interface McpEntry {
    /** The key in tool names: `mcp__<key>__<tool>`. */
    key: string
    name: string
    label: string
    source: string | null
    /** `connected`, `needs-auth`, `failed`, `unknown`. */
    status: string
    seen_at: string | null
    target: string | null
    tools: string[]
}

/** "claude.ai Gmail" → `claude_ai_Gmail`, the way the CLI prefixes the server's tools. */
export const mcpKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

/** "claude.ai Gmail" → "claude.ai Gmail", "plugin:trac:trac" → "plugin trac"; other servers keep their name. */
export function mcpLabel(name: string): string {
    const plugin = /^plugin:(.+?):\1$/.exec(name)
    return plugin ? `plugin ${plugin[1]}` : name
}

function sourceOf(name: string, cliSource: string | null, scope: string | null): string | null {
    if (name.startsWith('claude.ai ')) return 'connector'
    if (name.startsWith('plugin:')) return 'plugin'
    if (cliSource === 'project' && scope && scope !== '.') return `project:${scope}`
    if (cliSource === 'mcp-config' || cliSource === 'mcpConfig') return 'factory'
    return cliSource
}

/**
 * The workspace a tool call touches, by name in its input (a path, a `--repo
 * owner/name`). Longest names first; `owner/name` where both are workspaces
 * means the repository, not the owner's folder (`ServicePattern/UserManagement`
 * is UserManagement); a name with a project file wins over a bare folder.
 */
export function detectProject(
    input: unknown,
    workspaces: string[],
    hasProject: (name: string) => boolean = () => false
): string | null {
    const haystack = JSON.stringify(input ?? '')
    const found: string[] = []
    for (const name of workspaces) {
        if (name.length < 3) continue
        const m = new RegExp(`(?:^|[\\s"'/=:(])${escapeRegExp(name)}(?=[\\s"'/):]|$)`).exec(haystack)
        if (!m) continue
        const after = haystack.slice(m.index + m[0].length)
        const repo = workspaces.find(
            (other) =>
                other !== name &&
                other.length >= 3 &&
                new RegExp(`^/${escapeRegExp(other)}(?=[\\s"'/):]|$)`).test(after)
        )
        found.push(repo ?? name)
    }
    if (!found.length) return null
    return found.find(hasProject) ?? found[0]
}

/**
 * The session manager: one queue for every channel, spawn-on-demand
 * `claude -p` per task, at most one running task per conversation and
 * MAX_CONCURRENT_SESSIONS overall. Session continuity is Claude Code's own
 * transcript — we only remember the session id on the conversation.
 */
export class TaskService extends EventEmitter<TaskServiceEvents> {
    /** The factory's Docker daemon (the dind sidecar, when the compose profile is on): a task's containers are stopped at its end. */
    docker = new DockerSidecar()
    private readonly running = new Map<string, RunHandle>()
    /** Tasks the owner asked to stop: whatever way the CLI exits, they end as `cancelled`. */
    private readonly stopRequested = new Set<string>()
    /** Tasks found `running` at startup and failed by the store (restart limit reached); announced once a listener can deliver. */
    private readonly orphaned: Task[]
    private ticking = false
    private stopped = false
    /** The subscription refused a run: nothing new starts before this (each would be refused in turn). */
    private pausedUntil = 0
    /** When old uploads were last pruned; a factory that runs for months must not keep them forever. */
    private prunedAt = Date.now()
    private probe: Promise<RateLimitSnapshot | null> | null = null
    private workspaceCache: { names: string[]; at: number } = { names: [], at: 0 }
    /** The owner's uploads (photos, screenshots, files sent with a message), under data/inbox. */
    readonly inbox: Inbox
    private readonly wake: NodeJS.Timeout
    /** Sign-ins to MCP servers started from the web UI; a completed one marks its server connected. */
    private readonly logins = new McpLogins((name) =>
        this.rememberRegistry([{ name, status: 'connected', source: null }], null)
    )

    constructor(
        private readonly store: Store,
        private readonly config: Config,
        private readonly workspace: Workspace
    ) {
        super()
        this.inbox = new Inbox(path.join(config.paths.dataRoot, 'inbox'))
        try {
            this.inbox.prune(INBOX_KEEP_DAYS)
            this.inbox.sweep((id) => {
                const conversation = store.getConversation(id)
                return Boolean(conversation && !conversation.deleted_at)
            })
        } catch (error) {
            log.warn(`inbox prune failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        // Tasks waiting for a window reset become due on their own: look again now and then.
        this.wake = setInterval(() => this.tick(), WAKE_INTERVAL_MS)
        this.wake.unref()
        // Tasks that were running when the previous supervisor stopped: their
        // CLI is gone, but the conversation remembers the session, so the run
        // continues where the transcript ends (the prompt is sent once more
        // to the resumed session). Tasks over the restart limit fail instead.
        const { requeued, failed } = store.recoverOrphanedTasks(MAX_RESTARTS)
        for (const task of requeued) {
            store.addEvent(task.id, 'status', {
                status: 'queued',
                note: 'supervisor restarted while the task was running; resuming the session'
            })
        }
        for (const task of failed) {
            store.addEvent(task.id, 'error', { status: 'failed', error: task.error ?? undefined })
        }
        this.orphaned = failed
        if (requeued.length > 0)
            log.warn(`${requeued.length} task(s) were running when the supervisor stopped; re-queued`)
        if (failed.length > 0) log.warn(`${failed.length} task(s) hit the restart limit; marked failed`)
        // Tasks queued before a restart are still queued; pick them up.
        queueMicrotask(() => this.tick())
    }

    /**
     * Tell the channels about tasks lost to the restart. Called once the bot
     * and the web server listen, since the store marked them before that.
     */
    announceOrphans(): void {
        for (const task of this.orphaned.splice(0)) this.emit('task', task)
    }

    // ---- conversations ----------------------------------------------------

    conversationFor(channel: Channel, externalId: string): Conversation {
        return this.store.findConversation(channel, externalId) ?? this.store.createConversation(channel, externalId)
    }

    newConversation(
        channel: Channel,
        externalId: string | null,
        title: string | null = null,
        project: string | null = null
    ): Conversation {
        return this.store.createConversation(channel, externalId, title, project)
    }

    /**
     * Bind a conversation to a project (or unbind with null). The next task
     * runs from that project's checkout, so its .mcp.json, agents, skills
     * and CLAUDE.md apply; the Claude Code session cannot follow a cwd
     * change, so the conversation forgets its session id.
     */
    setProject(conversationId: string, project: string | null): Conversation {
        const conversation = this.store.getConversation(conversationId)
        if (!conversation) throw new Error(`Unknown conversation ${conversationId}`)
        if (project && !this.workspace.projectPath(project))
            throw new Error(`Unknown project "${project}" or its checkout is missing`)
        if (this.activeTask(conversationId))
            throw new Error('a task is running in this conversation; wait for it to finish')
        if (conversation.project !== project)
            this.store.updateConversation(conversationId, { project, session_id: null })
        return this.store.getConversation(conversationId)!
    }

    /**
     * Remove a conversation from the Chat list and its files from the disk
     * (uploads, anything kept for it under data/inbox). Its tasks and audit
     * events stay; their attachment previews then say the file was removed.
     */
    deleteConversation(conversationId: string): void {
        if (this.activeTask(conversationId) || this.queuedTask(conversationId))
            throw new Error('a task of this conversation is still queued or running; stop it first')
        this.store.deleteConversation(conversationId)
        this.inbox.remove(conversationId)
    }

    // ---- what a task changed (the task page's Changes panel) ---------------

    /** The task's recorded range and its checkout, or an error the panel shows as is. */
    private changed(taskId: string): {
        task: Task
        git: Required<Pick<TaskGit, 'base' | 'head'>> & TaskGit
        cwd: string
    } {
        const task = this.store.getTask(taskId)
        if (!task) throw new Error('task not found')
        const git = task.git
        if (!git?.base || !git.head)
            throw new Error(
                task.status === 'queued' || task.status === 'running'
                    ? 'the task has not finished yet'
                    : 'no changes were recorded for this task (it ran outside a project, or before 1.1.0)'
            )
        const cwd = task.project ? this.workspace.projectPath(task.project) : null
        if (!cwd) throw new Error(`the checkout of project "${task.project}" is not on disk any more`)
        return { task, git: git as Required<Pick<TaskGit, 'base' | 'head'>> & TaskGit, cwd }
    }

    /** The files of the task's range, read from the checkout now, and the branch's pull request as GitHub has it now. */
    async changes(taskId: string): Promise<{ git: TaskGit; files: ChangedFile[]; pr: PullRequest | null }> {
        const { task, git, cwd } = this.changed(taskId)
        let files: ChangedFile[]
        try {
            files = await listFiles(cwd, git.base, git.head)
        } catch {
            throw new Error(
                'the commits of this task are gone from the checkout (rebased, squashed or pruned); see the pull request on GitHub'
            )
        }
        const pr =
            git.branch && git.branch !== git.default_branch
                ? await findPullRequest(cwd, git.branch, this.agentEnv())
                : null
        if (pr && (pr.url !== git.pr?.url || pr.state !== git.pr?.state || pr.isDraft !== git.pr?.isDraft))
            this.store.updateTask(task.id, { git: { ...git, pr } })
        return { git: { ...git, pr }, files, pr }
    }

    async changePatch(taskId: string, file: string): Promise<{ patch: string; truncated: boolean }> {
        const { git, cwd } = this.changed(taskId)
        const found = (await listFiles(cwd, git.base, git.head)).find((f) => f.path === file)
        if (!found) throw new Error(`"${file}" is not among the task's changes`)
        return filePatch(cwd, git.base, git.head, found)
    }

    /** Push the task's branch and open its pull request (or return the open one). */
    async createPr(taskId: string): Promise<PullRequest> {
        const { task, git, cwd } = this.changed(taskId)
        if (!git.branch) throw new Error('the task did not end on a branch')
        if (!git.default_branch)
            throw new Error('the repository has no default branch to open the pull request against')
        if (git.branch === git.default_branch)
            throw new Error(`the changes are on ${git.branch} itself; a pull request needs a branch of its own`)
        const pr = await createPullRequest(cwd, git.branch, git.default_branch, this.agentEnv())
        // No 'task' event: the task finished long ago, and listeners treat one as news (the bot would deliver its report again).
        this.store.updateTask(task.id, { git: { ...git, pr } })
        log.info(`${task.id}: pull request ${pr.url}`)
        return pr
    }

    /** A project file exists and its checkout is on disk. */
    hasProject(slug: string): boolean {
        return this.workspace.projectPath(slug) !== null
    }

    /**
     * Where a conversation's tasks run: the project's checkout, else the workspaces root.
     * A bound conversation whose checkout is gone (renamed, moved, the project file
     * deleted) is an error, never a silent fallback to the root under the project's name.
     */
    cwdFor(conversation: Conversation): string {
        if (!conversation.project) return this.config.paths.workspacesRoot
        const checkout = this.workspace.projectPath(conversation.project)
        if (!checkout) {
            throw new Error(
                `project "${conversation.project}" has no checkout or project file any more; start a conversation elsewhere (/new [project] in Telegram, the project selector in Chat)`
            )
        }
        return checkout
    }

    /** MCP servers of the last session per project (or the root), as the CLI reported them. */
    mcpStatus(): Record<string, McpServerStatus[]> {
        return this.store.getMeta<Record<string, McpServerStatus[]>>('claude.mcp') ?? {}
    }

    /**
     * Every MCP server the factory has seen, by the key its tools carry
     * (`mcp__<key>__<tool>`): the claude.ai connectors, synced plugins, project
     * `.mcp.json` servers and the owner's own — with the status the CLI last
     * reported (session starts, or `claude mcp list` on demand) and its tools.
     */
    mcpRegistry(): McpEntry[] {
        const known = this.store.getMeta<Record<string, StoredMcp>>('claude.mcp.registry') ?? {}
        // Sessions before the registry existed left their statuses per scope in `claude.mcp`: a project's
        // servers seen back then stay known until a new session of that project reports them again.
        for (const [scope, servers] of Object.entries(this.mcpStatus())) {
            for (const server of servers) {
                const key = mcpKey(server.name)
                if (!known[key])
                    known[key] = {
                        name: server.name,
                        status: server.status,
                        source: sourceOf(server.name, server.source, scope),
                        seen_at: null
                    }
            }
        }
        const tools = new Map<string, string[]>()
        for (const tool of this.tools()) {
            const match = /^mcp__(.+?)__(.+)$/.exec(tool)
            if (match) tools.set(match[1], [...(tools.get(match[1]) ?? []), tool])
        }
        const keys = new Set([...Object.keys(known), ...tools.keys()])
        return [...keys]
            .map((key) => {
                const stored = known[key]
                const name = stored?.name ?? key
                return {
                    key,
                    name,
                    label: mcpLabel(name),
                    source: stored?.source ?? sourceOf(name, null, null),
                    status: stored?.status ?? (tools.has(key) ? 'connected' : 'unknown'),
                    seen_at: stored?.seen_at ?? null,
                    target: stored?.target ?? null,
                    tools: tools.get(key) ?? []
                }
            })
            .sort((a, b) => a.label.localeCompare(b.label))
    }

    /** `claude mcp list` from the workspaces root: the authoritative status of every server the CLI can see, needs-auth ones included. */
    async refreshMcp(): Promise<McpEntry[]> {
        const output = await new Promise<string>((resolve, reject) => {
            execFile(
                'claude',
                ['mcp', 'list'],
                { cwd: this.config.paths.workspacesRoot, env: this.agentEnv(), timeout: 90_000, maxBuffer: 1 << 20 },
                (error, stdout, stderr) => {
                    if (error && !stdout) reject(new Error(`claude mcp list: ${stderr.trim() || error.message}`))
                    else resolve(stdout)
                }
            )
        })
        const names = new Set(this.mcpRegistry().map((e) => e.name))
        const seen: RegistryUpdate[] = []
        for (const line of output.split('\n')) {
            const dash = line.lastIndexOf(' - ')
            if (dash < 0) continue
            const left = line.slice(0, dash).trim()
            const verdict = line.slice(dash + 3).trim()
            // "<name>: <target>" — a known name first (plugin names contain colons), else up to the first ": ".
            const name = [...names].find((n) => left.startsWith(`${n}: `)) ?? left.split(': ')[0]
            if (!name) continue
            // The URL or command, without the CLI's "(HTTP)" / "(SSE)" / "(stdio)" suffix.
            const target =
                left
                    .slice(name.length + 2)
                    .replace(/\s*\((?:HTTP|SSE|stdio)\)\s*$/i, '')
                    .trim() || null
            const status = /connected/i.test(verdict)
                ? 'connected'
                : /needs auth/i.test(verdict)
                  ? 'needs-auth'
                  : 'failed'
            seen.push({ name, status, source: null, target })
        }
        if (seen.length) this.rememberRegistry(seen, null)
        return this.mcpRegistry()
    }

    // ---- MCP sign-in from the UI ------------------------------------------

    /**
     * `claude mcp login <name> --no-browser` for a server of the registry, run
     * from the project's checkout when the server is the project's (the CLI
     * finds `.mcp.json` servers by cwd), else from the workspaces root.
     */
    startMcpLogin(name: string): Promise<McpLoginView> {
        const entry = this.mcpRegistry().find((e) => e.name === name || e.key === name)
        const slug = entry?.source?.startsWith('project:') ? entry.source.slice(8) : null
        const cwd = (slug && this.workspace.projectPath(slug)) || this.config.paths.workspacesRoot
        return this.logins.start(entry?.name ?? name, { cwd, env: this.agentEnv() })
    }

    mcpLogin(id: string): McpLoginView | undefined {
        return this.logins.get(id)
    }

    completeMcpLogin(id: string, url: string): Promise<McpLoginView> {
        return this.logins.complete(id, url)
    }

    cancelMcpLogin(id: string): void {
        this.logins.cancel(id)
    }

    private rememberRegistry(servers: RegistryUpdate[], scope: string | null): void {
        const known = this.store.getMeta<Record<string, StoredMcp>>('claude.mcp.registry') ?? {}
        const now = new Date().toISOString()
        let changed = false
        for (const server of servers) {
            const key = mcpKey(server.name)
            const source = sourceOf(server.name, server.source, scope) ?? known[key]?.source ?? null
            // Session starts do not carry the target: keep the one `claude mcp list` gave.
            const target = server.target ?? known[key]?.target ?? null
            const next: StoredMcp = { name: server.name, status: server.status, source, seen_at: now, target }
            if (
                known[key]?.status !== next.status ||
                known[key]?.source !== next.source ||
                known[key]?.name !== next.name ||
                known[key]?.target !== target
            )
                changed = true
            known[key] = next
        }
        if (changed || servers.length) this.store.setMeta('claude.mcp.registry', known)
    }

    conversationOf(task: Task): Conversation | undefined {
        return this.store.getConversation(task.conversation_id)
    }

    task(id: string): Task | undefined {
        return this.store.getTask(id)
    }

    /** The owner has seen the conversation's replies (web UI, or delivered to Telegram): clears `unread`. */
    markRead(conversationId: string): void {
        this.store.markConversationRead(conversationId)
    }

    // ---- queue ------------------------------------------------------------

    /**
     * A message for the conversation. While its running task waits for the
     * owner's answer to a question, the message *is* the answer (free text
     * for the first open question — the "Other" choice) and the task goes
     * on; otherwise a new task queues behind whatever runs.
     */
    /** The orchestrator's model: the alias the owner picked (Telegram `/model`, Settings), else the default. Sub-agents follow their own files. */
    model(): ModelAlias {
        const stored = this.store.getMeta<string>(MODEL_META_KEY)
        return isModelAlias(stored) ? stored : DEFAULT_MODEL
    }

    /** Picks the model for every task queued from now on, in every conversation; a running task keeps the one it started with. */
    setModel(alias: string): ModelAlias {
        if (!isModelAlias(alias)) throw new Error(`Unknown model alias "${alias}": one of ${MODEL_ALIASES.join(', ')}`)
        this.store.setMeta(MODEL_META_KEY, alias)
        log.info(`model: ${alias}`)
        return alias
    }

    submit(
        conversationId: string,
        source: TaskSource,
        prompt: string,
        options: { schedule?: string; model?: string; attachments?: Attachment[] } = {}
    ): Task {
        const conversation = this.store.getConversation(conversationId)
        if (!conversation) throw new Error(`Unknown conversation ${conversationId}`)
        // Files saved for the chat's topic go to the conversation the message lands in (a reply that switched topics).
        const attachments = (options.attachments ?? []).map((a) => this.inbox.adopt(conversationId, a))
        const asking = this.pendingAsk(conversationId)
        if (asking && !options.schedule) {
            const question = openQuestions(asking.ask!)[0]
            // Files sent with an answer reach the agent as paths inside the answer text.
            if (question)
                return this.answer(asking.id, {
                    answers: { [question.question]: prompt + attachmentNote(attachments) }
                })
        }
        // A bound conversation's task runs in that project's checkout, so that is its
        // project; an unbound one gets it detected from the task's own tool calls.
        const task = this.store.createTask(
            conversationId,
            source,
            prompt,
            conversation.project,
            options.schedule ?? null,
            options.model ?? null,
            attachments
        )
        if (!conversation.title) {
            this.store.updateConversation(conversationId, { title: titleFrom(prompt) })
        }
        log.info(
            `queued ${task.id} (${source}): ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}${attachments.length ? ` +${attachments.length} file(s)` : ''}`
        )
        this.emit('task', task)
        queueMicrotask(() => this.tick())
        return task
    }

    /** Returns the running task of a conversation, if any. */
    activeTask(conversationId: string): Task | undefined {
        return this.store.listTasks({ conversationId, status: 'running', limit: 1 })[0]
    }

    /** The task of a conversation that waits for a slot, if any. */
    queuedTask(conversationId: string): Task | undefined {
        return this.store.listTasks({ conversationId, status: 'queued', limit: 1 })[0]
    }

    /** The running task of a conversation whose agent waits for the owner's answer to a *question* (permissions are answered with buttons only). */
    pendingAsk(conversationId: string): Task | undefined {
        const task = this.activeTask(conversationId)
        return task?.ask?.kind === 'question' && this.running.has(task.id) ? task : undefined
    }

    /**
     * The owner's answer to what a running task asked. Answers to some of
     * the questions are kept on the task (Telegram asks one at a time) and
     * the CLI hears back once every question has one; a permission request
     * is settled in one go. Returns the task as it is afterwards.
     */
    answer(taskId: string, answer: Answer): Task {
        const task = this.store.getTask(taskId)
        const handle = this.running.get(taskId)
        if (!task || !handle) throw new Error('the task is not running')
        const ask = task.ask
        if (!ask) throw new Error('the task is not waiting for an answer')

        let response: AskResponse | null
        let answers = ask.answers
        if ('answers' in answer) {
            if (ask.kind !== 'question') throw new Error('this request is a permission prompt: allow or deny it')
            const known = new Set(askQuestions(ask).map((q) => q.question))
            const given = Object.fromEntries(
                Object.entries(answer.answers).filter(([q, a]) => known.has(q) && typeof a === 'string' && a.trim())
            )
            if (!Object.keys(given).length) throw new Error('no answer to any of the questions')
            answers = { ...ask.answers, ...given }
            response = openQuestions({ ...ask, answers }).length
                ? null
                : { behavior: 'allow', updatedInput: { ...ask.input, answers } }
        } else if (answer.behavior === 'allow') {
            response = {
                behavior: 'allow',
                updatedInput: ask.kind === 'question' ? { ...ask.input, answers } : ask.input
            }
        } else {
            response = { behavior: 'deny', message: answer.message?.trim() || 'The owner declined.' }
        }

        if (!response) {
            const updated = this.store.updateTask(taskId, { ask: { ...ask, answers } })
            this.emit('task', updated)
            return updated
        }
        if (!handle.answer(ask.request_id, response)) {
            // The CLI no longer waits (cancelled, or the run ended meanwhile): drop the stale ask.
            const updated = this.store.updateTask(taskId, { ask: null })
            this.emit('task', updated)
            throw new Error('the request is no longer open')
        }
        const updated = this.store.updateTask(taskId, { ask: null })
        this.emit(
            'event',
            this.store.addEvent(
                taskId,
                'answer',
                {
                    kind: ask.kind,
                    request_id: ask.request_id,
                    tool_name: ask.tool_name,
                    behavior: response.behavior,
                    ...(ask.kind === 'question' ? { answers } : {}),
                    ...(response.behavior === 'deny' ? { message: response.message } : {})
                },
                { agent: ask.agent, parent_tool_use_id: null }
            )
        )
        log.info(`${taskId} answered: ${ask.kind} ${ask.tool_name} → ${response.behavior}`)
        this.emit('task', updated)
        return updated
    }

    /**
     * A scheduled run must not hold its schedule (one run at a time) and a
     * session slot for days because nobody answered: after
     * `SCHEDULES_ASK_TIMEOUT_MIN` a permission is denied and a question gets
     * "no answer", and the agent decides by the file's instructions.
     */
    private answerLater(taskId: string, ask: Ask): void {
        const ms = this.config.schedules.askTimeoutMs
        if (ms <= 0) return
        const minutes = Math.round(ms / 60_000)
        const timer = setTimeout(() => {
            const task = this.store.getTask(taskId)
            if (!task || task.status !== 'running' || task.ask?.request_id !== ask.request_id) return
            const reason = `no answer from the owner within ${minutes} min`
            try {
                if (ask.kind === 'permission')
                    this.answer(taskId, {
                        behavior: 'deny',
                        message: `${reason}; the scheduled run goes on without it, or reports what it needed and stops`
                    })
                else {
                    const text = `(${reason}: decide by the schedule's instructions, or report what you needed and stop)`
                    this.answer(taskId, {
                        answers: Object.fromEntries(openQuestions(task.ask).map((q) => [q.question, text]))
                    })
                }
                this.emit(
                    'event',
                    this.store.addEvent(taskId, 'status', {
                        status: 'running',
                        note: `${ask.kind} answered for the owner: ${reason}`
                    })
                )
                log.warn(`${taskId}: ${ask.kind} ${ask.tool_name} answered by the timeout (${minutes} min)`)
            } catch (error) {
                log.warn(
                    `${taskId}: could not settle the ${ask.kind} by the timeout: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }, ms)
        timer.unref()
    }

    /** Whether a task submitted now waits: this conversation is busy or queued, or every session slot is taken. */
    willWait(conversationId: string): boolean {
        if (this.running.size >= this.config.maxConcurrentSessions) return true
        return (
            this.store.listTasks({ conversationId, status: 'running', limit: 1 }).length > 0 ||
            this.store.listTasks({ conversationId, status: 'queued', limit: 1 }).length > 0
        )
    }

    runningTaskIds(): string[] {
        return [...this.running.keys()]
    }

    stop(taskId: string): boolean {
        const handle = this.running.get(taskId)
        if (handle) {
            this.stopRequested.add(taskId)
            handle.kill()
            return true
        }
        const task = this.store.getTask(taskId)
        if (task?.status === 'queued') {
            this.finish(taskId, { status: 'cancelled' })
            return true
        }
        return false
    }

    /**
     * Stop every CLI and wait for it to exit (SIGKILL follows after the
     * runner's grace period). Running tasks are not cancelled: they stay
     * `running` in the store and the next supervisor re-queues them.
     */
    async shutdown(): Promise<void> {
        this.stopped = true
        clearInterval(this.wake)
        this.logins.close()
        for (const handle of this.running.values()) handle.kill()
        await Promise.allSettled([...this.running.values()].map((handle) => handle.result))
    }

    /** Directory names under the workspaces root, refreshed at most once a minute. */
    private workspaces(): string[] {
        if (Date.now() - this.workspaceCache.at > 60_000) {
            let names: string[] = []
            try {
                names = fs
                    .readdirSync(this.config.paths.workspacesRoot, { withFileTypes: true })
                    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                    .map((entry) => entry.name)
                    .sort((a, b) => b.length - a.length) // longest first: "foo-api" before "foo"
            } catch {
                // no workspaces dir yet
            }
            this.workspaceCache = { names, at: Date.now() }
        }
        return this.workspaceCache.names
    }

    // ---- subscription limits ---------------------------------------------

    /** Latest rate-limit reading, from whichever task or probe reported it last. */
    limits(): RateLimitSnapshot | undefined {
        return this.store.latestRateLimits()
    }

    probing(): boolean {
        return this.probe !== null
    }

    /**
     * Ask the CLI for the current rate-limit status without a real task: one
     * cheap Haiku turn whose only purpose is the `rate_limit_event` it yields.
     * Costs a few thousand cached tokens, so it runs only on explicit request.
     */
    probeLimits(): Promise<RateLimitSnapshot | null> {
        if (this.probe) return this.probe
        log.info('probing subscription limits')
        const handle = runClaude({
            prompt: 'Reply with exactly: OK',
            cwd: this.config.paths.workspacesRoot,
            model: 'haiku',
            maxTurns: 1,
            permissionMode: this.config.claude.permissionMode,
            env: this.agentEnv(),
            timeoutMs: PROBE_TIMEOUT_MS,
            mcpConfig: this.mcpConfigFile(),
            onEvent: (event) => {
                if (event.type === 'init') {
                    this.rememberTools(event.tools)
                    this.rememberMcp('.', event.mcpServers)
                }
            }
        })
        this.probe = handle.result
            .then((result) => (result.rateLimits ? this.recordLimits(result.rateLimits, null) : null))
            .catch((error) => {
                log.warn(`limits probe failed: ${error instanceof Error ? error.message : String(error)}`)
                return null
            })
            .finally(() => {
                this.probe = null
            })
        return this.probe
    }

    /** The CLI's environment: the supervisor's own minus its private secrets, plus the config dir. Prefilters run with the same one. */
    /**
     * Stop the containers a task started on the factory's Docker, unless they belong
     * (by their compose directory) to the project of another task still running.
     */
    private async stopContainers(task: Task, before: Set<string>): Promise<void> {
        if (!this.docker.enabled) return
        const others = this.runningTaskIds()
            .filter((id) => id !== task.id)
            .map((id) => this.store.getTask(id)?.project ?? null)
            .map((project) => (project ? this.workspace.projectPath(project) : null))
            .filter((dir): dir is string => Boolean(dir))
        const keep = (c: DockerContainer) =>
            Boolean(c.compose.working_dir && others.some((dir) => c.compose.working_dir!.startsWith(dir)))
        const stopped = await this.docker.stopStartedSince(before, keep)
        if (!stopped.length) return
        log.info(`${task.id}: stopped ${stopped.join(', ')} (started during the task)`)
        this.emit(
            'event',
            this.store.addEvent(task.id, 'status', {
                status: 'running',
                note: `stopped containers: ${stopped.join(', ')}`
            })
        )
    }

    agentEnv(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {
            // In -p the CLI waits for background tasks after the orchestrator's last turn only
            // 10 minutes by default, then kills them and answers with whatever was said last
            // ("Background tasks still running after …; terminating"): a sub-agent resumed with
            // SendMessage always runs in the background. CLAUDE_TASK_TIMEOUT_MIN is the limit here.
            CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
            ...process.env,
            CLAUDE_CONFIG_DIR: this.config.claude.configDir
        }
        for (const name of PRIVATE_ENV) delete env[name]
        return env
    }

    /** Tool names the CLI announced at session start; the agent editor offers them as choices. */
    tools(): string[] {
        return this.store.getMeta<string[]>('claude.tools') ?? []
    }

    private rememberMcp(scope: string, servers: McpServerStatus[]): void {
        this.rememberRegistry(servers, scope)
        const all = this.mcpStatus()
        const known = all[scope] ?? []
        if (
            known.length === servers.length &&
            known.every((s, i) => s.name === servers[i].name && s.status === servers[i].status)
        )
            return
        this.store.setMeta('claude.mcp', { ...all, [scope]: servers })
    }

    /** `--mcp-config` for the factory's own servers, when the owner wrote the file. */
    private mcpConfigFile(): string | undefined {
        const file = path.join(this.config.paths.configRoot, 'mcp.json')
        return fs.existsSync(file) ? file : undefined
    }

    /** Names of the owner's servers in `data/config/mcp.json`. */
    private globalMcpServers(): string[] {
        const file = this.mcpConfigFile()
        if (!file) return []
        try {
            return Object.keys(
                (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}
            )
        } catch {
            return []
        }
    }

    /**
     * Per-session settings layer: `disabledMcpjsonServers` for a project that restricts its
     * checkout's .mcp.json with `mcp:` (an allowlist does not work in -p mode), and a
     * `permissions.allow` rule for every MCP server the session may load — the owner's, the
     * project's and the ones agent files declare for their role. Nobody can answer a
     * permission prompt in -p mode, so without a rule every MCP tool call is denied
     * ("Claude requested permissions … but you haven't granted it yet") whatever the
     * permission mode; loading a server is the owner's consent to its tools.
     */
    private sessionSettings(project: string | null): Record<string, unknown> {
        const settings: Record<string, unknown> = {}
        const servers = new Set([...this.globalMcpServers(), ...this.workspace.agentMcp()])
        if (project) {
            const { declared, allowed } = this.workspace.projectMcp(project)
            const disabled = allowed ? declared.filter((name) => !allowed.includes(name)) : []
            if (disabled.length) settings.disabledMcpjsonServers = disabled
            for (const name of declared) if (!disabled.includes(name)) servers.add(name)
        }
        if (servers.size) settings.permissions = { allow: [...servers].map((name) => `mcp__${name}`) }
        return settings
    }

    private rememberTools(reported: string[]): void {
        const known = this.tools()
        // The init event may come before the claude.ai connectors have connected, listing none of
        // their tools: keep the MCP tools seen earlier rather than forgetting them on such a start.
        const tools = [...reported, ...known.filter((t) => t.startsWith('mcp__') && !reported.includes(t))]
        if (known.length === tools.length && known.every((t, i) => t === tools[i])) return
        this.store.setMeta('claude.tools', tools)
        log.info(`claude tools: ${tools.length} (${tools.slice(0, 6).join(', ')}…)`)
    }

    private recordLimits(limits: RateLimits, taskId: string | null): RateLimitSnapshot {
        const snapshot = this.store.recordRateLimits(limits, taskId)
        this.emit('limits', snapshot)
        return snapshot
    }

    // ---- worker -----------------------------------------------------------

    private tick(): void {
        if (this.ticking || this.stopped) return
        if (Date.now() - this.prunedAt > 86_400_000) {
            this.prunedAt = Date.now()
            try {
                this.inbox.prune(INBOX_KEEP_DAYS)
            } catch (error) {
                log.warn(`inbox prune failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        if (Date.now() < this.pausedUntil) return
        this.ticking = true
        try {
            for (const task of this.store.nextQueuedTasks()) {
                if (this.running.size >= this.config.maxConcurrentSessions) break
                if (
                    [...this.running.keys()].some(
                        (id) => this.store.getTask(id)?.conversation_id === task.conversation_id
                    )
                ) {
                    continue
                }
                void this.run(task)
            }
        } finally {
            this.ticking = false
        }
    }

    private async run(task: Task): Promise<void> {
        const started = this.store.updateTask(task.id, { status: 'running', started_at: new Date().toISOString() })
        this.emit('task', started)
        this.emit('event', this.store.addEvent(task.id, 'status', { status: 'running' }))
        try {
            await this.attempt(task, true)
        } finally {
            this.running.delete(task.id)
            this.stopRequested.delete(task.id)
            queueMicrotask(() => this.tick())
        }
    }

    /**
     * One `claude -p` run for the task. A session that cannot be resumed
     * (transcript gone, cwd slug changed between host and container) fails
     * before the first turn; then the conversation forgets the session id
     * and the task runs once more from scratch, so the owner's message is
     * not lost to a stale pointer.
     */
    private async attempt(task: Task, mayRetry: boolean): Promise<void> {
        const conversation = this.store.getConversation(task.conversation_id)!
        let cwd: string
        try {
            cwd = this.cwdFor(conversation)
        } catch (error) {
            this.finish(task.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
            return
        }
        // Where a project's task starts in its checkout, once (a resume after a restart or a window reset keeps the first).
        if (conversation.project && !this.store.getTask(task.id)?.git) {
            const start = snapshotSync(cwd)
            if (start) this.store.updateTask(task.id, { git: { start_head: start.head, start_branch: start.branch } })
        }
        /** Every way the run ends: what it changed in the checkout is measured first, so the report can say it. */
        // Services the agent starts on the factory's Docker (a project's db for its tests) end with the task.
        const containersBefore = await this.docker.snapshot()
        const end = async (patch: Partial<Task>) => {
            await this.recordChanges(task.id, cwd)
            await this.stopContainers(task, containersBefore)
            this.finish(task.id, patch)
        }

        // A session lives in the directory it started in: resuming it from another
        // cwd fails, so a conversation that moved (its project was detected or set
        // after the first task) starts a fresh session there instead of failing once.
        if (conversation.session_id) {
            const recorded = this.workspace.sessionWorkspace(conversation.session_id)
            if (recorded && recorded !== claudeSlug(cwd)) {
                log.info(
                    `conversation ${conversation.id} moved to ${cwd}; session ${conversation.session_id} stays behind`
                )
                this.store.updateConversation(conversation.id, { session_id: null })
                conversation.session_id = null
                this.emit(
                    'event',
                    this.store.addEvent(task.id, 'status', { status: 'running', note: `fresh session in ${cwd}` })
                )
            }
        }

        // The 5-hour reading before this task's first API call: the previous
        // snapshot if it is recent and from the same window (other Claude Code
        // clients on the account move the window too), else the task's own
        // first one, which misses the first call but nothing foreign.
        const latest = this.store.latestRateLimits()
        const previous = latest && Date.now() - new Date(latest.ts).getTime() < 5 * 60_000 ? latest.five_hour : null
        let first: RateLimits['five_hour'] = null
        // The project is where the task runs now: the conversation's binding, which the
        // owner may have changed in the web while the task sat in the queue.
        let project = conversation.project
        if (project !== task.project) this.store.updateTask(task.id, { project })
        /** Orchestrator prose streamed: the web thread then shows the text events and hides `result`. */
        let sawText = false
        const resuming = Boolean(conversation.session_id)
        let sawOutput = false
        const startedAt = Date.now()
        const spent = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
        /** The orchestrator's model calls so far; the CLI's own count replaces it with the result. */
        let turns = 0
        let progressAt = 0

        const handle = runClaude({
            // The paths of the files sent with the message follow the owner's text; the task row keeps the text alone.
            prompt: task.prompt + attachmentNote(task.attachments ?? []),
            cwd,
            // Uploads live outside every checkout: readable without a prompt, in this task and in later ones of the session.
            addDirs: fs.existsSync(this.inbox.root) ? [this.inbox.root] : [],
            resumeSessionId: conversation.session_id ?? undefined,
            mcpConfig: this.mcpConfigFile(),
            settings: this.sessionSettings(conversation.project),
            // A schedule's own `model:` wins; otherwise the alias the owner picked, read at start so a switch applies to the next task everywhere.
            model: task.model ?? this.model(),
            maxTurns: this.config.claude.maxTurns,
            permissionMode: this.config.claude.permissionMode,
            env: this.agentEnv(),
            timeoutMs: this.config.claude.taskTimeoutMs,
            onEvent: (event) => {
                sawOutput = true
                const origin = { agent: event.agent, parent_tool_use_id: event.parentToolUseId }
                if (event.type === 'init') {
                    this.rememberTools(event.tools)
                    this.rememberMcp(conversation.project ?? '.', event.mcpServers)
                    return
                }
                if (event.type === 'rate_limit') {
                    first ??= event.limits.five_hour
                    this.recordLimits(event.limits, task.id)
                    this.emit('event', this.store.addEvent(task.id, 'limits', event.limits, origin))
                    return
                }
                if (event.type === 'ask') {
                    // Under bypassPermissions only AskUserQuestion comes this way; in the other modes every tool the mode does not settle does.
                    const ask: Ask = {
                        kind: event.toolName === 'AskUserQuestion' ? 'question' : 'permission',
                        request_id: event.requestId,
                        tool_use_id: event.toolUseId,
                        tool_name: event.toolName,
                        input: event.input,
                        answers: {},
                        agent: null,
                        asked_at: new Date().toISOString()
                    }
                    this.emit(
                        'event',
                        this.store.addEvent(
                            task.id,
                            'ask',
                            { kind: ask.kind, request_id: ask.request_id, tool_name: ask.tool_name, input: ask.input },
                            origin
                        )
                    )
                    this.emit('task', this.store.updateTask(task.id, { ask }))
                    log.info(`${task.id} asks: ${ask.kind} ${ask.tool_name}`)
                    if (task.schedule) this.answerLater(task.id, ask)
                    return
                }
                if (event.type === 'ask_cancelled') {
                    const current = this.store.getTask(task.id)
                    if (current?.ask?.request_id === event.requestId)
                        this.emit('task', this.store.updateTask(task.id, { ask: null }))
                    return
                }
                const { type, agent: _agent, parentToolUseId: _parent, ...payload } = event
                if (event.type === 'text' && !event.agent) sawText = true
                if (event.type === 'llm') {
                    // The CLI's final result counts the orchestrator's own calls only; the sub-agents' calls arrive here too.
                    spent.input += event.inputTokens
                    spent.output += event.outputTokens
                    spent.cacheRead += event.cacheReadTokens
                    spent.cacheCreation += event.cacheCreationTokens
                    if (!event.agent) turns++
                    const at = Date.now()
                    if (at - progressAt >= PROGRESS_EVERY_MS) {
                        progressAt = at
                        this.store.updateTask(task.id, {
                            num_turns: turns,
                            duration_ms: at - startedAt,
                            input_tokens: spent.input,
                            output_tokens: spent.output,
                            cache_read_tokens: spent.cacheRead,
                            cache_creation_tokens: spent.cacheCreation
                        })
                    }
                }
                // A project-less task takes the first workspace its tools touch, and binds the
                // conversation only when it has no project yet (2026-10-05: a bound conversation
                // used to follow any mention of another checkout, so one `git status` across the
                // fence moved the thread, dropped its session and the next reply was about the
                // other repository). Later tasks of a bound conversation never leave it.
                if (event.type === 'tool_use' && !project) {
                    project = detectProject(
                        event.input,
                        this.workspaces(),
                        (name) => this.workspace.projectPath(name) !== null
                    )
                    if (project) {
                        this.store.updateTask(task.id, { project })
                        if (!conversation.project) this.store.updateConversation(conversation.id, { project })
                    }
                }
                this.emit('event', this.store.addEvent(task.id, type, payload, origin))
            }
        })
        this.running.set(task.id, handle)

        void handle.sessionId.then((sessionId) => {
            if (!sessionId) return
            this.store.updateTask(task.id, { session_id: sessionId })
            this.store.updateConversation(conversation.id, { session_id: sessionId })
        })

        try {
            const result = await handle.result
            if (result.sessionId) this.store.updateConversation(conversation.id, { session_id: result.sessionId })
            const last = result.rateLimits?.five_hour ?? null
            const before = previous && last && previous.resets_at === last.resets_at ? previous : first
            const delta =
                before && last && before.resets_at === last.resets_at ? Math.max(0, last.used - before.used) : null
            // Every model call seen on the stream, sub-agents included, against the result's own figures (the orchestrator only, and only its last turn when sub-agents ran in the background): the larger reading is the truth.
            const seen = spent.input + spent.output + spent.cacheRead + spent.cacheCreation
            const counted =
                result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheCreationTokens
            const all = seen > counted
            // The orchestrator answered while sub-agents were still working: `claude -p` has no
            // "later", whatever they did after that reached nobody. Said in the result (Telegram,
            // and the web when nothing streamed) and as a text event (the web thread otherwise
            // shows only the streamed prose).
            const cutOff = this.stopRequested.has(task.id) || result.isError ? '' : cutOffNote(result)
            if (cutOff) {
                log.warn(
                    `task ${task.id} answered with ${result.openAgentsAtResult} sub-agent(s) still running, ${result.stoppedAgentsAtResult} stopped unseen`
                )
                if (sawText) this.emit('event', this.store.addEvent(task.id, 'text', { text: cutOff }))
            }
            // Refused for the subscription limit: back to the queue until the window resets, the session kept.
            const reset = this.stopRequested.has(task.id) ? null : limitReset(result)
            const waits = reset ? this.waitForReset(task.id, reset) : null
            if (waits === true) return
            await end({
                status: this.stopRequested.has(task.id) ? 'cancelled' : result.isError ? 'failed' : 'done',
                session_id: result.sessionId || conversation.session_id,
                result: cutOff ? `${result.text}\n\n${cutOff}` : result.text,
                // Error results (max turns, budget, execution errors) often carry no text: name the reason.
                error: result.isError
                    ? typeof waits === 'string'
                        ? waits
                        : result.text || `claude stopped: ${result.subtype}`
                    : null,
                num_turns: result.numTurns,
                cost_usd: result.costUsd,
                // Wall clock: the result's duration stops at the orchestrator's last turn, before background sub-agents end.
                duration_ms: Math.max(result.durationMs, Date.now() - startedAt),
                input_tokens: all ? spent.input : result.inputTokens,
                output_tokens: all ? spent.output : result.outputTokens,
                cache_read_tokens: all ? spent.cacheRead : result.cacheReadTokens,
                cache_creation_tokens: all ? spent.cacheCreation : result.cacheCreationTokens,
                window_5h_delta: delta
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (this.stopped && !this.stopRequested.has(task.id)) {
                // Supervisor shutdown, not the owner's stop: leave the task
                // `running` for the next process to re-queue (see constructor).
                log.info(`task ${task.id} interrupted by shutdown; it resumes after the restart`)
                return
            }
            if (this.stopRequested.has(task.id)) {
                await end({ status: 'cancelled', error: message })
                return
            }
            if (error instanceof RunTimeout) {
                await end({ status: 'failed', error: message })
                return
            }
            if (resuming && !sawOutput && mayRetry) {
                log.warn(
                    `session ${conversation.session_id} of ${conversation.id} could not be resumed, starting afresh: ${message}`
                )
                this.store.updateConversation(conversation.id, { session_id: null })
                this.emit(
                    'event',
                    this.store.addEvent(task.id, 'status', {
                        status: 'running',
                        note: 'previous session could not be resumed; starting a fresh one'
                    })
                )
                this.running.delete(task.id)
                await this.attempt(task, false)
                return
            }
            await end({ status: 'failed', error: message })
        }
    }

    /**
     * A task the subscription limit stopped goes back to the queue with
     * `not_before` = the reset (plus a minute) and continues its session
     * then, like a task interrupted by a restart. Only when the reset is
     * within `CLAUDE_AUTO_CONTINUE_HOURS` and the task has not waited
     * `MAX_LIMIT_WAITS` times already; otherwise it fails as before, with
     * the reset time in the error. Returns true when it waits, else the
     * error to fail with.
     */
    private waitForReset(taskId: string, reset: Date, now = Date.now()): true | string {
        const task = this.store.getTask(taskId)
        if (!task) return 'subscription limit reached'
        const at = new Date(Math.max(reset.getTime(), now) + RESET_MARGIN_MS)
        const wait = at.getTime() - now
        const max = this.config.claude.autoContinueMs
        if (max <= 0 || wait > max || task.limit_waits >= MAX_LIMIT_WAITS) {
            const why =
                max <= 0
                    ? 'auto-continue is off'
                    : task.limit_waits >= MAX_LIMIT_WAITS
                      ? `it already waited ${task.limit_waits} times`
                      : 'that is further away than CLAUDE_AUTO_CONTINUE_HOURS'
            return `Subscription limit reached; the window resets at ${reset.toISOString()} (not waiting: ${why}). Say "continue" after that.`
        }
        this.pausedUntil = Math.max(this.pausedUntil, at.getTime())
        const updated = this.store.updateTask(taskId, {
            status: 'queued',
            not_before: at.toISOString(),
            limit_waits: task.limit_waits + 1,
            started_at: null,
            ask: null,
            error: null
        })
        this.emit(
            'event',
            this.store.addEvent(taskId, 'status', {
                status: 'queued',
                note: `subscription limit reached; continues after the window resets`,
                not_before: updated.not_before
            })
        )
        log.warn(`${taskId} hit the subscription limit; waits until ${updated.not_before}`)
        this.emit('task', updated)
        return true
    }

    /** The task's changes in its checkout (`tasks.git`) and the branch's pull request; never fails the task. */
    private async recordChanges(taskId: string, cwd: string): Promise<void> {
        const task = this.store.getTask(taskId)
        if (!task?.git?.start_head) return
        try {
            const git = await measure(cwd, task.git)
            // A short lookup: the report waits for it, and a slow GitHub must not hold the conversation.
            if (git.files && git.branch && git.branch !== git.default_branch)
                git.pr = await findPullRequest(cwd, git.branch, this.agentEnv(), 5_000)
            this.store.updateTask(taskId, { git })
        } catch (error) {
            log.warn(
                `${taskId}: could not measure the changes: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private finish(taskId: string, patch: Partial<Task>): void {
        const task = this.store.updateTask(taskId, { ...patch, ask: null, finished_at: new Date().toISOString() })
        const tokens = task.input_tokens + task.output_tokens + task.cache_read_tokens + task.cache_creation_tokens
        this.emit(
            'event',
            this.store.addEvent(taskId, task.status === 'failed' ? 'error' : 'status', {
                status: task.status,
                error: task.error ?? undefined,
                num_turns: task.num_turns,
                tokens,
                window_5h_delta: task.window_5h_delta,
                duration_ms: task.duration_ms
            })
        )
        log.info(
            `${task.status} ${task.id}: ${task.num_turns} turns · ${fmtTokens(tokens)} tokens · ${Math.round(task.duration_ms / 1000)}s`
        )
        this.emit('task', task)
    }
}

const TITLE_MAX = 60

/** A conversation title from its first prompt: the first line, cut at a word boundary. */
export function titleFrom(prompt: string): string {
    const line =
        prompt
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? ''
    const text = line.replace(/\s+/g, ' ')
    if (text.length <= TITLE_MAX) return text
    const cut = text.slice(0, TITLE_MAX)
    const atWord = cut.lastIndexOf(' ')
    return (atWord > TITLE_MAX / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…'
}
