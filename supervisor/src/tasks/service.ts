import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { execFile } from 'node:child_process'

import { type McpLoginView, McpLogins } from '../claude/mcpLogin.js'
import { type AskResponse, type McpServerStatus, type RateLimits, type RunHandle, runClaude, RunTimeout } from '../claude/runner.js'
import type { Config } from '../config.js'
import { createLogger } from '../logger.js'
import type { Ask, AskQuestion, Channel, Conversation, RateLimitSnapshot, Store, Task, TaskEvent, TaskSource } from '../store/index.js'

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

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One Haiku turn should not take longer than this; a hung probe would block `/usage refresh` for good. */
const PROBE_TIMEOUT_MS = 5 * 60_000

/**
 * How many supervisor restarts a task survives: it goes back to the queue and
 * resumes its session that many times, then fails. One is enough for a deploy
 * or a reboot; a task that keeps taking the supervisor down must not loop.
 */
const MAX_RESTARTS = 1

/** The questions of an `AskUserQuestion` call, as far as the input is well-formed. */
export function askQuestions(ask: Ask): AskQuestion[] {
    const questions = ask.kind === 'question' ? ask.input.questions : undefined
    return Array.isArray(questions) ? questions.filter((q): q is AskQuestion => Boolean(q) && typeof (q as AskQuestion).question === 'string') : []
}

/** Questions the owner has not answered yet, in order. */
export const openQuestions = (ask: Ask): AskQuestion[] => askQuestions(ask).filter((q) => !(q.question in ask.answers))

/**
 * How the owner answers an `Ask`: for a question, answers by question text
 * (any subset; the rest stay open); for a permission, allow or deny.
 */
export type Answer = { answers: Record<string, string> } | { behavior: 'allow' } | { behavior: 'deny'; message?: string }

/**
 * Variables the CLI (and so every Bash call of the agent) must not see: they
 * belong to the supervisor, not to the work. Compose hands the whole .env to
 * the container; a prompt injection that reads `env` would otherwise walk
 * away with the bot token and the UI password. GitHub tokens and MCP
 * secrets (`${VAR}` in mcp.json) stay, the agent needs them.
 */
const PRIVATE_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS', 'WEB_AUTH_USER', 'WEB_AUTH_PASSWORD', 'GROQ_API_KEY']

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

function detectProject(input: unknown, workspaces: string[]): string | null {
    const haystack = JSON.stringify(input ?? '')
    for (const name of workspaces) {
        if (name.length < 3) continue
        if (new RegExp(`(?:^|[\\s"'/=:(])${escapeRegExp(name)}(?=[\\s"'/):]|$)`).test(haystack)) return name
    }
    return null
}

/**
 * The session manager: one queue for every channel, spawn-on-demand
 * `claude -p` per task, at most one running task per conversation and
 * MAX_CONCURRENT_SESSIONS overall. Session continuity is Claude Code's own
 * transcript — we only remember the session id on the conversation.
 */
export class TaskService extends EventEmitter<TaskServiceEvents> {
    private readonly running = new Map<string, RunHandle>()
    /** Tasks the owner asked to stop: whatever way the CLI exits, they end as `cancelled`. */
    private readonly stopRequested = new Set<string>()
    /** Tasks found `running` at startup and failed by the store (restart limit reached); announced once a listener can deliver. */
    private readonly orphaned: Task[]
    private ticking = false
    private stopped = false
    private probe: Promise<RateLimitSnapshot | null> | null = null
    private workspaceCache: { names: string[]; at: number } = { names: [], at: 0 }
    /** Sign-ins to MCP servers started from the web UI; a completed one marks its server connected. */
    private readonly logins = new McpLogins((name) => this.rememberRegistry([{ name, status: 'connected', source: null }], null))

