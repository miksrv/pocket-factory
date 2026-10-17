import { Hono } from 'hono'

import { BadName, NotFound } from '../../files/catalog.js'
import {
    CLAUDE_PROVIDER,
    fetchError,
    mcpList,
    type Provider,
    type ProviderMcp,
    type Providers,
    tokenVarProblem
} from '../../files/providers.js'
import { fromOpenAiResponse, type OpenAiResponse, toOpenAiRequest } from '../../gateway/translate.js'
import { mcpKey } from '../../tasks/service.js'
import type { Env } from '../context.js'

/**
 * Model providers besides the subscription (`data/config/providers.yaml`):
 * the list with each key's presence (never its value) and the tasks running
 * on it, create / edit / delete, a connection test (one tiny tool-calling
 * request straight from the supervisor) and the provider's own model list
 * when its endpoint has one.
 */

/** Who refers to a provider: routines and agents with `provider: <name>`. */
function usedBy(c: { get: (k: 'app') => Env['Variables']['app'] }, name: string): string[] {
    const { catalog } = c.get('app')
    return (['routines', 'agents'] as const).flatMap((kind) =>
        catalog
            .list(kind)
            .filter((e) => e.frontmatter.provider === name)
            .map((e) => `${kind === 'routines' ? '⏱ ' : ''}${e.name}`)
    )
}

type Body = Partial<Omit<Provider, 'models' | 'mcp'>> & {
    name?: unknown
    models?: unknown
    light?: unknown
    mcp?: unknown
    ca?: unknown
}

/** A provider from a request body, or the saved one by `name` with the body's model; what the test and the model list work on. */
function candidate(c: { get: (k: 'app') => Env['Variables']['app'] }, body: Body): Provider | { error: string } {
    const { providers } = c.get('app')
    if (typeof body.name === 'string' && !body.url) {
        const saved = providers.get(body.name)
        return saved ?? { error: `unknown provider "${body.name}"` }
    }
    if (typeof body.url !== 'string') return { error: 'url is required' }
    // A draft names its key variable freely: only a provider-shaped one is ever read, never the factory's own secrets.
    const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : undefined
    const problem = token ? tokenVarProblem(token) : null
    if (problem) return { error: problem }
    const models = Array.isArray(body.models)
        ? body.models.filter((m): m is string => typeof m === 'string')
        : typeof body.models === 'string'
          ? body.models.split(/[,\n]/).map((m) => m.trim())
          : []
    let mcp: ProviderMcp[] | undefined
    try {
        mcp = mcpList(body.mcp, true)
    } catch (error) {
        return { error: (error as Error).message }
    }
    return {
        name: typeof body.name === 'string' && body.name ? body.name : 'test',
        kind: body.kind === 'openai' ? 'openai' : 'anthropic',
        url: body.url.trim().replace(/\/+$/, ''),
        token,
        models: models.filter(Boolean),
        default: typeof body.default === 'string' ? body.default : undefined,
        small: typeof body.small === 'string' ? body.small : undefined,
        concurrency: typeof body.concurrency === 'number' ? body.concurrency : 1,
        light: body.light !== false,
        // Validated by `save`; a draft for a test or a model list only carries them along.
        max_output: typeof body.max_output === 'number' ? body.max_output : undefined,
        context: typeof body.context === 'number' ? body.context : undefined,
        mcp
    }
}

export interface McpCheck {
    name: string
    ok: boolean
    /** What the server calls itself in its `initialize` answer. */
    server?: string
    error?: string
}

/** One MCP `initialize` against a provider's server with its key: it answers, the key is accepted, it speaks MCP. */
async function checkMcp(providers: Providers, server: ProviderMcp): Promise<McpCheck> {
    const key = providers.mcpKey(server)
    if (server.token && !key) return { name: server.name, ok: false, error: `${server.token} is not set in .env` }
    try {
        const response = await fetch(server.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...(key ? { authorization: `Bearer ${key}` } : {})
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'pocket-factory-test', version: '1' }
                }
            }),
            signal: AbortSignal.timeout(20_000)
        })
        const text = await response.text()
        if (!response.ok) return { name: server.name, ok: false, error: `${response.status}: ${text.slice(0, 200)}` }
        // JSON, or one SSE `data:` line carrying it.
        const payload = text.trim().startsWith('{') ? text : (/^data:\s*(.+)$/m.exec(text)?.[1] ?? '')
        const json = JSON.parse(payload) as {
            result?: { serverInfo?: { name?: string } }
            error?: { message?: string }
        }
        if (!json.result) return { name: server.name, ok: false, error: json.error?.message ?? 'no result' }
        return { name: server.name, ok: true, server: json.result.serverInfo?.name }
    } catch (error) {
        return { name: server.name, ok: false, error: fetchError(error) }
    }
}

