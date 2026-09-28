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
    cost_today: number
    cost_total: number
}

export interface Status {
    stats: Stats
    running: string[]
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

export const fmt = {
    cost: (usd: number) => `$${usd.toFixed(usd >= 1 ? 2 : 3)}`,
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
