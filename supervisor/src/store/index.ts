import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { RateLimits } from '../claude/runner.js'

export type Channel = 'telegram' | 'web'
export type TaskSource = 'telegram' | 'web' | 'cron' | 'webhook'
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type TaskEventType = 'text' | 'tool_use' | 'tool_result' | 'status' | 'error'

export interface Conversation {
    id: string
    channel: Channel
    external_id: string | null
    title: string | null
    session_id: string | null
    project: string | null
    created_at: string
    updated_at: string
}

export interface Task {
    id: string
    conversation_id: string
    source: TaskSource
    prompt: string
    status: TaskStatus
    session_id: string | null
    result: string | null
    error: string | null
    num_turns: number
    /** CLI list-price estimate, kept for the record only. */
    cost_usd: number
    duration_ms: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    /** Share of the 5-hour window consumed by this task (0..1), null when the CLI reported nothing. */
    window_5h_delta: number | null
    created_at: string
    started_at: string | null
    finished_at: string | null
}

export interface TaskEvent {
    id: number
    task_id: string
    ts: string
    type: TaskEventType
    payload: unknown
}

export interface TaskStats {
    queued: number
    running: number
    done_today: number
    failed_today: number
    /** All tokens (input, output, cache read, cache creation) of tasks created today / ever. */
    tokens_today: number
    tokens_total: number
}

/** A persisted rate-limit reading; see `RateLimits` for where it comes from. */
export interface RateLimitSnapshot extends RateLimits {
    id: number
    ts: string
    task_id: string | null
}

interface RateLimitRow {
    id: number
    ts: string
    task_id: string | null
    status: string
    five_hour_used: number | null
    five_hour_resets_at: string | null
    seven_day_used: number | null
    seven_day_resets_at: string | null
}

function snapshotFromRow(row: RateLimitRow): RateLimitSnapshot {
    return {
        id: row.id,
        ts: row.ts,
        task_id: row.task_id,
        status: row.status,
        five_hour:
            row.five_hour_used !== null && row.five_hour_resets_at
                ? { used: row.five_hour_used, resets_at: row.five_hour_resets_at }
                : null,
        seven_day:
            row.seven_day_used !== null && row.seven_day_resets_at
                ? { used: row.seven_day_used, resets_at: row.seven_day_resets_at }
                : null
    }
}

const sameWindow = (a: RateLimits['five_hour'], b: RateLimits['five_hour']) =>
    (a === null && b === null) || (a !== null && b !== null && a.used === b.used && a.resets_at === b.resets_at)

const now = () => new Date().toISOString()

/** Thin typed wrapper over the SQLite tables. All methods are synchronous. */
export class Store {
    constructor(private readonly db: DatabaseSync) {}

    // ---- conversations ----------------------------------------------------

    findConversation(channel: Channel, externalId: string): Conversation | undefined {
        return this.db
            .prepare(
                'SELECT * FROM conversations WHERE channel = ? AND external_id = ? ORDER BY created_at DESC LIMIT 1'
            )
            .get(channel, externalId) as Conversation | undefined
    }

    getConversation(id: string): Conversation | undefined {
        return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined
    }

