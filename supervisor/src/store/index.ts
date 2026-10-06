import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { RateLimits } from '../claude/runner.js'
import type { Attachment } from '../files/inbox.js'
import type { TaskGit } from '../git/changes.js'

export type Channel = 'telegram' | 'web'
export type TaskSource = 'telegram' | 'web' | 'cron' | 'webhook'
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type TaskEventType = 'text' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'llm' | 'agent' | 'limits' | 'ask' | 'answer'

/** One question of an `AskUserQuestion` call, as the CLI sends it. */
export interface AskQuestion {
    question: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
}

/**
 * What a running task waits for from the owner. The CLI paused a tool call
 * and asked the supervisor (`can_use_tool` over stream-json): either the
 * agent's `AskUserQuestion` (kind `question`) or a permission request for
 * another tool (kind `permission`). The task stays `running` until the owner
 * answers from the web or Telegram; the answer goes back as the tool's input.
 */
export interface Ask {
    kind: 'question' | 'permission'
    /** The CLI's request id; the answer names it. */
    request_id: string
    tool_use_id: string
    tool_name: string
    /** The tool's input: `{ questions: AskQuestion[] }` for a question, the tool's arguments for a permission. */
    input: Record<string, unknown>
    /** Answers gathered so far, by question text (Telegram answers one question at a time). */
    answers: Record<string, string>
    /** Sub-agent that asked, null for the orchestrator. */
    agent: string | null
    asked_at: string
}

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
    /** When the owner last opened it in the web UI; null = never. */
    read_at: string | null
    /** A task finished after `read_at`: its reply was neither opened in the web nor delivered to Telegram. */
    unread: boolean
    /** A running task waits for the owner: a question or a permission request (Chat list, sidebar badge). */
    needs_reply: boolean
    /** A task of the conversation is queued or running (Chat list: blue stripe). */
    active: boolean
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
    /** How many supervisor restarts interrupted this task; it is re-queued while under the limit. */
    restarts: number
    /** What the task waits for from the owner; null while nothing is pending (always null once finished). */
    ask: Ask | null
    /** Name of the schedule that queued the task; null for the owner's own tasks. */
    schedule: string | null
    /** CLI model alias the task was queued with (a schedule's `model:`); null = the factory's current model at start. */
    model: string | null
    /** Files the owner sent with the message (data/inbox); their paths reach the agent after the prompt. */
    attachments: Attachment[] | null
    /** A queued task does not start before this time: it hit the subscription limit and waits for the window to reset. */
    not_before: string | null
    /** How many times the task went back to the queue to wait for a window reset. */
    limit_waits: number
    /** What the task changed in its project's checkout; null for a project-less task or a checkout that is not a git repository. */
    git: TaskGit | null
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
    sessions: ['status', 'error', 'ask', 'answer'],
    limits: ['limits']
}
/** Everything the audit log lists; assistant prose and tool output stay in the task view. */
const AUDIT_TYPES: TaskEventType[] = ['llm', 'tool_use', 'agent', 'status', 'error', 'limits', 'ask', 'answer']

export interface TaskStats {
    queued: number
    running: number
    done_today: number
    failed_today: number
    /** All tokens (input, output, cache read, cache creation) of tasks created today / ever. */
    tokens_today: number
    tokens_total: number
    /** Conversations with a reply the owner has not seen (see `Conversation.unread`). */
    chat_unread: number
    /** Conversations whose agent waits for the owner's answer (see `Conversation.needs_reply`). */
    chat_needs_reply: number
    /** Queued or running tasks of conversations in the Chat list. */
    chat_active: number
    /** The conversation whose reply landed last / whose question opened last: where a notification click should land. */
    chat_unread_latest: ChatRef | null
    chat_needs_reply_latest: ChatRef | null
}

export interface ChatRef {
    id: string
    title: string | null
}

/**
 * One firing of a schedule: what the scheduler decided at that minute.
 * `queued` = a task was created (`task_id`), `empty` = the prefilter found
 * nothing new, `skipped` = the run was not attempted (previous run still
 * active, soft-stop), `error` = the prefilter failed, `missed` = the minute
 * passed while the factory was off (nothing was run).
 */
export interface ScheduleRun {
    id: number
    schedule: string
    fired_at: string
    trigger: 'cron' | 'manual'
    status: 'queued' | 'empty' | 'skipped' | 'error' | 'missed'
    note: string | null
    items: number
    task_id: string | null
    duration_ms: number
    /** How the task ended (or where it is), when the run queued one. */
    task_status: TaskStatus | null
}

