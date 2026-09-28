import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { RateLimits } from '../claude/runner.js'

export type Channel = 'telegram' | 'web'
export type TaskSource = 'telegram' | 'web' | 'cron' | 'webhook'
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type TaskEventType = 'text' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'llm' | 'agent' | 'limits'

export interface Conversation {
    id: string
    channel: Channel
    external_id: string | null
    title: string | null
    session_id: string | null
    project: string | null
    created_at: string
    updated_at: string
    /** Set when the owner removed it from the Chat list; tasks and events remain. */
    deleted_at: string | null
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
    /** Workspace the task worked in: set from the conversation or detected from tool calls. */
    project: string | null
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
    /** Sub-agent type that produced the event; null for the orchestrator. */
    agent: string | null
    parent_tool_use_id: string | null
}

export interface EventOrigin {
    agent: string | null
    parent_tool_use_id: string | null
}

/** A task event with the task columns the audit log shows next to it. */
export interface AuditEvent extends TaskEvent {
    project: string | null
    conversation_id: string
    session_id: string | null
}

export interface AuditQuery {
    /** ISO timestamp; only events at or after it. */
    since?: string
    /** Event types to include; `files` is the tool_use subset that changes files. */
    kind?: 'all' | 'llm' | 'tools' | 'files' | 'agents' | 'sessions' | 'limits'
    /** Sub-agent type, or `orchestrator` for events without one. */
    agent?: string
    project?: string
    /** Only events with an id below this one (paging backwards). */
    before?: number
    limit?: number
}

export interface AuditStats {
    events: number
    agents: number
    tasks: number
    tokens: number
}

/** Per-agent activity; `agent` null is the orchestrator. */
export interface AgentActivity {
    agent: string | null
    /** Sub-agent starts (tasks started, for the orchestrator) in the period. */
    runs: number
    /** Sub-agents started in still-running tasks and not finished (running tasks, for the orchestrator). */
    running: number
    /** Tokens of the model calls the agent made in the period. */
    tokens: number
    last_active: string | null
}

const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const AUDIT_KINDS: Record<Exclude<AuditQuery['kind'], undefined | 'all' | 'files'>, TaskEventType[]> = {
    llm: ['llm'],
    tools: ['tool_use'],
    agents: ['agent'],
    sessions: ['status', 'error'],
    limits: ['limits']
}
/** Everything the audit log lists; assistant prose and tool output stay in the task view. */
const AUDIT_TYPES: TaskEventType[] = ['llm', 'tool_use', 'agent', 'status', 'error', 'limits']

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
/**
 * Keyset cursor: the last row a client has, by its sort timestamp and id.
 * `id` breaks ties between rows created in the same millisecond; without it a
 * page boundary would skip or repeat them.
 */
export interface Cursor {
    ts: string
    id?: string
}

/** WHERE fragment for "strictly before this cursor" on a `<column> DESC, id DESC` order. */
function keyset(column: string, before: Cursor | undefined, prefix = 'AND '): { sql: string; values: unknown[] } {
    if (!before) return { sql: '', values: [] }
    if (!before.id) return { sql: `${prefix}${column} < ?`, values: [before.ts] }
    return { sql: `${prefix}(${column} < ? OR (${column} = ? AND id < ?))`, values: [before.ts, before.ts, before.id] }
}

export class Store {
    constructor(private readonly db: DatabaseSync) {}

    // ---- conversations ----------------------------------------------------