    createConversation(channel: Channel, externalId: string | null, title: string | null = null): Conversation {
        const ts = now()
        const conversation: Conversation = {
            id: randomUUID(),
            channel,
            external_id: externalId,
            title,
            session_id: null,
            project: null,
            created_at: ts,
            updated_at: ts
        }
        this.db
            .prepare(
                `INSERT INTO conversations (id, channel, external_id, title, session_id, project, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
            )
            .run(conversation.id, channel, externalId, title, ts, ts)
        return conversation
    }

    updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'session_id' | 'project'>>): void {
        const sets: string[] = ['updated_at = ?']
        const values: unknown[] = [now()]
        for (const [key, value] of Object.entries(patch)) {
            sets.push(`${key} = ?`)
            values.push(value)
        }
        values.push(id)
        this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...(values as never[]))
    }

    listConversations(limit = 50): Conversation[] {
        return this.db
            .prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?')
            .all(limit) as unknown as Conversation[]
    }

    // ---- tasks ------------------------------------------------------------

    createTask(conversationId: string, source: TaskSource, prompt: string): Task {
        const task: Task = {
            id: randomUUID(),
            conversation_id: conversationId,
            source,
            prompt,
            status: 'queued',
            session_id: null,
            result: null,
            error: null,
            num_turns: 0,
            cost_usd: 0,
            duration_ms: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            window_5h_delta: null,
            created_at: now(),
            started_at: null,
            finished_at: null
        }
        this.db
            .prepare(
                `INSERT INTO tasks (id, conversation_id, source, prompt, status, created_at)
                 VALUES (?, ?, ?, ?, 'queued', ?)`
            )
            .run(task.id, conversationId, source, prompt, task.created_at)
        return task
    }

    getTask(id: string): Task | undefined {
        return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
    }

    updateTask(id: string, patch: Partial<Omit<Task, 'id'>>): Task {
        const sets: string[] = []
        const values: unknown[] = []
        for (const [key, value] of Object.entries(patch)) {
            sets.push(`${key} = ?`)
            values.push(value)
        }
        if (sets.length > 0) {
            values.push(id)
            this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...(values as never[]))
        }
        return this.getTask(id)!
    }

    listTasks(options: { status?: TaskStatus; conversationId?: string; limit?: number } = {}): Task[] {
        const where: string[] = []
        const values: unknown[] = []
        if (options.status) {
            where.push('status = ?')
            values.push(options.status)
        }
        if (options.conversationId) {
            where.push('conversation_id = ?')
            values.push(options.conversationId)
        }
        values.push(options.limit ?? 100)
        return this.db
            .prepare(
                `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT ?`
            )
            .all(...(values as never[])) as unknown as Task[]
    }

    /** Oldest queued tasks first, one per conversation that has nothing running. */
    nextQueuedTasks(): Task[] {
        return this.db
            .prepare(
                `SELECT t.* FROM tasks t
                 WHERE t.status = 'queued'
                   AND NOT EXISTS (
                       SELECT 1 FROM tasks r
                       WHERE r.conversation_id = t.conversation_id AND r.status = 'running'
                   )
                 GROUP BY t.conversation_id
                 HAVING t.created_at = MIN(t.created_at)
                 ORDER BY t.created_at ASC`
            )
            .all() as unknown as Task[]
    }

    /** Tasks left in `running` by a previous supervisor process are lost. */
    failOrphanedTasks(): number {
        const result = this.db
            .prepare(
                `UPDATE tasks SET status = 'failed', error = 'supervisor restarted while the task was running',
                 finished_at = ? WHERE status = 'running'`
            )
            .run(now())
        return Number(result.changes)
    }

    stats(): TaskStats {
        const today = new Date().toISOString().slice(0, 10)
        const row = this.db
            .prepare(
                `SELECT
                    SUM(status = 'queued')  AS queued,
                    SUM(status = 'running') AS running,
                    SUM(status = 'done'   AND substr(finished_at, 1, 10) = ?) AS done_today,
                    SUM(status = 'failed' AND substr(finished_at, 1, 10) = ?) AS failed_today,
                    SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN tokens ELSE 0 END) AS tokens_today,
                    SUM(tokens) AS tokens_total
                 FROM (
                    SELECT *, input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
                    FROM tasks
                 )`
            )
            .get(today, today, today) as Record<keyof TaskStats, number | null>
        return {
            queued: row.queued ?? 0,
            running: row.running ?? 0,
            done_today: row.done_today ?? 0,
            failed_today: row.failed_today ?? 0,
            tokens_today: row.tokens_today ?? 0,
            tokens_total: row.tokens_total ?? 0
        }
    }

    // ---- rate limits ------------------------------------------------------

    latestRateLimits(): RateLimitSnapshot | undefined {
        const row = this.db.prepare('SELECT * FROM rate_limits ORDER BY id DESC LIMIT 1').get() as RateLimitRow | undefined
        return row ? snapshotFromRow(row) : undefined
    }

    listRateLimits(limit = 100): RateLimitSnapshot[] {
        const rows = this.db.prepare('SELECT * FROM rate_limits ORDER BY id DESC LIMIT ?').all(limit) as unknown as RateLimitRow[]
        return rows.map(snapshotFromRow).reverse()
    }

    /**
     * Persist a reading. Unchanged readings only refresh the timestamp of the
     * latest row, so the table records changes rather than every API call.
     */
    recordRateLimits(limits: RateLimits, taskId: string | null): RateLimitSnapshot {
        const ts = now()
        const latest = this.latestRateLimits()
        if (
            latest &&
            latest.status === limits.status &&
            sameWindow(latest.five_hour, limits.five_hour) &&
            sameWindow(latest.seven_day, limits.seven_day)
        ) {
            this.db.prepare('UPDATE rate_limits SET ts = ?, task_id = ? WHERE id = ?').run(ts, taskId, latest.id)
            return { ...latest, ts, task_id: taskId }
        }
        const result = this.db
            .prepare(
                `INSERT INTO rate_limits (ts, task_id, status, five_hour_used, five_hour_resets_at, seven_day_used, seven_day_resets_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                ts,
                taskId,
                limits.status,
                limits.five_hour?.used ?? null,
                limits.five_hour?.resets_at ?? null,
                limits.seven_day?.used ?? null,
                limits.seven_day?.resets_at ?? null
            )
        return { id: Number(result.lastInsertRowid), ts, task_id: taskId, ...limits }
    }

    // ---- task events ------------------------------------------------------

    addEvent(taskId: string, type: TaskEventType, payload: unknown): TaskEvent {
        const ts = now()
        const result = this.db
            .prepare('INSERT INTO task_events (task_id, ts, type, payload) VALUES (?, ?, ?, ?)')
            .run(taskId, ts, type, JSON.stringify(payload))
        return { id: Number(result.lastInsertRowid), task_id: taskId, ts, type, payload }
    }

    listEvents(taskId: string, afterId = 0): TaskEvent[] {
        const rows = this.db
            .prepare('SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC')
            .all(taskId, afterId) as unknown as Array<Omit<TaskEvent, 'payload'> & { payload: string }>
        return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
    }

    listConversationEvents(conversationId: string, afterId = 0): TaskEvent[] {
        const rows = this.db
            .prepare(
                `SELECT e.* FROM task_events e JOIN tasks t ON t.id = e.task_id
                 WHERE t.conversation_id = ? AND e.id > ? ORDER BY e.id ASC`
            )
            .all(conversationId, afterId) as unknown as Array<Omit<TaskEvent, 'payload'> & { payload: string }>
        return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
    }
}
