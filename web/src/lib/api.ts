import { activeHeaders } from './activity'

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** One question of an `AskUserQuestion` call. */
export interface AskQuestion {
    question: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
}

/**
 * What a running task waits for from the owner: the agent's `AskUserQuestion`
 * (kind `question`) or a permission request for another tool. Answered with
 * `api.answerTask`; the task stays `running` meanwhile.
 */
export interface Ask {
    kind: 'question' | 'permission'
    request_id: string
    tool_use_id: string
    tool_name: string
    /** `{ questions: AskQuestion[] }` for a question, the tool's arguments for a permission. */
    input: Record<string, unknown>
    /** Answers given so far, by question text (Telegram answers one question at a time). */
    answers: Record<string, string>
    agent: string | null
    asked_at: string
}

export interface Task {
    id: string
    conversation_id: string
    source: 'telegram' | 'web' | 'cron' | 'webhook'
    prompt: string
    status: TaskStatus
    session_id: string | null
    result: string | null
    error: string | null
    num_turns: number
    /** CLI list-price estimate, kept for the record; never shown. */
    cost_usd: number
    duration_ms: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    /** Share of the 5-hour window this task consumed (0..1), null when unknown. */
    window_5h_delta: number | null
    /** Workspace the task worked in, detected from its tool calls or set on the conversation. */
    project: string | null
    /** Supervisor restarts that interrupted the task; it is re-queued once, then fails. */
    restarts: number
    /** What the task waits for from the owner; null while nothing is pending. */
    ask: Ask | null
    /** The schedule that queued the task; null for the owner's own tasks. */
    schedule: string | null
    /** Files the owner sent with the message; their paths reached the agent after the prompt. */
    attachments: Attachment[] | null
    /** A queued task waits for the subscription window to reset and starts after this time. */
    not_before: string | null
    /** How many times the task went back to the queue to wait for a window reset. */
    limit_waits: number
    /** What the task changed in its project's checkout; null outside a project. */
    git: TaskGit | null
    created_at: string
    started_at: string | null
    finished_at: string | null
}

export interface PullRequest {
    number: number
    url: string
    state: string
    title: string
    isDraft?: boolean
}

/** A task's changes: where it started and, once it ended, the branch and the range `base..head` with its size. */
export interface TaskGit {
    start_head: string
    start_branch: string | null
    branch?: string | null
    head?: string
    base?: string
    default_branch?: string | null
    files?: number
    added?: number
    removed?: number
    uncommitted?: number
    pr?: PullRequest | null
}

export interface ChangedFile {
    path: string
    from?: string
    status: string
    added: number
    removed: number
    binary: boolean
    generated: boolean
}

/** "7 files +210 −40", or null when nothing changed. */
export const changesText = (g: TaskGit | null) =>
    g?.files ? `${g.files} file${g.files === 1 ? '' : 's'} +${g.added ?? 0} −${g.removed ?? 0}` : null

/** A file sent with a message, saved in the factory's inbox. */
export interface Attachment {
    name: string
    path: string
    type: string
    size: number
}

/** Raster images the thread previews inline (the server serves only these inline). */
export const isImage = (a: Attachment) => /^image\/(png|jpeg|gif|webp)$/.test(a.type)

export const attachmentUrl = (conversationId: string, a: Attachment) =>
    `/api/conversations/${conversationId}/attachments/${encodeURIComponent(a.name)}`

export interface TaskEvent {
    id: number
    task_id: string
    ts: string
    type: 'text' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'llm' | 'agent' | 'limits' | 'ask' | 'answer'
    payload: Record<string, unknown>
    /** Sub-agent type that produced the event; null for the orchestrator. */
    agent: string | null
    parent_tool_use_id: string | null
}

export interface AuditEvent extends TaskEvent {
    project: string | null
    conversation_id: string
    session_id: string | null
}

export type AuditPeriod = '1h' | '24h' | '7d' | '30d' | 'all'
export type AuditKind = 'all' | 'llm' | 'tools' | 'files' | 'agents' | 'sessions' | 'limits'