export function providerRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', (c) => {
        const { providers, tasks } = c.get('app')
        const status = tasks.providerStatus()
        const overview = providers.list((name) => status.find((p) => p.name === name)?.running ?? 0)
        return c.json({
            ...overview,
            providers: overview.providers.map((p) => ({
                ...p,
                health: status.find((s) => s.name === p.name)?.health ?? null,
                used_by: usedBy(c, p.name)
            })),
            builtin: CLAUDE_PROVIDER
        })
    })

    /** Create or update; `?create=1` refuses to replace an existing name. */
    app.put('/:name', async (c) => {
        const { providers, tasks } = c.get('app')
        const body = (await c.req.json().catch(() => null)) as Body | null
        if (!body || typeof body.url !== 'string') return c.json({ error: 'url is required' }, 400)
        const before = providers.get(c.req.param('name'))
        // One name, one server: a provider's MCP server named like a connector's, a plugin's, a project's or the
        // owner's own would make `mcp__<name>__<tool>` ambiguous in agent files and permission rules.
        const own = `provider:${typeof body.name === 'string' && body.name ? body.name : c.req.param('name')}`
        const clash = (Array.isArray(body.mcp) ? (body.mcp as Array<{ name?: unknown }>) : [])
            .map((s) => (typeof s.name === 'string' ? s.name.trim() : ''))
            .filter(Boolean)
            .map((name) => ({
                name,
                other: tasks.mcpRegistry().find((e) => e.key === mcpKey(name) && e.source !== own)
            }))
            .find((c) => c.other)
        if (clash)
            return c.json(
                {
                    error: `MCP server name "${clash.name}" is already the ${clash.other!.source ?? 'other'} server ${clash.other!.name}; one name, one server, or mcp__${clash.name}__<tool> names two things`
                },
                400
            )
        if (before && c.req.query('create'))
            return c.json(
                { error: `a provider named "${before.name}" already exists — open it from the list to edit it` },
                409
            )
        try {
            const draft = candidate(c, body)
            if ('error' in draft) return c.json({ error: draft.error }, 400)
            const saved = providers.save(c.req.param('name'), {
                ...draft,
                name: typeof body.name === 'string' ? body.name : undefined,
                ca: typeof body.ca === 'string' || body.ca === null ? body.ca : undefined
            })
            return c.json(saved)
        } catch (error) {
            return c.json({ error: (error as Error).message }, error instanceof BadName ? 400 : 409)
        }
    })

    /** Remove; a provider that routines or agents name answers 409 with their names unless `?force=1`. */
    app.delete('/:name', (c) => {
        const { providers } = c.get('app')
        const name = c.req.param('name')
        if (!providers.get(name)) return c.json({ error: `provider "${name}" not found` }, 404)
        const used = usedBy(c, name)
        if (used.length && c.req.query('force') !== '1')
            return c.json({ error: `provider "${name}" is used by ${used.join(', ')}`, used }, 409)
        try {
            providers.remove(name)
            return c.body(null, 204)
        } catch (error) {
            if (error instanceof NotFound) return c.json({ error: error.message }, 404)
            return c.json({ error: (error as Error).message }, 409)
        }
    })

    /**
     * One request with a tool offered and asked for: the endpoint answers, the key
     * is accepted, and the model calls tools (without that the agent cannot work).
     * The body is a draft from the form, or `{ name }` for a saved provider; `model`
     * picks the one to try (default: the provider's default).
     */
    app.post('/test', async (c) => {
        const { providers } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as Body & { model?: unknown }
        const provider = candidate(c, body)
        if ('error' in provider) return c.json({ error: provider.error }, 400)
        const model =
            (typeof body.model === 'string' && body.model.trim()) || provider.default || provider.models[0] || ''
        if (!model) return c.json({ error: 'name a model to test' }, 400)
        // The provider's MCP servers are checked alongside the model.
        const mcpChecks = Promise.all((provider.mcp ?? []).map((s) => checkMcp(providers, s)))
        const answer = async (result: Record<string, unknown>) => c.json({ ...result, mcp: await mcpChecks })
        const key = providers.key(provider)
        if (provider.token && !key) return answer({ ok: false, error: `${provider.token} is not set in .env`, model })
        const started = Date.now()
        // Room for a thinking model's reasoning before the call (gemma4 spent 64 tokens thinking and never called).
        const probe = {
            model,
            max_tokens: 1024,
            system: 'You are a tool-calling probe. Use the tool; do not answer in prose.',
            messages: [{ role: 'user' as const, content: 'Call the tool `ping` with ok = true.' }],
            tools: [
                {
                    name: 'ping',
                    description: 'Report readiness',
                    input_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
                }
            ]
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60_000)
        try {
            const response =
                provider.kind === 'openai'
                    ? await fetch(`${provider.url}/chat/completions`, {
                          method: 'POST',
                          headers: {
                              'content-type': 'application/json',
                              ...(key ? { authorization: `Bearer ${key}` } : {})
                          },
                          body: JSON.stringify(toOpenAiRequest(probe)),
                          signal: controller.signal
                      })
                    : await fetch(`${provider.url}/v1/messages`, {
                          method: 'POST',
                          headers: {
                              'content-type': 'application/json',
                              'anthropic-version': '2023-06-01',
                              ...(key ? { 'x-api-key': key, authorization: `Bearer ${key}` } : {})
                          },
                          body: JSON.stringify(probe),
                          signal: controller.signal
                      })
            const text = await response.text()
            if (!response.ok)
                return answer({
                    ok: false,
                    model,
                    ms: Date.now() - started,
                    error: `${response.status}: ${text.slice(0, 500)}`
                })
            let reply: { content?: Array<{ type: string; text?: string; name?: string }>; stop_reason?: string }
            try {
                const json = JSON.parse(text) as unknown
                reply =
                    provider.kind === 'openai'
                        ? fromOpenAiResponse(json as OpenAiResponse, model)
                        : (json as typeof reply)
            } catch {
                return answer({ ok: false, model, ms: Date.now() - started, error: `not JSON: ${text.slice(0, 200)}` })
            }
            const content = reply.content ?? []
            const toolCalling = content.some((b) => b.type === 'tool_use' && b.name === 'ping')
            if (!toolCalling && reply.stop_reason === 'max_tokens')
                return answer({
                    ok: true,
                    model,
                    ms: Date.now() - started,
                    tool_calling: false,
                    output: 'the reply was cut off before any tool call (the model thinks at length)'
                })
            const said = content
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join(' ')
                .slice(0, 200)
            return answer({ ok: true, model, ms: Date.now() - started, tool_calling: toolCalling, output: said })
        } catch (error) {
            return answer({ ok: false, model, ms: Date.now() - started, error: fetchError(error) })
        } finally {
            clearTimeout(timer)
        }
    })

    /** The model ids the endpoint lists (`/v1/models`, OpenAI shape, which Ollama, vLLM, OpenRouter and the cloud APIs share). */
    app.post('/models', async (c) => {
        const { providers } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as Body
        const provider = candidate(c, body)
        if ('error' in provider) return c.json({ error: provider.error }, 400)
        const key = providers.key(provider)
        const url = provider.kind === 'openai' ? `${provider.url}/models` : `${provider.url}/v1/models`
        try {
            const response = await fetch(url, {
                headers: key ? { authorization: `Bearer ${key}`, 'x-api-key': key } : {},
                signal: AbortSignal.timeout(20_000)
            })
            if (!response.ok)
                return c.json({ error: `${response.status}: ${(await response.text()).slice(0, 300)}` }, 502)
            const json = (await response.json()) as { data?: Array<{ id?: string; name?: string }>; models?: unknown }
            const ids = (json.data ?? [])
                .map((m) => m.id ?? m.name ?? '')
                .filter(Boolean)
                .sort()
            return c.json({ models: ids })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
        }
    })

    return app
}
