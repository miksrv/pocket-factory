export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

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
    created_at: string
    started_at: string | null
    finished_at: string | null
}

export interface TaskEvent {
    id: number
    task_id: string
    ts: string
    type: 'text' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'llm' | 'agent' | 'limits'
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
    /** Queued or running tasks of conversations in the Chat list. */
    chat_active: number
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
    status: 'allowed' | 'allowed_warning' | 'rejected' | string
    five_hour: RateLimitWindow | null
    seven_day: RateLimitWindow | null
}

export interface Status {
    stats: Stats
    running: string[]
    limits: RateLimits | null
    claude: {
        version: string | null
        model: string | null
        permission_mode: string
        max_turns: number
        max_budget_usd: number
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

export type Kind = 'agents' | 'skills' | 'projects'

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

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message)
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
    })
    if (response.status === 204) return undefined as T
    const text = await response.text()
    let body: unknown = null
    try {
        body = text ? JSON.parse(text) : null
    } catch {
        // not JSON: an HTML login page from a proxy in front, or a crashed server
    }
    if (!response.ok) throw new ApiError(response.status, (body as { error?: string } | null)?.error ?? `${response.status} ${response.statusText}`)
    // A 200 that is not JSON must not become `{}`: every screen would then throw on a missing field.
    if (body === null) throw new ApiError(response.status, 'The API returned something other than JSON — a proxy login page? Reload and sign in.')
    return body as T
}

export const api = {
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

    conversations: (before?: Cursor, limit = 50) => request<Conversation[]>(`/conversations?${cursorParams(new URLSearchParams({ limit: String(limit) }), before)}`),
    conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
    deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: 'DELETE' }),
    /** The conversation is on screen: clears its `unread` flag. */
    markConversationRead: (id: string) => request<void>(`/conversations/${id}/read`, { method: 'POST' }),
    /** Tasks before the given one (the oldest shown), with their events. */
    conversationHistory: (id: string, before: Cursor) => request<ConversationHistory>(`/conversations/${id}/history?${cursorParams(new URLSearchParams(), before)}`),
    /** `project` binds the conversation to a checkout: its tasks run there, with the repository's MCP servers and agents. */
    createConversation: (title?: string, project?: string | null) =>
        request<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ title, project: project || undefined }) }),
    /** Rebind (or unbind with null); refused while a task runs. The Claude Code session restarts in the new directory. */
    setConversationProject: (id: string, project: string | null) => request<Conversation>(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ project }) }),
    mcp: () => request<McpOverview>('/mcp'),
    /** Runs `claude mcp list` in the factory (about 15 s) and returns the registry with fresh statuses. */
    refreshMcp: () => request<{ servers: McpEntry[] }>('/mcp/refresh', { method: 'POST' }),
    startMcpLogin: (name: string) => request<{ login: McpLogin }>('/mcp/login', { method: 'POST', body: JSON.stringify({ name }) }),
    mcpLogin: (id: string) => request<{ login: McpLogin }>(`/mcp/login/${encodeURIComponent(id)}`),
    completeMcpLogin: (id: string, url: string) => request<{ login: McpLogin }>(`/mcp/login/${encodeURIComponent(id)}/complete`, { method: 'POST', body: JSON.stringify({ url }) }),
    cancelMcpLogin: (id: string) => request<void>(`/mcp/login/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    saveMcp: (mcpServers: Record<string, McpServerConfig>) => request<{ saved: number }>('/mcp/global', { method: 'PUT', body: JSON.stringify({ mcpServers }) }),
    sendMessage: (id: string, prompt: string) =>
        request<Task>(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt }) }),

    list: (kind: Kind) => request<CatalogEntry[]>(`/${kind}`),
    /** `create` refuses to replace a file that already exists (409). */
    save: (kind: Kind, name: string, doc: { frontmatter: Record<string, unknown>; body: string }, create = false) =>
        request<CatalogEntry>(`/${kind}/${encodeURIComponent(name)}${create ? '?create=1' : ''}`, { method: 'PUT', body: JSON.stringify(doc) }),
    remove: (kind: Kind, name: string) => request<void>(`/${kind}/${encodeURIComponent(name)}`, { method: 'DELETE' }),

    sessions: (before?: Cursor, limit = 50) => request<SessionSummary[]>(`/sessions?${cursorParams(new URLSearchParams({ limit: String(limit) }), before)}`),
    /** A window of `limit` entries ending before index `before` (default: the end of the transcript). */
    session: (id: string, before?: number, limit = 200) => request<SessionDetail>(`/sessions/${id}?limit=${limit}${before ? `&before=${before}` : ''}`),

    /** Names of the SSH keys in data/secrets/ssh (never their contents). */
    sshKeys: () => request<{ dir: string; keys: Array<{ name: string; public: boolean }>; known_hosts: boolean }>('/hosts/keys'),
    /** `ssh -o BatchMode=yes user@host echo ok` with the chosen key. */
    testHost: (ssh: string, key?: string) => request<{ ok: boolean; output: string; ms: number }>('/hosts/test', { method: 'POST', body: JSON.stringify({ ssh, key: key || undefined }) }),

    presets: () => request<Preset[]>('/presets'),
    installPreset: (name: string, overwrite = false) =>
        request<{ installed: Preset['files'] }>(`/presets/${name}/install`, { method: 'POST', body: JSON.stringify({ overwrite }) })
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
        source.addEventListener('task', (e) => handlers.onTask?.(JSON.parse((e as MessageEvent).data)))
        source.addEventListener('event', (e) => handlers.onEvent?.(JSON.parse((e as MessageEvent).data)))
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
export const taskTokens = (t: Pick<Task, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>) =>
    t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens

export const fmt = {
    /** "1 run", "3 runs". */
    plural: (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`,
    tokens: (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)),
    pct: (share: number) => `${Math.round(share * 100)}%`,
    /** A task's share of the 5-hour window: "+3% of 5h", "<1% of 5h" or null. */
    windowDelta: (share: number | null) => (share === null ? null : share < 0.01 ? '<1% of 5h' : `+${Math.round(share * 100)}% of 5h`),
    /** Time left until an ISO timestamp: "2h 15m", "3d", "now". */
    until: (iso: string) => {
        const ms = new Date(iso).getTime() - Date.now()
        if (ms <= 0) return 'now'
        const h = Math.floor(ms / 3_600_000)
        const m = Math.floor((ms % 3_600_000) / 60_000)
        if (h >= 48) return `${Math.round(h / 24)}d`
        return h > 0 ? `${h}h ${m}m` : `${m}m`
    },
    duration: (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`),
    when: (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—'),
    ago: (iso: string | null) => {
        if (!iso) return '—'
        const diff = Date.now() - new Date(iso).getTime()
        if (diff < 60_000) return 'just now'
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
        return `${Math.floor(diff / 86_400_000)} d ago`
    },
    bytes: (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`)
}