export interface AgentActivity {
    /** null = the orchestrator. */
    agent: string | null
    runs: number
    running: number
    tokens: number
    last_active: string | null
}

export interface Audit {
    events: AuditEvent[]
    has_more: boolean
    stats: { events: number; agents: number; tasks: number; tokens: number }
    facets: { agents: string[]; projects: string[] }
}

/** Keyset cursor of a list: the timestamp the list is sorted by plus the row's id, to break ties. */
export interface Cursor {
    ts: string
    id: string
}

const cursorParams = (params: URLSearchParams, before?: Cursor) => {
    if (before) {
        params.set('before', before.ts)
        params.set('before_id', before.id)
    }
    return params
}

export interface Conversation {
    id: string
    channel: 'telegram' | 'web'
    external_id: string | null
    title: string | null
    session_id: string | null
    project: string | null
    created_at: string
    updated_at: string
    deleted_at: string | null
    /** When the owner last opened it in the web UI; null = never. */
    read_at: string | null
    /** A task finished after `read_at`: its reply was neither opened here nor delivered to Telegram. */
    unread: boolean
    /** A running task waits for the owner: a question or a permission request. */
    needs_reply: boolean
    /** A task of the conversation is queued or running. */
    active: boolean
}

export interface ConversationHistory {
    /** Oldest first. */
    tasks: Task[]
    events: TaskEvent[]
    has_more: boolean
}

export interface ConversationDetail extends Conversation, ConversationHistory {}

export interface Stats {
    queued: number
    running: number
    done_today: number
    failed_today: number
    tokens_today: number
    tokens_total: number
    /** Conversations with a reply the owner has not seen. */
    chat_unread: number
    /** Conversations whose agent waits for the owner's answer. */
    chat_needs_reply: number
    /** Queued or running tasks of conversations in the Chat list. */
    chat_active: number
    /** The newest conversation in each state: where a notification click lands. */
    chat_unread_latest: { id: string; title: string | null } | null
    chat_needs_reply_latest: { id: string; title: string | null } | null
    schedules: {
        total: number
        on: number
        /** Files that cannot fire (bad cron, unknown project). */
        invalid: number
        /** Schedules whose last firing was a prefilter error. */
        failing: string[]
        /** Schedules whose last firing was a minute the factory slept through. */
        missed: string[]
        next: { name: string; at: string } | null
    }
}

export interface RateLimitWindow {
    /** Share used, 0..1. */
    used: number
    resets_at: string
}

/** Subscription rate-limit status as the CLI last reported it. */
export interface RateLimits {
    id: number
    ts: string
    task_id: string | null
    status: 'allowed' | 'allowed_warning' | 'rejected' | (string & {})
    five_hour: RateLimitWindow | null
    seven_day: RateLimitWindow | null
}

export interface Status {
    /** The factory's own version (root `package.json`, see CHANGELOG.md). */
    version: string
    stats: Stats
    running: string[]
    limits: RateLimits | null
    claude: {
        version: string | null
        /** The orchestrator's model alias, one for the whole factory (Settings, Telegram `/model`). */
        model: string
        permission_mode: string
        max_turns: number
        config_dir: string
        logged_in: boolean
        /** `claude.ai (…)` for a full login in the container, `token` for CLAUDE_CODE_OAUTH_TOKEN, `none`. */
        login: string
    }
    /** `token`: the fallback GH_TOKEN is set; `owners`: owners with a token of their own. */
    github: { cli: string | null; token: boolean; owners: string[] }
    git: { version: string | null }
    telegram: { enabled: boolean; allowed_user_ids: number[] }
    stt: { enabled: boolean; model: string; language: string | null }
    paths: { data: string; workspaces: string; config: string }
    max_concurrent_sessions: number
    workspaces: Array<{ name: string; git: boolean }>
}

export type Kind = 'agents' | 'skills' | 'projects' | 'schedules'

export interface CatalogEntry {
    kind: Kind
    name: string
    path: string
    frontmatter: Record<string, unknown>
    body: string
    updated_at: string
    size: number
}

