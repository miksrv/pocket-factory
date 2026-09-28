import { Hono } from 'hono'

import { createLogger } from '../../logger.js'
import type { Env } from '../context.js'

const log = createLogger('models')

export interface ModelInfo {
    id: string
    display_name: string
    created_at: string
    max_input_tokens: number | null
    max_tokens: number | null
}

interface ModelsResponse {
    data?: Array<{ id: string; display_name?: string; created_at?: string; max_input_tokens?: number; max_tokens?: number }>
}

const TTL = 60 * 60 * 1000
let cache: { at: number; models: ModelInfo[] } | null = null

/**
 * Models the subscription can use, from the Claude API's models list with
 * the same OAuth token the CLI runs on. Read-only metadata, cached for an
 * hour; an empty list means the token is missing or the call failed, and
 * the UI falls back to the CLI aliases.
 */
async function listModels(): Promise<ModelInfo[]> {
    if (cache && Date.now() - cache.at < TTL) return cache.models
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (!token) return []
    try {
        const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
            headers: {
                Authorization: `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'anthropic-version': '2023-06-01'
            },
            signal: AbortSignal.timeout(15_000)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as ModelsResponse
        const models = (body.data ?? []).map((m) => ({
            id: m.id,
            display_name: m.display_name ?? m.id,
            created_at: m.created_at ?? '',
            max_input_tokens: m.max_input_tokens ?? null,
            max_tokens: m.max_tokens ?? null
        }))
        cache = { at: Date.now(), models }
        return models
    } catch (error) {
        log.warn(`models list failed: ${error instanceof Error ? error.message : error}`)
        return cache?.models ?? []
    }
}

export function modelRoutes(): Hono<Env> {
    const app = new Hono<Env>()
    app.get('/', async (c) => c.json(await listModels()))
    return app
}

/**
 * The tools an agent file usually lists. The CLI's own session list is not
 * the same thing: it names harness internals (Monitor, CronCreate, …) and
 * leaves out tools it loads lazily (Grep, Glob), so these stay first.
 */
const COMMON_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite']

/** Tool names an agent file may list in `tools:`: the common ones, then everything the CLI reported. */
export function toolRoutes(): Hono<Env> {
    const app = new Hono<Env>()
    app.get('/', (c) => {
        const reported = c.get('app').tasks.tools()
        return c.json({ common: COMMON_TOOLS, reported: reported.filter((t) => !COMMON_TOOLS.includes(t)), source: reported.length ? 'cli' : 'default' })
    })
    return app
}
