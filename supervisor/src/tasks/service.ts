import { EventEmitter } from 'node:events'

import { type RateLimits, type RunHandle, runClaude } from '../claude/runner.js'
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

/**
 * The session manager: one queue for every channel, spawn-on-demand
 * `claude -p` per task, at most one running task per conversation and
 * MAX_CONCURRENT_SESSIONS overall. Session continuity is Claude Code's own
 * transcript — we only remember the session id on the conversation.
 */
export class TaskService extends EventEmitter<TaskServiceEvents> {
    private readonly running = new Map<string, RunHandle>()
    private ticking = false
    private stopped = false
    private probe: Promise<RateLimitSnapshot | null> | null = null

    constructor(
        private readonly store: Store,
        private readonly config: Config
    ) {
        super()
        const orphaned = store.failOrphanedTasks()
        if (orphaned > 0) log.warn(`${orphaned} task(s) were running when the supervisor died; marked failed`)
        // Tasks queued before a restart are still queued; pick them up.
        queueMicrotask(() => this.tick())
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

    async shutdown(): Promise<void> {
        this.stopped = true
        for (const handle of this.running.values()) handle.kill()
        await Promise.allSettled([...this.running.values()].map((handle) => handle.result))
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
            env: { CLAUDE_CONFIG_DIR: this.config.claude.configDir }
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
        const conversation = this.store.getConversation(task.conversation_id)!
        const started = this.store.updateTask(task.id, { status: 'running', started_at: new Date().toISOString() })
        this.emit('task', started)
        this.emit('event', this.store.addEvent(task.id, 'status', { status: 'running' }))

        // The 5-hour reading before this task's first API call: the previous
        // snapshot if it is from the same window, else the task's own first one.
        const previous = this.store.latestRateLimits()?.five_hour ?? null
        let first: RateLimits['five_hour'] = null

        const handle = runClaude({
            prompt: task.prompt,
            cwd: this.config.paths.workspacesRoot,
            resumeSessionId: conversation.session_id ?? undefined,
            model: this.config.claude.model,
            maxTurns: this.config.claude.maxTurns,
            maxBudgetUsd: this.config.claude.maxBudgetUsd,
            permissionMode: this.config.claude.permissionMode,
            env: { CLAUDE_CONFIG_DIR: this.config.claude.configDir },
            onEvent: (event) => {
                if (event.type === 'rate_limit') {
                    first ??= event.limits.five_hour
                    this.recordLimits(event.limits, task.id)
                    return
                }
                const { type, ...payload } = event
                this.emit('event', this.store.addEvent(task.id, type, payload))
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
                status: result.isError ? 'failed' : 'done',
                session_id: result.sessionId || conversation.session_id,
                result: result.text,
                error: result.isError ? result.text : null,
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
            const cancelled = /terminated by SIG/.test(message)
            this.finish(task.id, { status: cancelled ? 'cancelled' : 'failed', error: message })
        } finally {
            this.running.delete(task.id)
            queueMicrotask(() => this.tick())
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
