import { EventEmitter } from 'node:events'

import { type RunHandle, runClaude } from '../claude/runner.js'
import type { Config } from '../config.js'
import { createLogger } from '../logger.js'
import type { Channel, Conversation, Store, Task, TaskEvent, TaskSource } from '../store/index.js'

const log = createLogger('tasks')

export interface TaskServiceEvents {
    /** A task row changed (queued → running → done / failed / cancelled). */
    task: [task: Task]
    /** Streamed output for a running task. */
    event: [event: TaskEvent]
}

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

    constructor(
        private readonly store: Store,
        private readonly config: Config
    ) {
        super()
        const orphaned = store.failOrphanedTasks()
        if (orphaned > 0) log.warn(`${orphaned} task(s) were running when the supervisor died; marked failed`)
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
        this.store.addEvent(task.id, 'status', { status: 'running' })

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
            this.finish(task.id, {
                status: result.isError ? 'failed' : 'done',
                session_id: result.sessionId || conversation.session_id,
                result: result.text,
                error: result.isError ? result.text : null,
                num_turns: result.numTurns,
                cost_usd: result.costUsd,
                duration_ms: result.durationMs,
                input_tokens: result.inputTokens,
                output_tokens: result.outputTokens
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
        this.emit('event', this.store.addEvent(taskId, task.status === 'failed' ? 'error' : 'status', {
            status: task.status,
            error: task.error ?? undefined,
            cost_usd: task.cost_usd,
            num_turns: task.num_turns,
            duration_ms: task.duration_ms
        }))
        log.info(`${task.status} ${task.id}: ${task.num_turns} turns · ≈$${task.cost_usd.toFixed(2)} · ${Math.round(task.duration_ms / 1000)}s`)
        this.emit('task', task)
    }
}
