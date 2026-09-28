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
    created_at: string
    started_at: string | null
    finished_at: string | null
}

export interface TaskEvent {
    id: number
    task_id: string
    ts: string
    type: 'text' | 'tool_use' | 'tool_result' | 'status' | 'error'
    payload: Record<string, unknown>
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
}

export interface ConversationDetail extends Conversation {
    tasks: Task[]
    events: TaskEvent[]
}

export interface Stats {
    queued: number
    running: number
    done_today: number
    failed_today: number
    tokens_today: number
    tokens_total: number
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

export interface Usage {
    latest: RateLimits | null
    history: RateLimits[]
    probing: boolean
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
    }
    github: { cli: string | null; token: boolean }
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
    workspace: string
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
    entries: TranscriptEntry[]
}

export interface Preset {
    name: string
    title: string
    description: string
    tags: string[]
    files: Array<{ kind: Kind; name: string; description: string | null }>
    readme: string | null
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
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new ApiError(response.status, (body as { error?: string }).error ?? response.statusText)
    return body as T
}

export const api = {
    status: () => request<Status>('/status'),
    tasks: (status?: TaskStatus) => request<Task[]>(`/tasks${status ? `?status=${status}` : ''}`),
    task: (id: string) => request<Task & { events: TaskEvent[]; conversation: Conversation }>(`/tasks/${id}`),
    stopTask: (id: string) => request<{ stopped: boolean }>(`/tasks/${id}/stop`, { method: 'POST' }),

    usage: () => request<Usage>('/usage'),
    probeUsage: () => request<RateLimits>('/usage/probe', { method: 'POST' }),

    conversations: () => request<Conversation[]>('/conversations'),
    conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
    createConversation: (title?: string) =>
        request<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
    sendMessage: (id: string, prompt: string) =>
        request<Task>(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt }) }),

    list: (kind: Kind) => request<CatalogEntry[]>(`/${kind}`),
    get: (kind: Kind, name: string) => request<CatalogEntry>(`/${kind}/${name}`),
    save: (kind: Kind, name: string, doc: { frontmatter: Record<string, unknown>; body: string }) =>
        request<CatalogEntry>(`/${kind}/${name}`, { method: 'PUT', body: JSON.stringify(doc) }),
    remove: (kind: Kind, name: string) => request<void>(`/${kind}/${name}`, { method: 'DELETE' }),

    sessions: () => request<SessionSummary[]>('/sessions'),
    session: (id: string) => request<SessionDetail>(`/sessions/${id}`),

    presets: () => request<Preset[]>('/presets'),
    installPreset: (name: string, overwrite = false) =>
        request<{ installed: Preset['files'] }>(`/presets/${name}/install`, { method: 'POST', body: JSON.stringify({ overwrite }) })
}

/** Subscribe to a conversation's live feed. Returns an unsubscribe function. */
export function streamConversation(
    id: string,
    after: number,
    handlers: { onTask?: (task: Task) => void; onEvent?: (event: TaskEvent) => void; onError?: () => void }
): () => void {
    const source = new EventSource(`/api/conversations/${id}/stream?after=${after}`)
    source.addEventListener('task', (e) => handlers.onTask?.(JSON.parse((e as MessageEvent).data)))
    source.addEventListener('event', (e) => handlers.onEvent?.(JSON.parse((e as MessageEvent).data)))
    source.onerror = () => handlers.onError?.()
    return () => source.close()
}

/** Every token the task sent or received, cache included — what the subscription meters. */
export const taskTokens = (t: Pick<Task, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>) =>
    t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens

export const fmt = {
    tokens: (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)),
    pct: (share: number) => `${Math.round(share * 100)}%`,
    /** A task's share of the 5-hour window: "+3% of 5h", "<1% of 5h" or null. */
    windowDelta: (share: number | null) => (share === null ? null : share < 0.01 ? '<1% of 5h' : `+${Math.round(share * 100)}% of 5h`),
    /** Time left until an ISO timestamp: "2h 15m", "3d", "now". */
    until: (iso: string) => {
        const ms = new Date(iso).getTime() - Date.now()
        if (ms <= 0) return 'now'
        const h = Math.floor(ms / 3_600_000)
        const m = Math.round((ms % 3_600_000) / 60_000)
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
