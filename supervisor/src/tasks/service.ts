import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { type RateLimits, type RunHandle, runClaude, RunTimeout } from '../claude/runner.js'
import type { Config } from '../config.js'
import { createLogger } from '../logger.js'
import type { Channel, Conversation, RateLimitSnapshot, Store, Task, TaskEvent, TaskSource } from '../store/index.js'

const log = createLogger('tasks')

export interface TaskServiceEvents {
    /** A task row changed (queued → running → done / failed / cancelled). */
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
 * Which workspace a tool call touches: the first workspace directory name
 * that appears as a path segment in the call's input (file paths, `cd x`,
 * `x/src/...`). Names shorter than three characters are too ambiguous.
 */
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
    /** Tasks found `running` at startup, failed by the store; announced once a listener can deliver. */
    private readonly orphaned: Task[]
    private ticking = false
    private stopped = false
    private probe: Promise<RateLimitSnapshot | null> | null = null
    private workspaceCache: { names: string[]; at: number } = { names: [], at: 0 }

    constructor(
        private readonly store: Store,
        private readonly config: Config
    ) {
        super()
        this.orphaned = store.failOrphanedTasks()
        for (const task of this.orphaned) {
            store.addEvent(task.id, 'error', { status: 'failed', error: task.error ?? undefined })
        }
        if (this.orphaned.length > 0) log.warn(`${this.orphaned.length} task(s) were running when the supervisor died; marked failed`)
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

    newConversation(channel: Channel, externalId: string | null, title: string | null = null): Conversation {
        return this.store.createConversation(channel, externalId, title)
    }

    conversationOf(task: Task): Conversation | undefined {
        return this.store.getConversation(task.conversation_id)
    }

    // ---- queue ------------------------------------------------------------

    submit(conversationId: string, source: TaskSource, prompt: string): Task {
        const conversation = this.store.getConversation(conversationId)
        if (!conversation) throw new Error(`Unknown conversation ${conversationId}`)
        // The project is detected per task from its own tool calls, never inherited
        // from the conversation: one session may serve several projects in turn.
        const task = this.store.createTask(conversationId, source, prompt)
        if (!conversation.title) {
            this.store.updateConversation(conversationId, { title: prompt.slice(0, 80) })
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

    /** Stop every task and wait for the CLIs to exit (SIGKILL follows after the runner's grace period). */
    async shutdown(): Promise<void> {
        this.stopped = true
        for (const id of this.running.keys()) this.stop(id)
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
            env: { CLAUDE_CONFIG_DIR: this.config.claude.configDir },
            timeoutMs: PROBE_TIMEOUT_MS,
            onEvent: (event) => {
                if (event.type === 'init') this.rememberTools(event.tools)
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

    /** Tool names the CLI announced at session start; the agent editor offers them as choices. */
    tools(): string[] {
        return this.store.getMeta<string[]>('claude.tools') ?? []
    }

    private rememberTools(tools: string[]): void {
        const known = this.tools()
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
            cwd: this.config.paths.workspacesRoot,
            resumeSessionId: conversation.session_id ?? undefined,
            model: this.config.claude.model,
            maxTurns: this.config.claude.maxTurns,
            maxBudgetUsd: this.config.claude.maxBudgetUsd,
            permissionMode: this.config.claude.permissionMode,
            env: { CLAUDE_CONFIG_DIR: this.config.claude.configDir },
            timeoutMs: this.config.claude.taskTimeoutMs,
            onEvent: (event) => {
                sawOutput = true
                const origin = { agent: event.agent, parent_tool_use_id: event.parentToolUseId }
                if (event.type === 'init') {
                    this.rememberTools(event.tools)
                    return
                }
                if (event.type === 'rate_limit') {
                    first ??= event.limits.five_hour
                    this.recordLimits(event.limits, task.id)
                    this.emit('event', this.store.addEvent(task.id, 'limits', event.limits, origin))
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
            if (this.stopRequested.has(task.id) || this.stopped) {
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
        const task = this.store.updateTask(taskId, { ...patch, finished_at: new Date().toISOString() })
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