/** Runs kept per schedule; older firings are pruned on insert. */
const SCHEDULE_RUNS_KEPT = 1000
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
/** A signed-in browser: the row of a session cookie (the token itself is never stored, only its hash). */
export interface WebSession {
    id: string
    created_at: string
    last_seen_at: string
    expires_at: string
    ip: string | null
    user_agent: string | null
}

export type LoginResult = 'ok' | 'failed' | 'locked'

export interface LoginAttempt {
    id: number
    ts: string
    ip: string
    username: string | null
    result: LoginResult
    user_agent: string | null
}

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

/**
 * "Unread" for a conversation `c`: a task finished after the owner last saw
 * the conversation. Seeing it = opening it in the web UI, or the bot
 * delivering the reply to Telegram (a reply that could not be delivered stays
 * unread in the web).
 */
const UNREAD = `EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.conversation_id = c.id AND t.status IN ('done', 'failed')
      AND t.finished_at > COALESCE(c.read_at, '')
)`
/**
 * "Needs a reply": a running task of the conversation waits for the owner
 * (see `Ask`). Exact, not a guess: the CLI paused the agent's tool call and
 * nothing moves until the answer arrives.
 */
const NEEDS_REPLY = `EXISTS (
    SELECT 1 FROM tasks t WHERE t.conversation_id = c.id AND t.status = 'running' AND t.ask IS NOT NULL
)`
/** "Active": a task of the conversation is queued or running (the same test as `chat_active`). */
const ACTIVE = `EXISTS (
    SELECT 1 FROM tasks t WHERE t.conversation_id = c.id AND t.status IN ('queued', 'running')
)`
const CONVERSATION = `c.*, ${UNREAD} AS unread, ${NEEDS_REPLY} AS needs_reply, ${ACTIVE} AS active FROM conversations c`
/** A schedule run with the status of the task it queued, if any. */
const SCHEDULE_RUN = `r.*, t.status AS task_status FROM schedule_runs r LEFT JOIN tasks t ON t.id = r.task_id`

type ConversationRow = Omit<Conversation, 'unread' | 'needs_reply' | 'active'> & { unread: number; needs_reply: number; active: number }
const conversationOf = (row: ConversationRow): Conversation => ({
    ...row,
    unread: Boolean(row.unread),
    needs_reply: Boolean(row.needs_reply),
    active: Boolean(row.active)
})

/** A `tasks` row as SQLite returns it: `ask` is JSON text. */
type TaskRow = Omit<Task, 'ask' | 'attachments' | 'git'> & { ask: string | null; attachments: string | null; git: string | null }
const taskOf = (row: TaskRow): Task => ({
    ...row,
    git: row.git ? (JSON.parse(row.git) as TaskGit) : null,
    ask: row.ask ? (JSON.parse(row.ask) as Ask) : null,
    attachments: row.attachments ? (JSON.parse(row.attachments) as Attachment[]) : null
})
const tasksOf = (rows: TaskRow[]): Task[] => rows.map(taskOf)

export class Store {
    constructor(private readonly db: DatabaseSync) {}

    // ---- conversations ----------------------------------------------------

    findConversation(channel: Channel, externalId: string): Conversation | undefined {
        const row = this.db
            .prepare(`SELECT ${CONVERSATION} WHERE c.channel = ? AND c.external_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 1`)
            .get(channel, externalId) as ConversationRow | undefined
        return row && conversationOf(row)
    }

    getConversation(id: string): Conversation | undefined {
        const row = this.db.prepare(`SELECT ${CONVERSATION} WHERE c.id = ?`).get(id) as ConversationRow | undefined
        return row && conversationOf(row)
    }