    findConversation(channel: Channel, externalId: string): Conversation | undefined {
        return this.db
            .prepare(
                'SELECT * FROM conversations WHERE channel = ? AND external_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1'
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
            updated_at: ts,
            deleted_at: null
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

    /**
     * Newest activity first. The cursor is the last row shown: its `updated_at`
     * plus its id, so rows sharing a timestamp are neither skipped nor repeated.
     */
    listConversations(limit = 50, before?: Cursor): Conversation[] {
        const { sql, values } = keyset('updated_at', before)
        return this.db
            .prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL ${sql} ORDER BY updated_at DESC, id DESC LIMIT ?`)
            .all(...(values as never[]), limit) as unknown as Conversation[]
    }

    /** Soft delete: hide from the Chat list; the next Telegram message starts a fresh conversation. */
    deleteConversation(id: string): void {
        this.db.prepare('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    }

    // ---- tasks ------------------------------------------------------------

    createTask(conversationId: string, source: TaskSource, prompt: string, project: string | null = null): Task {
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
            project,
            created_at: now(),
            started_at: null,
            finished_at: null
        }
        this.db
            .prepare(
                `INSERT INTO tasks (id, conversation_id, source, prompt, status, project, created_at)
                 VALUES (?, ?, ?, ?, 'queued', ?, ?)`
            )
            .run(task.id, conversationId, source, prompt, project, task.created_at)
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

    /** Newest first; `before` is the last row already shown (`created_at` + id, keyset paging). */
    listTasks(options: { status?: TaskStatus; conversationId?: string; project?: string; before?: Cursor; limit?: number } = {}): Task[] {
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
        if (options.project) {
            where.push('project = ?')
            values.push(options.project)
        }
        if (options.before) {
            const cursor = keyset('created_at', options.before, '')
            where.push(cursor.sql)
            values.push(...cursor.values)
        }
        values.push(options.limit ?? 100)
        return this.db
            .prepare(
                `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(...(values as never[])) as unknown as Task[]
    }

    /** Distinct projects tasks have worked in, for filter menus. */
    taskProjects(): string[] {
        const rows = this.db.prepare('SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL ORDER BY project').all() as Array<{ project: string }>
        return rows.map((row) => row.project)
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

    /** Tasks left in `running` by a previous supervisor process are lost; returns them as failed. */
    failOrphanedTasks(): Task[] {
        return this.db
            .prepare(
                `UPDATE tasks SET status = 'failed', error = 'supervisor restarted while the task was running',
                 finished_at = ? WHERE status = 'running' RETURNING *`
            )
            .all(now()) as unknown as Task[]
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

    // ---- meta -------------------------------------------------------------

    getMeta<T>(key: string): T | undefined {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
        return row ? (JSON.parse(row.value) as T) : undefined
    }

    setMeta(key: string, value: unknown): void {
        this.db
            .prepare('INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
            .run(key, JSON.stringify(value), now())
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

    addEvent(taskId: string, type: TaskEventType, payload: unknown, origin: EventOrigin = { agent: null, parent_tool_use_id: null }): TaskEvent {
        const ts = now()
        const result = this.db
            .prepare('INSERT INTO task_events (task_id, ts, type, payload, agent, parent_tool_use_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(taskId, ts, type, JSON.stringify(payload), origin.agent, origin.parent_tool_use_id)
        return { id: Number(result.lastInsertRowid), task_id: taskId, ts, type, payload, ...origin }
    }

    // ---- audit log --------------------------------------------------------

    private auditWhere(query: AuditQuery): { sql: string; values: unknown[] } {
        const where: string[] = []
        const values: unknown[] = []
        const kind = query.kind ?? 'all'
        if (kind === 'files') {
            where.push(
                `(e.type = 'tool_use' AND (json_extract(e.payload, '$.name') IN (${FILE_TOOLS.map(() => '?').join(', ')})
                   OR (json_extract(e.payload, '$.name') = 'Bash' AND json_extract(e.payload, '$.input.command') GLOB '*git [cp][ou][ms][mh]*')))`
            )
            values.push(...FILE_TOOLS)
        } else {
            const types = kind === 'all' ? AUDIT_TYPES : AUDIT_KINDS[kind]
            where.push(`e.type IN (${types.map(() => '?').join(', ')})`)
            values.push(...types)
        }
        if (query.since) {
            where.push('e.ts >= ?')
            values.push(query.since)
        }
        if (query.agent === 'orchestrator') where.push('e.agent IS NULL')
        else if (query.agent) {
            where.push('e.agent = ?')
            values.push(query.agent)
        }
        if (query.project) {
            where.push('t.project = ?')
            values.push(query.project)
        }
        if (query.before) {
            where.push('e.id < ?')
            values.push(query.before)
        }
        return { sql: `WHERE ${where.join(' AND ')}`, values }
    }

    /** Newest first. */
    listAudit(query: AuditQuery = {}): AuditEvent[] {
        const { sql, values } = this.auditWhere(query)
        const rows = this.db
            .prepare(
                `SELECT e.*, t.project, t.conversation_id, t.session_id
                 FROM task_events e JOIN tasks t ON t.id = e.task_id
                 ${sql} ORDER BY e.id DESC LIMIT ?`
            )
            .all(...(values as never[]), query.limit ?? 200) as unknown as Array<Omit<AuditEvent, 'payload'> & { payload: string }>
        return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
    }

    /** Totals for the same filter as the list (kind included), so "N of total" and paging agree. */
    auditStats(query: Pick<AuditQuery, 'since' | 'project' | 'agent' | 'kind'>): AuditStats {
        const { sql, values } = this.auditWhere({ ...query, before: undefined })
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS events,
                        COUNT(DISTINCT COALESCE(e.agent, '')) AS agents,
                        COUNT(DISTINCT e.task_id) AS tasks,
                        SUM(CASE WHEN e.type = 'llm' THEN json_extract(e.payload, '$.tokens') ELSE 0 END) AS tokens
                 FROM task_events e JOIN tasks t ON t.id = e.task_id ${sql}`
            )
            .get(...(values as never[])) as Record<keyof AuditStats, number | null>
        return { events: row.events ?? 0, agents: row.agents ?? 0, tasks: row.tasks ?? 0, tokens: row.tokens ?? 0 }
    }

    agentActivity(since?: string): AgentActivity[] {
        const cond = since ? 'AND e.ts >= ?' : ''
        const args = since ? [since] : []
        const rows = new Map<string | null, AgentActivity>()
        const row = (agent: string | null) => {
            let r = rows.get(agent)
            if (!r) {
                r = { agent, runs: 0, running: 0, tokens: 0, last_active: null }
                rows.set(agent, r)
            }
            return r
        }
        const starts = this.db
            .prepare(
                `SELECT e.agent, COUNT(*) AS runs, MAX(e.ts) AS last FROM task_events e
                 WHERE e.type = 'agent' AND json_extract(e.payload, '$.phase') = 'started' ${cond} GROUP BY e.agent`
            )
            .all(...(args as never[])) as Array<{ agent: string; runs: number; last: string }>
        for (const s of starts) Object.assign(row(s.agent), { runs: s.runs, last_active: s.last })
        const tokens = this.db
            .prepare(
                `SELECT e.agent, SUM(json_extract(e.payload, '$.tokens')) AS tokens, MAX(e.ts) AS last FROM task_events e
                 WHERE e.type = 'llm' ${cond} GROUP BY e.agent`
            )
            .all(...(args as never[])) as Array<{ agent: string | null; tokens: number; last: string }>
        for (const t of tokens) {
            const r = row(t.agent)
            r.tokens = t.tokens ?? 0
            if (!r.last_active || t.last > r.last_active) r.last_active = t.last
        }
        // A sub-agent is running when its start in a running task has no completion yet.
        const running = this.db
            .prepare(
                `SELECT e.agent, COUNT(*) AS n FROM task_events e JOIN tasks t ON t.id = e.task_id
                 WHERE t.status = 'running' AND e.type = 'agent' AND json_extract(e.payload, '$.phase') = 'started'
                   AND NOT EXISTS (
                       SELECT 1 FROM task_events f WHERE f.task_id = e.task_id AND f.type = 'agent'
                         AND json_extract(f.payload, '$.phase') != 'started'
                         AND json_extract(f.payload, '$.toolUseId') = json_extract(e.payload, '$.toolUseId')
                   )
                 GROUP BY e.agent`
            )
            .all() as Array<{ agent: string; n: number }>
        for (const r of running) row(r.agent).running = r.n
        // The orchestrator: tasks are its runs.
        const orchestrator = row(null)
        const tasks = this.db
            .prepare(`SELECT COUNT(*) AS runs, MAX(started_at) AS last, SUM(status = 'running') AS running FROM tasks WHERE started_at IS NOT NULL ${since ? 'AND started_at >= ?' : ''}`)
            .get(...(args as never[])) as { runs: number; last: string | null; running: number | null }
        orchestrator.runs = tasks.runs
        orchestrator.running = tasks.running ?? 0
        if (tasks.last && (!orchestrator.last_active || tasks.last > orchestrator.last_active)) orchestrator.last_active = tasks.last
        return [...rows.values()].sort((a, b) => (a.agent === null ? -1 : b.agent === null ? 1 : b.runs - a.runs))
    }

    /** Distinct agents and projects seen since a timestamp, for filter menus. */
    auditFacets(since?: string): { agents: string[]; projects: string[] } {
        const cond = since ? 'WHERE e.ts >= ?' : ''
        const args = since ? [since] : []
        const agents = this.db
            .prepare(`SELECT DISTINCT e.agent FROM task_events e ${cond} ${cond ? 'AND' : 'WHERE'} e.agent IS NOT NULL ORDER BY e.agent`)
            .all(...(args as never[])) as Array<{ agent: string }>
        const projects = this.db
            .prepare(`SELECT DISTINCT t.project FROM task_events e JOIN tasks t ON t.id = e.task_id ${cond} ${cond ? 'AND' : 'WHERE'} t.project IS NOT NULL ORDER BY t.project`)
            .all(...(args as never[])) as Array<{ project: string }>
        return { agents: agents.map((r) => r.agent), projects: projects.map((r) => r.project) }
    }

    listEvents(taskId: string, afterId = 0): TaskEvent[] {
        const rows = this.db
            .prepare('SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC')
            .all(taskId, afterId) as unknown as Array<Omit<TaskEvent, 'payload'> & { payload: string }>
        return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
    }

    /** All events of the given tasks, oldest first. */
    listEventsOfTasks(taskIds: string[]): TaskEvent[] {
        if (taskIds.length === 0) return []
        const rows = this.db
            .prepare(`SELECT * FROM task_events WHERE task_id IN (${taskIds.map(() => '?').join(', ')}) ORDER BY id ASC`)
            .all(...(taskIds as never[])) as unknown as Array<Omit<TaskEvent, 'payload'> & { payload: string }>
        return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
    }

    /** Tasks of a conversation that are not finished, for a client that (re)connects to the live feed. */
    openTasks(conversationId: string): Task[] {
        return this.db
            .prepare(`SELECT * FROM tasks WHERE conversation_id = ? AND status IN ('queued', 'running') ORDER BY created_at ASC`)
            .all(conversationId) as unknown as Task[]
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