    constructor(
        private readonly store: Store,
        private readonly config: Config,
        private readonly workspace: Workspace
    ) {
        super()
        // Tasks that were running when the previous supervisor stopped: their
        // CLI is gone, but the conversation remembers the session, so the run
        // continues where the transcript ends (the prompt is sent once more
        // to the resumed session). Tasks over the restart limit fail instead.
        const { requeued, failed } = store.recoverOrphanedTasks(MAX_RESTARTS)
        for (const task of requeued) {
            store.addEvent(task.id, 'status', { status: 'queued', note: 'supervisor restarted while the task was running; resuming the session' })
        }
        for (const task of failed) {
            store.addEvent(task.id, 'error', { status: 'failed', error: task.error ?? undefined })
        }
        this.orphaned = failed
        if (requeued.length > 0) log.warn(`${requeued.length} task(s) were running when the supervisor stopped; re-queued`)
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

    newConversation(channel: Channel, externalId: string | null, title: string | null = null, project: string | null = null): Conversation {
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
        if (project && !this.workspace.projectPath(project)) throw new Error(`Unknown project "${project}" or its checkout is missing`)
        if (this.activeTask(conversationId)) throw new Error('a task is running in this conversation; wait for it to finish')
        if (conversation.project !== project) this.store.updateConversation(conversationId, { project, session_id: null })
        return this.store.getConversation(conversationId)!
    }

    /** A project file exists and its checkout is on disk. */
    hasProject(slug: string): boolean {
        return this.workspace.projectPath(slug) !== null
    }

    /** Where a conversation's tasks run: the project's checkout, else the workspaces root. */
    cwdFor(conversation: Conversation): string {
        return (conversation.project && this.workspace.projectPath(conversation.project)) || this.config.paths.workspacesRoot
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
                if (!known[key]) known[key] = { name: server.name, status: server.status, source: sourceOf(server.name, server.source, scope), seen_at: null }
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
            execFile('claude', ['mcp', 'list'], { cwd: this.config.paths.workspacesRoot, env: this.agentEnv(), timeout: 90_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
                if (error && !stdout) reject(new Error(`claude mcp list: ${stderr.trim() || error.message}`))
                else resolve(stdout)
            })
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
            const target = left.slice(name.length + 2).replace(/\s*\((?:HTTP|SSE|stdio)\)\s*$/i, '').trim() || null
            const status = /connected/i.test(verdict) ? 'connected' : /needs auth/i.test(verdict) ? 'needs-auth' : 'failed'
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
            if (known[key]?.status !== next.status || known[key]?.source !== next.source || known[key]?.name !== next.name || known[key]?.target !== target) changed = true
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
    submit(conversationId: string, source: TaskSource, prompt: string, options: { schedule?: string } = {}): Task {
        const conversation = this.store.getConversation(conversationId)
        if (!conversation) throw new Error(`Unknown conversation ${conversationId}`)
        const asking = this.pendingAsk(conversationId)
        if (asking && !options.schedule) {
            const question = openQuestions(asking.ask!)[0]
            if (question) return this.answer(asking.id, { answers: { [question.question]: prompt } })
        }
        // The project is detected per task from its own tool calls, never inherited
        // from the conversation: one session may serve several projects in turn.
        const task = this.store.createTask(conversationId, source, prompt, null, options.schedule ?? null)
        if (!conversation.title) {
            this.store.updateConversation(conversationId, { title: titleFrom(prompt) })
        }
        log.info(`queued ${task.id} (${source}): ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`)
        this.emit('task', task)
        queueMicrotask(() => this.tick())
        return task
    }

    /** Returns the running task of a conversation, if any. */
    activeTask(conversationId: string): Task | undefined {
        return this.store.listTasks({ conversationId, status: 'running', limit: 1 })[0]
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
            const given = Object.fromEntries(Object.entries(answer.answers).filter(([q, a]) => known.has(q) && typeof a === 'string' && a.trim()))
            if (!Object.keys(given).length) throw new Error('no answer to any of the questions')
            answers = { ...ask.answers, ...given }
            response = openQuestions({ ...ask, answers }).length ? null : { behavior: 'allow', updatedInput: { ...ask.input, answers } }
        } else if (answer.behavior === 'allow') {
            response = { behavior: 'allow', updatedInput: ask.kind === 'question' ? { ...ask.input, answers } : ask.input }
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

    /** Whether a task submitted now waits: this conversation is busy or queued, or every session slot is taken. */
    willWait(conversationId: string): boolean {
        if (this.running.size >= this.config.maxConcurrentSessions) return true
        return this.store.listTasks({ conversationId, status: 'running', limit: 1 }).length > 0 || this.store.listTasks({ conversationId, status: 'queued', limit: 1 }).length > 0
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
            maxBudgetUsd: this.config.claude.maxBudgetUsd,
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
                log.warn(`limits probe failed: ${error instanceof Error ? error.message : error}`)
                return null
            })
            .finally(() => {
                this.probe = null
            })
        return this.probe
    }

    /** The CLI's environment: the supervisor's own minus its private secrets, plus the config dir. Prefilters run with the same one. */
    agentEnv(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: this.config.claude.configDir }
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
        if (known.length === servers.length && known.every((s, i) => s.name === servers[i].name && s.status === servers[i].status)) return
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
            return Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})
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
        this.ticking = true
        try {
            for (const task of this.store.nextQueuedTasks()) {
                if (this.running.size >= this.config.maxConcurrentSessions) break
                if ([...this.running.keys()].some((id) => this.store.getTask(id)?.conversation_id === task.conversation_id)) {
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
        const cwd = this.cwdFor(conversation)
        // A session lives in the directory it started in: resuming it from another
        // cwd fails, so a conversation that moved (its project was detected or set
        // after the first task) starts a fresh session there instead of failing once.
        if (conversation.session_id) {
            const recorded = this.workspace.sessionWorkspace(conversation.session_id)
            if (recorded && recorded !== claudeSlug(cwd)) {
                log.info(`conversation ${conversation.id} moved to ${cwd}; session ${conversation.session_id} stays behind`)
                this.store.updateConversation(conversation.id, { session_id: null })
                conversation.session_id = null
                this.emit('event', this.store.addEvent(task.id, 'status', { status: 'running', note: `fresh session in ${cwd}` }))
            }
        }

        // The 5-hour reading before this task's first API call: the previous
        // snapshot if it is recent and from the same window (other Claude Code
        // clients on the account move the window too), else the task's own
        // first one, which misses the first call but nothing foreign.
        const latest = this.store.latestRateLimits()
        const previous = latest && Date.now() - new Date(latest.ts).getTime() < 5 * 60_000 ? latest.five_hour : null
        let first: RateLimits['five_hour'] = null
        let project = task.project
        const resuming = Boolean(conversation.session_id)
        let sawOutput = false

        const handle = runClaude({
            prompt: task.prompt,
            cwd,
            resumeSessionId: conversation.session_id ?? undefined,
            mcpConfig: this.mcpConfigFile(),
            settings: this.sessionSettings(conversation.project),
            model: this.config.claude.model,
            maxTurns: this.config.claude.maxTurns,
            maxBudgetUsd: this.config.claude.maxBudgetUsd,
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
                    this.emit('event', this.store.addEvent(task.id, 'ask', { kind: ask.kind, request_id: ask.request_id, tool_name: ask.tool_name, input: ask.input }, origin))
                    this.emit('task', this.store.updateTask(task.id, { ask }))
                    log.info(`${task.id} asks: ${ask.kind} ${ask.tool_name}`)
                    return
                }
                if (event.type === 'ask_cancelled') {
                    const current = this.store.getTask(task.id)
                    if (current?.ask?.request_id === event.requestId) this.emit('task', this.store.updateTask(task.id, { ask: null }))
                    return
                }
                const { type, agent: _agent, parentToolUseId: _parent, ...payload } = event
                if (event.type === 'tool_use' && !project) {
                    project = detectProject(event.input, this.workspaces())
                    if (project) {
                        this.store.updateTask(task.id, { project })
                        this.store.updateConversation(conversation.id, { project })
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
            const delta = before && last && before.resets_at === last.resets_at ? Math.max(0, last.used - before.used) : null
            this.finish(task.id, {
                status: this.stopRequested.has(task.id) ? 'cancelled' : result.isError ? 'failed' : 'done',
                session_id: result.sessionId || conversation.session_id,
                result: result.text,
                // Error results (max turns, budget, execution errors) often carry no text: name the reason.
                error: result.isError ? result.text || `claude stopped: ${result.subtype}` : null,
                num_turns: result.numTurns,
                cost_usd: result.costUsd,
                duration_ms: result.durationMs,
                input_tokens: result.inputTokens,
                output_tokens: result.outputTokens,
                cache_read_tokens: result.cacheReadTokens,
                cache_creation_tokens: result.cacheCreationTokens,
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
                this.finish(task.id, { status: 'cancelled', error: message })
                return
            }
            if (error instanceof RunTimeout) {
                this.finish(task.id, { status: 'failed', error: message })
                return
            }
            if (resuming && !sawOutput && mayRetry) {
                log.warn(`session ${conversation.session_id} of ${conversation.id} could not be resumed, starting afresh: ${message}`)
                this.store.updateConversation(conversation.id, { session_id: null })
                this.emit('event', this.store.addEvent(task.id, 'status', { status: 'running', note: 'previous session could not be resumed; starting a fresh one' }))
                this.running.delete(task.id)
                await this.attempt(task, false)
                return
            }
            this.finish(task.id, { status: 'failed', error: message })
        }
    }

    private finish(taskId: string, patch: Partial<Task>): void {
        const task = this.store.updateTask(taskId, { ...patch, ask: null, finished_at: new Date().toISOString() })
        const tokens = task.input_tokens + task.output_tokens + task.cache_read_tokens + task.cache_creation_tokens
        this.emit('event', this.store.addEvent(taskId, task.status === 'failed' ? 'error' : 'status', {
            status: task.status,
            error: task.error ?? undefined,
            num_turns: task.num_turns,
            tokens,
            window_5h_delta: task.window_5h_delta,
            duration_ms: task.duration_ms
        }))
        log.info(`${task.status} ${task.id}: ${task.num_turns} turns · ${fmtTokens(tokens)} tokens · ${Math.round(task.duration_ms / 1000)}s`)
        this.emit('task', task)
    }
}

const TITLE_MAX = 60

/** A conversation title from its first prompt: the first line, cut at a word boundary. */
export function titleFrom(prompt: string): string {
    const line = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
    const text = line.replace(/\s+/g, ' ')
    if (text.length <= TITLE_MAX) return text
    const cut = text.slice(0, TITLE_MAX)
    const atWord = cut.lastIndexOf(' ')
    return (atWord > TITLE_MAX / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…'
}