    createConversation(channel: Channel, externalId: string | null, title: string | null = null, project: string | null = null): Conversation {
        const ts = now()
        const conversation: Conversation = {
            id: randomUUID(),
            channel,
            external_id: externalId,
            title,
            session_id: null,
            project,
            created_at: ts,
            updated_at: ts,
            deleted_at: null,
            read_at: null,
            unread: false,
            needs_reply: false,
            active: false
        }
        this.db
            .prepare(
                `INSERT INTO conversations (id, channel, external_id, title, session_id, project, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
            )
            .run(conversation.id, channel, externalId, title, project, ts, ts)
        return conversation
    }

    /** The owner has seen the conversation (web UI open, or the reply delivered to Telegram): its finished tasks are read. Not activity: `updated_at` stays. */
    markConversationRead(id: string): void {
        this.db.prepare('UPDATE conversations SET read_at = ? WHERE id = ?').run(now(), id)
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
        return (
            this.db
                .prepare(`SELECT ${CONVERSATION} WHERE c.deleted_at IS NULL ${sql} ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`)
                .all(...(values as never[]), limit) as unknown as ConversationRow[]
        ).map(conversationOf)
    }

    /** Soft delete: hide from the Chat list; the next Telegram message starts a fresh conversation. */
    deleteConversation(id: string): void {
        this.db.prepare('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    }

    // ---- tasks ------------------------------------------------------------

    createTask(
        conversationId: string,
        source: TaskSource,
        prompt: string,
        project: string | null = null,
        schedule: string | null = null,
        model: string | null = null,
        attachments: Attachment[] | null = null
    ): Task {
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
            restarts: 0,
            ask: null,
            schedule,
            model,
            attachments: attachments?.length ? attachments : null,
            not_before: null,
            limit_waits: 0,
            git: null,
            created_at: now(),
            started_at: null,
            finished_at: null
        }
        this.db
            .prepare(
                `INSERT INTO tasks (id, conversation_id, source, prompt, status, project, schedule, model, attachments, created_at)
                 VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
            )
            .run(task.id, conversationId, source, prompt, project, schedule, model, task.attachments ? JSON.stringify(task.attachments) : null, task.created_at)
        return task
    }

    getTask(id: string): Task | undefined {
        const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
        return row && taskOf(row)
    }