export interface SessionSummary {
    session_id: string
    /** Claude Code's slug for the cwd ('/' → '-'); lossy, shown only as a fallback. */
    workspace: string
    cwd: string | null
    /** cwd relative to the workspaces root: a repo name, '.' for the root, or an absolute path outside it. */
    project: string | null
    path: string
    started_at: string
    updated_at: string
    size: number
    first_prompt: string | null
    task_id: string | null
    conversation_id: string | null
}

export interface TranscriptEntry {
    uuid?: string
    type: string
    timestamp?: string
    isSidechain?: boolean
    agentId?: string
    message?: {
        role?: string
        model?: string
        content?: string | Array<Record<string, unknown>>
        usage?: Record<string, number>
    }
    summary?: string
}

export interface SessionDetail extends SessionSummary {
    /** A window of the transcript; `offset` is the index of its first entry. */
    entries: TranscriptEntry[]
    offset: number
    stats: { total: number; messages: number; tokens_in: number; tokens_out: number }
}

export interface McpServer {
    name: string
    type: string
    target: string
    /** `${VAR}` references in the server's config and whether each is set for the supervisor. */
    variables: Array<{ name: string; set: boolean }>
    /** The claude.ai connector with the same URL, when there is one: that connector serves every session already. */
    connector?: string | null
}

export interface McpStatus {
    name: string
    status: string
    source: string | null
}

/** A server as written in mcp.json; header / env values the API withheld read `<kept>`. */
export interface McpServerConfig {
    type?: 'http' | 'sse' | 'stdio'
    url?: string
    command?: string
    args?: string[]
    headers?: Record<string, string>
    env?: Record<string, string>
}

/** A server in the factory's registry: the claude.ai connectors, plugins, project servers and the owner's own, with the last status the CLI reported. */
export interface McpEntry {
    key: string
    name: string
    label: string
    /** `connector`, `plugin`, `project:<slug>`, `factory`, or the CLI's own word. */
    source: string | null
    /** `connected`, `needs-auth`, `failed`, `unknown`. */
    status: string
    seen_at: string | null
    /** The URL or command as `claude mcp list` printed it (null until a refresh). */
    target: string | null
    /** Number of tools the server exposes (0 while it needs authentication). */
    tools: number
    /** The key of the connector with the same URL: this entry is that server under a project's or the factory's name. */
    duplicate_of: string | null
}

/** A sign-in to an MCP server started from the UI (`claude mcp login` in the factory). */
export interface McpLogin {
    id: string
    name: string
    /** `connector`: authorize on claude.ai, nothing to paste; `redirect`: paste the redirect URL back; null until known. */
    mode: 'connector' | 'redirect' | null
    state: 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled'
    url: string | null
    message: string | null
    started_at: string
}

export interface McpOverview {
    servers: McpEntry[]
    /** What each project's checkout declares in `.mcp.json` (for the project form's `mcp:` allowlist). */
    projects: Array<{ slug: string; servers: McpServer[]; error: string | null }>
    global: { file: string; servers: McpServer[]; config: Record<string, McpServerConfig>; error: string | null }
}

/** Tool names for an agent's `tools:`: common ones, the rest the CLI reported, and MCP tools grouped by server. */
export interface ToolList {
    common: string[]
    reported: string[]
    /** One entry per MCP server the factory has seen (claude.ai connectors, plugins, project servers, the owner's own); `tools` are full names, empty while the server needs authentication. */
    mcp: Array<{ server: string; label: string; source: string | null; status: string; tools: string[] }>
    source: 'cli' | 'default'
}

/** A shared SSH host (`data/config/hosts.yaml`): the connection once, picked by any project. */
export interface SharedHost {
    name: string
    /** user@host or user@host:port. */
    ssh: string
    /** File name of the private key in data/secrets/ssh; empty = ssh's own defaults. */
    key?: string
}

/** A project's entry under `hosts:`: a shared host by name plus the project's own path and notes on that server. */
export interface HostRef {
    host: string
    path?: string
    notes?: string
}

/** A host written out inside a project file (the form before 2026-09-30). */
export interface InlineHost {
    name?: string
    ssh?: string
    key?: string
    path?: string
    notes?: string
}

