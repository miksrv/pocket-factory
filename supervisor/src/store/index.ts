import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

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
    cost_usd: number
    duration_ms: number
    input_tokens: number
    output_tokens: number
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
    cost_today: number
    cost_total: number
}

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
                    SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN cost_usd ELSE 0 END) AS cost_today,
                    SUM(cost_usd) AS cost_total
                 FROM tasks`
            )
            .get(today, today, today) as Record<keyof TaskStats, number | null>
        return {
            queued: row.queued ?? 0,
            running: row.running ?? 0,
            done_today: row.done_today ?? 0,
            failed_today: row.failed_today ?? 0,
            cost_today: row.cost_today ?? 0,
            cost_total: row.cost_total ?? 0
        }
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