    updateTask(id: string, patch: Partial<Omit<Task, 'id'>>): Task {
        const sets: string[] = []
        const values: unknown[] = []
        for (const [key, value] of Object.entries(patch)) {
            sets.push(`${key} = ?`)
            values.push((key === 'ask' || key === 'attachments' || key === 'git') && value !== null ? JSON.stringify(value) : value)
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
        return tasksOf(
            this.db
                .prepare(
                    `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                     ORDER BY created_at DESC, id DESC LIMIT ?`
                )
                .all(...(values as never[])) as unknown as TaskRow[]
        )
    }

    /** Distinct projects tasks have worked in, for filter menus. */
    taskProjects(): string[] {
        const rows = this.db.prepare('SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL ORDER BY project').all() as Array<{ project: string }>
        return rows.map((row) => row.project)
    }

    /**
     * Oldest queued tasks first, one per conversation that has nothing
     * running. A conversation whose oldest queued task waits for a window
     * reset (`not_before` ahead) offers nothing: the later ones keep their turn.
     */
    nextQueuedTasks(at: Date = new Date()): Task[] {
        const due = (task: Task) => !task.not_before || new Date(task.not_before) <= at
        return tasksOf(
            this.db
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
                .all() as unknown as TaskRow[]
        ).filter(due)
    }

    /** The earliest `not_before` among queued tasks still waiting, so the worker knows when to look again. */
    nextWakeUp(): string | null {
        const row = this.db.prepare(`SELECT MIN(not_before) AS at FROM tasks WHERE status = 'queued' AND not_before IS NOT NULL`).get() as { at: string | null }
        return row.at
    }

    /**
     * Tasks left in `running` by a previous supervisor process: their CLI is
     * gone. Those interrupted fewer than `maxRestarts` times go back to the
     * queue (the next run resumes the conversation's session), the rest fail.
     */
    recoverOrphanedTasks(maxRestarts: number): { requeued: Task[]; failed: Task[] } {
        // A pending question died with the CLI: the resumed session asks again if it still needs to.
        const requeued = this.db
            .prepare(
                `UPDATE tasks SET status = 'queued', restarts = restarts + 1, started_at = NULL, ask = NULL
                 WHERE status = 'running' AND restarts < ? RETURNING *`
            )
            .all(maxRestarts) as unknown as TaskRow[]
        const failed = this.db
            .prepare(
                `UPDATE tasks SET status = 'failed', error = 'supervisor restarted while the task was running',
                 finished_at = ?, ask = NULL WHERE status = 'running' RETURNING *`
            )
            .all(now()) as unknown as TaskRow[]
        return { requeued: tasksOf(requeued), failed: tasksOf(failed) }
    }

    /** `dayStart`: when "today" began (ISO), the owner's midnight, not UTC's. */
    stats(dayStart: string): TaskStats {
        const row = this.db
            .prepare(
                `SELECT
                    SUM(status = 'queued')  AS queued,
                    SUM(status = 'running') AS running,
                    SUM(status = 'done'   AND finished_at >= ?) AS done_today,
                    SUM(status = 'failed' AND finished_at >= ?) AS failed_today,
                    SUM(CASE WHEN created_at >= ? THEN tokens ELSE 0 END) AS tokens_today,
                    SUM(tokens) AS tokens_total
                 FROM (
                    SELECT *, input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
                    FROM tasks
                 )`
            )
            .get(dayStart, dayStart, dayStart) as Record<keyof TaskStats, number | null>
        const chat = this.db
            .prepare(
                `SELECT
                    (SELECT COUNT(*) FROM conversations c WHERE c.deleted_at IS NULL AND ${UNREAD}) AS chat_unread,
                    (SELECT COUNT(*) FROM conversations c WHERE c.deleted_at IS NULL AND ${NEEDS_REPLY}) AS chat_needs_reply,
                    (SELECT COUNT(*) FROM tasks t JOIN conversations c ON c.id = t.conversation_id
                      WHERE c.deleted_at IS NULL AND t.status IN ('queued', 'running')) AS chat_active`
            )
            .get() as { chat_unread: number; chat_needs_reply: number; chat_active: number }
        // The newest conversation in each state, so a notification can open the right thread.
        const unreadLatest = this.db
            .prepare(
                `SELECT c.id, c.title FROM conversations c WHERE c.deleted_at IS NULL AND ${UNREAD}
                 ORDER BY (SELECT MAX(t.finished_at) FROM tasks t WHERE t.conversation_id = c.id AND t.status IN ('done', 'failed')) DESC
                 LIMIT 1`
            )
            .get() as ChatRef | undefined
        const askLatest = this.db
            .prepare(
                `SELECT c.id, c.title FROM conversations c WHERE c.deleted_at IS NULL AND ${NEEDS_REPLY}
                 ORDER BY (SELECT MAX(t.created_at) FROM tasks t WHERE t.conversation_id = c.id AND t.status = 'running' AND t.ask IS NOT NULL) DESC
                 LIMIT 1`
            )
            .get() as ChatRef | undefined
        return {
            queued: row.queued ?? 0,
            running: row.running ?? 0,
            done_today: row.done_today ?? 0,
            failed_today: row.failed_today ?? 0,
            chat_unread: chat.chat_unread,
            chat_needs_reply: chat.chat_needs_reply,
            chat_active: chat.chat_active,
            chat_unread_latest: unreadLatest ?? null,
            chat_needs_reply_latest: askLatest ?? null,
            tokens_today: row.tokens_today ?? 0,
            tokens_total: row.tokens_total ?? 0
        }
    }

    // ---- schedules --------------------------------------------------------

    /** The task of a schedule that is still queued or running, if any (one run at a time per schedule). */
    activeScheduleTask(schedule: string): Task | undefined {
        const row = this.db
            .prepare(`SELECT * FROM tasks WHERE schedule = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`)
            .get(schedule) as TaskRow | undefined
        return row && taskOf(row)
    }

    addScheduleRun(run: Omit<ScheduleRun, 'id' | 'task_status'>): ScheduleRun {
        const result = this.db
            .prepare('INSERT INTO schedule_runs (schedule, fired_at, trigger, status, note, items, task_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(run.schedule, run.fired_at, run.trigger, run.status, run.note, run.items, run.task_id, run.duration_ms)
        this.db
            .prepare('DELETE FROM schedule_runs WHERE schedule = ? AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule = ? ORDER BY id DESC LIMIT ?)')
            .run(run.schedule, run.schedule, SCHEDULE_RUNS_KEPT)

        return { ...run, task_status: null, id: Number(result.lastInsertRowid) }
    }

    /** Newest first. By default only the firings that mattered (a task, an error, a missed minute); `all` adds the empty polls and skips. */
    listScheduleRuns(schedule: string, limit = 20, all = false): ScheduleRun[] {
        const filter = all ? '' : "AND r.status NOT IN ('empty', 'skipped')"
        return this.db
            .prepare(`SELECT ${SCHEDULE_RUN} WHERE r.schedule = ? ${filter} ORDER BY r.id DESC LIMIT ?`)
            .all(schedule, limit) as unknown as ScheduleRun[]
    }

    /** The last firing of every schedule, by name; with `withTask`, the last one that queued a task. */
    lastScheduleRuns(withTask = false): Map<string, ScheduleRun> {
        const filter = withTask ? 'AND task_id IS NOT NULL' : ''
        const rows = this.db
            .prepare(`SELECT ${SCHEDULE_RUN} WHERE r.id = (SELECT MAX(id) FROM schedule_runs WHERE schedule = r.schedule ${filter})`)
            .all() as unknown as ScheduleRun[]
        return new Map(rows.map((r) => [r.schedule, r]))
    }

    /** Every schedule name the store remembers (runs or seen items), for cleaning up after a deleted file. */
    scheduleNames(): string[] {
        return (this.db.prepare('SELECT schedule FROM schedule_runs UNION SELECT schedule FROM seen_items').all() as Array<{ schedule: string }>).map((r) => r.schedule)
    }

    /**
     * Earlier versions of an item whose key changes with the item (`<id>@<change time>`,
     * `<pr>@<head sha>`): the schedule handed `<base>@…` over before, so the
     * item is back because it changed — maybe by the agent's own doing.
     */
    seenVariants(schedule: string, base: string): Array<{ key: string; first_seen: string; task_id: string | null }> {
        const escaped = base.replace(/[\\%_]/g, (c) => `\\${c}`)
        return this.db
            .prepare("SELECT key, first_seen, task_id FROM seen_items WHERE schedule = ? AND key LIKE ? ESCAPE '\\' ORDER BY first_seen DESC")
            .all(schedule, `${escaped}@%`) as Array<{ key: string; first_seen: string; task_id: string | null }>
    }
    /** Of the given keys, the ones the schedule already handed to a task (or seeded). */
    seenKeys(schedule: string, keys: string[]): Set<string> {
        const seen = new Set<string>()
        const stmt = this.db.prepare('SELECT 1 FROM seen_items WHERE schedule = ? AND key = ?')
        for (const key of keys) if (stmt.get(schedule, key)) seen.add(key)
        return seen
    }

    seenCount(schedule: string): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM seen_items WHERE schedule = ?').get(schedule) as { n: number }
        return row.n
    }

    markSeen(schedule: string, items: Array<{ key: string; title: string | null }>, taskId: string | null): void {
        const stmt = this.db.prepare('INSERT OR IGNORE INTO seen_items (schedule, key, title, first_seen, task_id) VALUES (?, ?, ?, ?, ?)')
        const ts = now()
        for (const item of items) stmt.run(schedule, item.key, item.title, ts, taskId)
    }

    /** Forget what the schedule has seen: the next run treats every item as new. */
    forgetSeen(schedule: string): number {
        return Number(this.db.prepare('DELETE FROM seen_items WHERE schedule = ?').run(schedule).changes)
    }

    /** A schedule was deleted or renamed: its runs, seen items and marks go with it. */
    dropSchedule(schedule: string): void {
        this.db.prepare('DELETE FROM seen_items WHERE schedule = ?').run(schedule)
        this.db.prepare('DELETE FROM schedule_runs WHERE schedule = ?').run(schedule)
        this.db.prepare('DELETE FROM meta WHERE key LIKE ?').run(`schedule:${schedule}:%`)
    }

    // ---- telegram topics --------------------------------------------------

    /** The conversation a Telegram chat talks to now, if the owner switched it (and it still exists). */
    telegramTopic(chatId: number): Conversation | undefined {
        const row = this.db
            .prepare(`SELECT ${CONVERSATION} JOIN telegram_chats tc ON tc.conversation_id = c.id WHERE tc.chat_id = ? AND c.deleted_at IS NULL`)
            .get(chatId) as ConversationRow | undefined
        return row && conversationOf(row)
    }

    setTelegramTopic(chatId: number, conversationId: string): void {
        this.db
            .prepare('INSERT INTO telegram_chats (chat_id, conversation_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET conversation_id = excluded.conversation_id, updated_at = excluded.updated_at')
            .run(chatId, conversationId, now())
    }

    clearTelegramTopic(chatId: number): void {
        this.db.prepare('DELETE FROM telegram_chats WHERE chat_id = ?').run(chatId)
    }

    /** The chats whose topic is this conversation: where a reply of its tasks goes. */
    telegramChatsFor(conversationId: string): number[] {
        return (this.db.prepare('SELECT chat_id FROM telegram_chats WHERE conversation_id = ?').all(conversationId) as Array<{ chat_id: number }>).map((r) => r.chat_id)
    }

    /** The bot sent a message about a conversation (a reply, a question, an ack): a reply to it later names that conversation. */
    rememberTelegramMessage(chatId: number, messageId: number, conversationId: string, taskId: string | null): void {
        this.db
            .prepare('INSERT OR REPLACE INTO telegram_messages (chat_id, message_id, conversation_id, task_id, sent_at) VALUES (?, ?, ?, ?, ?)')
            .run(chatId, messageId, conversationId, taskId, now())
        this.db.prepare('DELETE FROM telegram_messages WHERE sent_at < ?').run(new Date(Date.now() - 180 * 86_400_000).toISOString())
    }

    telegramMessage(chatId: number, messageId: number): { conversation_id: string; task_id: string | null } | undefined {
        return this.db.prepare('SELECT conversation_id, task_id FROM telegram_messages WHERE chat_id = ? AND message_id = ?').get(chatId, messageId) as
            | { conversation_id: string; task_id: string | null }
            | undefined
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
        return tasksOf(
            this.db
                .prepare(`SELECT * FROM tasks WHERE conversation_id = ? AND status IN ('queued', 'running') ORDER BY created_at ASC`)
                .all(conversationId) as unknown as TaskRow[]
        )
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

    // ---- web sign-in -------------------------------------------------------

    createWebSession(id: string, expiresAt: string, ip: string | null, userAgent: string | null): WebSession {
        const ts = now()
        this.db
            .prepare('INSERT INTO web_sessions (id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, ts, ts, expiresAt, ip, userAgent)
        return { id, created_at: ts, last_seen_at: ts, expires_at: expiresAt, ip, user_agent: userAgent }
    }

    /** A live session by its id (hash); an expired one counts as gone. */
    getWebSession(id: string): WebSession | undefined {
        return this.db.prepare('SELECT * FROM web_sessions WHERE id = ? AND expires_at > ?').get(id, now()) as WebSession | undefined
    }

    /** The session was used: slide its expiry and remember when and from where. */
    touchWebSession(id: string, expiresAt: string, ip: string | null): void {
        this.db.prepare('UPDATE web_sessions SET last_seen_at = ?, expires_at = ?, ip = COALESCE(?, ip) WHERE id = ?').run(now(), expiresAt, ip, id)
    }

    deleteWebSession(id: string): boolean {
        return this.db.prepare('DELETE FROM web_sessions WHERE id = ?').run(id).changes > 0
    }

    /** Sign out everywhere; `except` keeps the current browser signed in. */
    deleteWebSessions(except?: string): number {
        return except === undefined
            ? Number(this.db.prepare('DELETE FROM web_sessions').run().changes)
            : Number(this.db.prepare('DELETE FROM web_sessions WHERE id <> ?').run(except).changes)
    }

    listWebSessions(): WebSession[] {
        return this.db.prepare('SELECT * FROM web_sessions WHERE expires_at > ? ORDER BY last_seen_at DESC').all(now()) as unknown as WebSession[]
    }

    purgeWebSessions(): number {
        return Number(this.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now()).changes)
    }

    addLoginAttempt(ip: string, username: string | null, result: LoginResult, userAgent: string | null): LoginAttempt {
        const ts = now()
        const info = this.db.prepare('INSERT INTO login_attempts (ts, ip, username, result, user_agent) VALUES (?, ?, ?, ?, ?)').run(ts, ip, username, result, userAgent)
        return { id: Number(info.lastInsertRowid), ts, ip, username, result, user_agent: userAgent }
    }

    /** Failed sign-ins since `since`, from one address or (null) from anywhere; `last` is the newest of them. */
    loginFailures(ip: string | null, since: string): { count: number; last: string | null } {
        const row = (
            ip === null
                ? this.db.prepare(`SELECT COUNT(*) AS count, MAX(ts) AS last FROM login_attempts WHERE result = 'failed' AND ts > ?`).get(since)
                : this.db.prepare(`SELECT COUNT(*) AS count, MAX(ts) AS last FROM login_attempts WHERE result = 'failed' AND ip = ? AND ts > ?`).get(ip, since)
        ) as { count: number; last: string | null }
        return { count: Number(row.count), last: row.last }
    }

    listLoginAttempts(limit = 50): LoginAttempt[] {
        return this.db.prepare('SELECT * FROM login_attempts ORDER BY id DESC LIMIT ?').all(limit) as unknown as LoginAttempt[]
    }

    purgeLoginAttempts(before: string): number {
        return Number(this.db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(before).changes)
    }
}