export type ProjectHost = HostRef | InlineHost

export const isHostRef = (h: ProjectHost): h is HostRef => typeof (h as HostRef).host === 'string'

/** A project or schedule file that refers to a shared host, with what it adds there. */
export interface HostUsage {
    project: string
    kind: 'project' | 'schedule'
    path?: string
    notes?: string
}

export interface HostView extends SharedHost {
    /** Projects that refer to this host, with what they add to it. */
    projects: HostUsage[]
}

export interface InlineHostView {
    project: string
    index: number
    host: InlineHost
    /** A shared host with the same target and key, if there is one. */
    same_as: string | null
}

export interface HostsOverview {
    file: string
    hosts: HostView[]
    inline: InlineHostView[]
    error: string | null
}

export interface SshKeys {
    dir: string
    keys: Array<{ name: string; public: boolean }>
    /** The factory's known_hosts file (data/config/known_hosts), written from the UI via `trustHost`. */
    known_hosts: string
}

/** One key a server offers, as `ssh-keyscan` saw it. */
export interface HostKey {
    type: string
    fingerprint: string
    line: string
}

export interface HostTest {
    ok: boolean
    output: string
    ms: number
    /** The server is not in known_hosts yet, or its key changed since: the UI can settle it with `keyscanHost` + `trustHost`. */
    host_key?: 'unknown' | 'changed'
}

export type HostTarget = { ssh: string; key?: string } | { name: string }

/** One firing of a schedule, as the scheduler recorded it. */
export interface ScheduleRun {
    id: number
    schedule: string
    fired_at: string
    trigger: 'cron' | 'manual'
    /** `queued`: a task was created; `empty`: nothing new; `skipped`: not attempted (run in progress, soft-stop); `error`: the prefilter failed; `missed`: the factory was off at the minute. */
    status: 'queued' | 'empty' | 'skipped' | 'error' | 'missed'
    note: string | null
    items: number
    task_id: string | null
    duration_ms: number
    /** How the task ended (or where it is), when the run queued one. */
    task_status: TaskStatus | null
}

/** What the scheduler knows about a schedule file beyond its text. */
export interface ScheduleView {
    name: string
    enabled: boolean
    /** What stops it from firing (bad cron, unknown project, …). */
    errors: string[]
    warnings: string[]
    cron: string | null
    cron_text: string | null
    tz: string | null
    window: { days: number[] | null; hours: string | null } | null
    project: string | null
    prefilter: string | null
    notify: 'telegram' | 'none' | null
    session: 'fresh' | 'continue' | null
    /** Switches itself off after queueing one task. */
    once: boolean
    /** Pinned model alias for the runs; null = the factory's current one. */
    model: string | null
    next_run: string | null
    last_run: ScheduleRun | null
    /** The last firing that queued a task, with that task's status. */
    last_task: ScheduleRun | null
    active_task: { id: string; status: TaskStatus; created_at: string } | null
    conversation_id: string | null
    /** Prefilter items handed over (or seeded) so far. */
    seen: number
}

export type CronCheck =
    { ok: true; text: string; next: string | null; tz: string } | { ok: false; error: string; tz: string }

export interface PrefilterItem {
    key: string
    title: string
    text?: string
    url?: string
    /** An earlier version of the item was handed over then; it is back because it changed. */
    seen_before?: string
}

export interface SchedulePreview {
    items: PrefilterItem[]
    new_keys: string[]
    ms: number
}

export interface Preset {
    name: string
    title: string
    description: string
    tags: string[]
    files: Array<{ kind: Kind; name: string; description: string | null; installed: boolean }>
    readme: string | null
    /** Every file is on the volume. */
    installed: boolean
}

/** Who the browser is to the API: the sign-in mode, whether this browser is signed in, and the lock policy. */
export interface AuthState {
    /** `password`: sign-in required (WEB_AUTH_PASSWORD set); `open`: no password, whoever reaches the port is the owner. */
    mode: 'password' | 'open'
    authenticated: boolean
    user: string | null
    session: { created_at: string; ip: string | null } | null
    policy: { max_failures: number; lock_minutes: number; session_days: number; idle_hours: number }
}

export interface WebSession {
    id: string
    created_at: string
    last_seen_at: string
    expires_at: string
    ip: string | null
    user_agent: string | null
    current: boolean
}

export interface LoginAttempt {
    id: number
    ts: string
    ip: string
    username: string | null
    result: 'ok' | 'failed' | 'locked'
    user_agent: string | null
}

/** Dispatched on `window` when the API answers 401: the session is gone, the sign-in page takes over. */
export const UNAUTHORIZED = 'pf:unauthorized'

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
        /** The JSON the API answered with, when it did (a sign-in refusal says how many attempts are left). */
        public body: unknown = null
    ) {
        super(message)
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...activeHeaders(), ...(init?.headers ?? {}) }
    })
    if (response.status === 204) return undefined as T
    const text = await response.text()
    let body: unknown = null
    try {
        body = text ? JSON.parse(text) : null
    } catch {
        // not JSON: an HTML login page from a proxy in front, or a crashed server
    }
    if (!response.ok) {
        // A session that lapsed or was revoked: the whole UI goes back to the sign-in page, not one widget to an error.
        if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED))
        throw new ApiError(
            response.status,
            (body as { error?: string } | null)?.error ?? `${response.status} ${response.statusText}`,
            body
        )
    }
    // A 200 that is not JSON must not become `{}`: every screen would then throw on a missing field.
    if (body === null)
        throw new ApiError(
            response.status,
            'The API returned something other than JSON — a proxy login page? Reload and sign in.'
        )
    return body as T
}

const targetBody = (target: HostTarget) =>
    'name' in target ? target : { ssh: target.ssh, key: target.key || undefined }

export const api = {
    auth: {
        me: () => request<AuthState>('/auth/me'),
        login: (username: string, password: string) =>
            request<{ ok: true; user: string }>('/auth/login', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            }),
        logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
        logoutOthers: () => request<{ signed_out: number }>('/auth/logout-others', { method: 'POST' }),
        sessions: () => request<WebSession[]>('/auth/sessions'),
        revokeSession: (id: string) => request<{ revoked: boolean }>(`/auth/sessions/${id}`, { method: 'DELETE' }),
        log: (limit = 50) => request<LoginAttempt[]>(`/auth/log?limit=${limit}`)
    },
    status: () => request<Status>('/status'),
    /** Newest first, one page; pass `before` = the last task shown for the next. */
    tasks: (q: { status?: TaskStatus; project?: string; before?: Cursor; limit?: number } = {}) => {
        const params = cursorParams(new URLSearchParams(), q.before)
        if (q.status) params.set('status', q.status)
        if (q.project) params.set('project', q.project)
        if (q.limit) params.set('limit', String(q.limit))
        const qs = params.toString()
        return request<Task[]>(`/tasks${qs ? `?${qs}` : ''}`)
    },
    taskProjects: () => request<string[]>('/tasks/projects'),
    task: (id: string) => request<Task & { events: TaskEvent[]; conversation: Conversation }>(`/tasks/${id}`),
    stopTask: (id: string) => request<{ stopped: boolean }>(`/tasks/${id}/stop`, { method: 'POST' }),
    taskChanges: (id: string) =>
        request<{ git: TaskGit; files: ChangedFile[]; pr: PullRequest | null }>(`/tasks/${id}/changes`),
    taskChangeFile: (id: string, path: string) =>
        request<{ patch: string; truncated: boolean }>(`/tasks/${id}/changes/file?path=${encodeURIComponent(path)}`),
    createPullRequest: (id: string) => request<PullRequest>(`/tasks/${id}/pr`, { method: 'POST' }),
    /** Answer what a running task asked: `{ answers }` by question text, or `{ behavior: 'allow' | 'deny' }` for a permission. */
    answerTask: (
        id: string,
        body: { answers: Record<string, string> } | { behavior: 'allow' } | { behavior: 'deny'; message?: string }
    ) => request<Task>(`/tasks/${id}/answer`, { method: 'POST', body: JSON.stringify(body) }),

    audit: (q: { period: AuditPeriod; kind: AuditKind; agent?: string; project?: string; before?: number }) => {
        const params = new URLSearchParams({ period: q.period, kind: q.kind })
        if (q.agent) params.set('agent', q.agent)
        if (q.project) params.set('project', q.project)
        if (q.before) params.set('before', String(q.before))
        return request<Audit>(`/audit?${params}`)
    },

    agentActivity: (period: AuditPeriod = '7d') => request<AgentActivity[]>(`/activity/agents?period=${period}`),

    /** Tool names the CLI offers (from its last session start), or a built-in default list. */
    tools: () => request<ToolList>('/tools'),

    probeUsage: () => request<RateLimits>('/usage/probe', { method: 'POST' }),

    conversations: (before?: Cursor, limit = 50) =>
        request<Conversation[]>(
            `/conversations?${cursorParams(new URLSearchParams({ limit: String(limit) }), before)}`
        ),
    conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
    deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: 'DELETE' }),
    /** The conversation is on screen: clears its `unread` flag. */
    markConversationRead: (id: string) => request<void>(`/conversations/${id}/read`, { method: 'POST' }),
    /** Tasks before the given one (the oldest shown), with their events. */
    conversationHistory: (id: string, before: Cursor) =>
        request<ConversationHistory>(`/conversations/${id}/history?${cursorParams(new URLSearchParams(), before)}`),
    /** `project` binds the conversation to a checkout: its tasks run there, with the repository's MCP servers and agents. */
    createConversation: (title?: string, project?: string | null) =>
        request<Conversation>('/conversations', {
            method: 'POST',
            body: JSON.stringify({ title, project: project || undefined })
        }),
    /** Rebind (or unbind with null); refused while a task runs. The Claude Code session restarts in the new directory. */
    setConversationProject: (id: string, project: string | null) =>
        request<Conversation>(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ project }) }),
    mcp: () => request<McpOverview>('/mcp'),
    /** Runs `claude mcp list` in the factory (about 15 s) and returns the registry with fresh statuses. */
    refreshMcp: () => request<{ servers: McpEntry[] }>('/mcp/refresh', { method: 'POST' }),
    startMcpLogin: (name: string) =>
        request<{ login: McpLogin }>('/mcp/login', { method: 'POST', body: JSON.stringify({ name }) }),
    mcpLogin: (id: string) => request<{ login: McpLogin }>(`/mcp/login/${encodeURIComponent(id)}`),
    completeMcpLogin: (id: string, url: string) =>
        request<{ login: McpLogin }>(`/mcp/login/${encodeURIComponent(id)}/complete`, {
            method: 'POST',
            body: JSON.stringify({ url })
        }),
    cancelMcpLogin: (id: string) => request<void>(`/mcp/login/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** The orchestrator's model for every next task, in every conversation; sub-agents keep the `model:` of their files. */
    setModel: (model: string) =>
        request<{ model: string; aliases: string[] }>('/settings/model', {
            method: 'PUT',
            body: JSON.stringify({ model })
        }),
    saveMcp: (mcpServers: Record<string, McpServerConfig>) =>
        request<{ saved: number }>('/mcp/global', { method: 'PUT', body: JSON.stringify({ mcpServers }) }),
    sendMessage: (id: string, prompt: string, attachments: string[] = []) =>
        request<Task>(`/conversations/${id}/messages`, {
            method: 'POST',
            body: JSON.stringify({ prompt, attachments })
        }),
    /** One file for the next message of the conversation; the reply names it for `sendMessage`. */
    uploadAttachment: (id: string, file: File) =>
        request<Attachment>(`/conversations/${id}/attachments?name=${encodeURIComponent(file.name || 'pasted.png')}`, {
            method: 'POST',
            body: file,
            headers: { 'content-type': file.type || 'application/octet-stream' }
        }),

    list: (kind: Kind) => request<CatalogEntry[]>(`/${kind}`),
    /** `create` refuses to replace a file that already exists (409); `updated_at` (the version the form edited) refuses to overwrite a newer file (409). */
    save: (
        kind: Kind,
        name: string,
        doc: { frontmatter: Record<string, unknown>; body: string; updated_at?: string },
        create = false
    ) =>
        request<CatalogEntry>(`/${kind}/${encodeURIComponent(name)}${create ? '?create=1' : ''}`, {
            method: 'PUT',
            body: JSON.stringify(doc)
        }),
    remove: (kind: Kind, name: string) => request<void>(`/${kind}/${encodeURIComponent(name)}`, { method: 'DELETE' }),

    sessions: (before?: Cursor, limit = 50) =>
        request<SessionSummary[]>(`/sessions?${cursorParams(new URLSearchParams({ limit: String(limit) }), before)}`),
    /** A window of `limit` entries ending before index `before` (default: the end of the transcript). */
    session: (id: string, before?: number, limit = 200) =>
        request<SessionDetail>(`/sessions/${id}?limit=${limit}${before ? `&before=${before}` : ''}`),

    /** Names of the SSH keys in data/secrets/ssh (never their contents). */
    sshKeys: () => request<SshKeys>('/hosts/keys'),
    /** `ssh -o BatchMode=yes user@host echo ok` with the chosen key, or for a shared host by name. */
    testHost: (target: HostTarget) =>
        request<HostTest>('/hosts/test', { method: 'POST', body: JSON.stringify(targetBody(target)) }),
    /** The keys the server offers, with fingerprints to compare before trusting. */
    keyscanHost: (target: HostTarget) =>
        request<{ host: string; port: string | null; known: boolean; keys: HostKey[] }>('/hosts/keyscan', {
            method: 'POST',
            body: JSON.stringify(targetBody(target))
        }),
    /** Write the scanned lines into the factory's known_hosts; `replace` drops the server's old entries first. */
    trustHost: (target: HostTarget, lines: string[], replace: boolean) =>
        request<{ file: string }>('/hosts/trust', {
            method: 'POST',
            body: JSON.stringify({ ...targetBody(target), lines, replace })
        }),
    /** The shared hosts with the projects using each, plus hosts still written inside project files. */
    hosts: () => request<HostsOverview>('/hosts'),
    /** Create or update a shared host; a different `name` in the body renames it and the projects follow. `create` refuses to replace an existing name (409). */
    saveHost: (name: string, host: Omit<SharedHost, 'name'> & { name?: string }, create = false) =>
        request<HostView>(`/hosts/${encodeURIComponent(name)}${create ? '?create=1' : ''}`, {
            method: 'PUT',
            body: JSON.stringify(host)
        }),
    /** Remove a shared host; `detach` also drops it from the projects that use it (refused otherwise). */
    deleteHost: (name: string, detach = false) =>
        request<void>(`/hosts/${encodeURIComponent(name)}${detach ? '?detach=1' : ''}`, { method: 'DELETE' }),

    schedules: () => request<ScheduleView[]>('/schedules/status'),
    /** A cron expression read back: valid or not, in words, next firing in the factory's zone. */
    checkCron: (expr: string) => request<CronCheck>(`/schedules/cron?expr=${encodeURIComponent(expr)}`),
    schedule: (name: string) => request<ScheduleView>(`/schedules/${encodeURIComponent(name)}/status`),
    /** The firings that mattered (a task, an error, a missed minute); `all` adds the empty polls and skips. */
    scheduleRuns: (name: string, limit = 30, all = false) =>
        request<ScheduleRun[]>(`/schedules/${encodeURIComponent(name)}/runs?limit=${limit}${all ? '&all=1' : ''}`),
    /** Fire now: ignores the cron, the window and the soft-stop; never overlaps a run in progress. */
    runSchedule: (name: string) =>
        request<ScheduleRun>(`/schedules/${encodeURIComponent(name)}/run`, { method: 'POST' }),
    /** Run the prefilter and show what it finds without marking anything. */
    previewSchedule: (name: string) =>
        request<SchedulePreview>(`/schedules/${encodeURIComponent(name)}/preview`, { method: 'POST' }),
    enableSchedule: (name: string, enabled: boolean) =>
        request<ScheduleView>(`/schedules/${encodeURIComponent(name)}/enabled`, {
            method: 'PUT',
            body: JSON.stringify({ enabled })
        }),
    forgetScheduleSeen: (name: string) =>
        request<{ forgotten: number }>(`/schedules/${encodeURIComponent(name)}/seen`, { method: 'DELETE' }),

    presets: () => request<Preset[]>('/presets'),
    installPreset: (name: string, overwrite = false) =>
        request<{ installed: Preset['files'] }>(`/presets/${name}/install`, {
            method: 'POST',
            body: JSON.stringify({ overwrite })
        })
}

/**
 * Subscribe to a conversation's live feed. Returns an unsubscribe function.
 * Reconnects by hand rather than through EventSource's own retry, so each
 * connection asks for events after the last one seen instead of replaying
 * from the original `after` every time; `onReconnect` lets the caller
 * refetch what a stream cannot replay (task rows that changed meanwhile).
 */
export function streamConversation(
    id: string,
    after: () => number,
    handlers: { onTask?: (task: Task) => void; onEvent?: (event: TaskEvent) => void; onReconnect?: () => void }
): () => void {
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let connections = 0
    const open = () => {
        if (closed) return
        source = new EventSource(`/api/conversations/${id}/stream?after=${after()}`)
        source.addEventListener('task', (e) => handlers.onTask?.(JSON.parse(e.data as string) as Task))
        source.addEventListener('event', (e) => handlers.onEvent?.(JSON.parse(e.data as string) as TaskEvent))
        source.onopen = () => {
            if (connections++ > 0) handlers.onReconnect?.()
        }
        source.onerror = () => {
            source?.close()
            source = null
            timer = setTimeout(open, 3000)
        }
    }
    open()
    return () => {
        closed = true
        clearTimeout(timer)
        source?.close()
    }
}

/** Every token the task sent or received, cache included — what the subscription meters. */
export const taskTokens = (
    t: Pick<Task, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>
) => t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens

/** A finished task's recorded wall-clock; a running one is timed from its start, so the figure moves between polls. */
export const taskDuration = (t: Pick<Task, 'status' | 'started_at' | 'duration_ms'>, now = Date.now()) =>
    t.status === 'running' && t.started_at ? Math.max(t.duration_ms, now - Date.parse(t.started_at)) : t.duration_ms

export const fmt = {
    /** "1 run", "3 runs". */
    plural: (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`,
    tokens: (n: number) =>
        n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n),
    pct: (share: number) => `${Math.round(share * 100)}%`,
    /** A task's share of the 5-hour window: "+3% of 5h", "<1% of 5h" or null. */
    windowDelta: (share: number | null) =>
        share === null ? null : share < 0.01 ? '<1% of 5h' : `+${Math.round(share * 100)}% of 5h`,
    /** Time left until an ISO timestamp: "2h 15m", "3d", "now". */
    until: (iso: string) => {
        const ms = new Date(iso).getTime() - Date.now()
        if (ms <= 0) return 'now'
        const h = Math.floor(ms / 3_600_000)
        const m = Math.floor((ms % 3_600_000) / 60_000)
        if (h >= 48) return `${Math.round(h / 24)}d`
        return h > 0 ? `${h}h ${m}m` : `${m}m`
    },
    /** "4s", "2m 5s", "1h 23m 10s": whole seconds first, so 1m 59.6s is "2m 0s" and never "1m 60s". */
    duration: (ms: number) => {
        const total = Math.max(0, Math.round(ms / 1000))
        const h = Math.floor(total / 3600)
        const m = Math.floor((total % 3600) / 60)
        const s = total % 60
        return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
    },
    when: (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—'),
    ago: (iso: string | null) => {
        if (!iso) return '—'
        const diff = Date.now() - new Date(iso).getTime()
        if (diff < 60_000) return 'just now'
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
        return `${Math.floor(diff / 86_400_000)} d ago`
    },
    bytes: (n: number) =>
        n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`
}
