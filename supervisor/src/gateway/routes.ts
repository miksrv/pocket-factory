import { timingSafeEqual } from 'node:crypto'

import { Hono } from 'hono'

import { fetchError } from '../files/providers.js'
import { createLogger } from '../logger.js'
import type { Env } from '../web/context.js'
import {
    type AnthropicRequest,
    estimateTokens,
    fromOpenAiResponse,
    type OpenAiResponse,
    sseFrame,
    SseParser,
    StreamTranslator,
    toOpenAiRequest
} from './translate.js'

const log = createLogger('gateway')

/**
 * Upstream must send its headers within this. A GPU box answers only once the whole prompt is
 * evaluated (a 60k context at 1–2k tok/s is a minute), so this is a ceiling against a dead
 * server, not a budget for a slow one.
 */
const CONNECT_TIMEOUT_MS = 10 * 60_000

/** An MCP server must answer (headers) within this; the stream itself may stay open longer. */
const MCP_CONNECT_TIMEOUT_MS = 2 * 60_000
/** Streamable HTTP headers that go to the MCP server and back. */
const MCP_PASS_HEADERS = [
    'content-type',
    'accept',
    'mcp-session-id',
    'mcp-protocol-version',
    'mcp-method',
    'mcp-name',
    'last-event-id'
]
const MCP_RETURN_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version']

const sameToken = (a: string, b: string) =>
    a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Headers of the CLI's request that go upstream as they are (the API version and beta flags). */
const PASS_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept']

const anthropicError = (status: number, message: string, type = 'api_error') =>
    Response.json({ type: 'error', error: { type, message } }, { status })

/**
 * The model gateway: the `claude` CLI of a task on another provider is pointed
 * here (`ANTHROPIC_BASE_URL=…/gateway/<provider>`) with a per-start bearer, and
 * the gateway forwards to the provider with its real key, which never reaches
 * the CLI's environment. A `kind: anthropic` provider gets the request as it
 * is; a `kind: openai` one gets it translated to chat completions and its
 * answer translated back, streaming included. Mounted outside `/api`: no
 * cookie, no CSRF, only the bearer.
 */
export function gatewayRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.use('/:provider/*', async (c, next) => {
        const { tasks } = c.get('app')
        const auth = c.req.header('authorization') ?? ''
        const key = c.req.header('x-api-key') ?? ''
        const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : key.trim()
        // Each provider has its own bearer: a task holds the key to its provider's routes only.
        if (!sameToken(presented, tasks.gatewayToken(c.req.param('provider'))))
            return anthropicError(401, 'gateway: bad token', 'authentication_error')
        await next()
    })

    app.post('/:provider/v1/messages/count_tokens', async (c) => {
        const body = (await c.req.json().catch(() => null)) as AnthropicRequest | null
        if (!body) return anthropicError(400, 'invalid JSON', 'invalid_request_error')
        return c.json({ input_tokens: estimateTokens(body) })
    })

    app.post('/:provider/v1/messages', async (c) => {
        const { tasks, providers } = c.get('app')
        const name = c.req.param('provider')
        const provider = providers.get(name)
        if (!provider) return anthropicError(404, `unknown provider "${name}"`, 'not_found_error')
        const key = providers.key(provider)
        if (provider.token && !key) {
            tasks.noteProvider(name, false, `${provider.token} is not set in .env`)
            return anthropicError(401, `provider ${name}: ${provider.token} is not set in .env`, 'authentication_error')
        }
        const body = (await c.req.json().catch(() => null)) as AnthropicRequest | null
        if (!body) return anthropicError(400, 'invalid JSON', 'invalid_request_error')

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
        try {
            const upstream =
                provider.kind === 'openai'
                    ? await fetch(`${provider.url}/chat/completions`, {
                          method: 'POST',
                          headers: {
                              'content-type': 'application/json',
                              accept: body.stream ? 'text/event-stream' : 'application/json',
                              ...(key ? { authorization: `Bearer ${key}` } : {})
                          },
                          body: JSON.stringify(toOpenAiRequest(body)),
                          signal: controller.signal
                      })
                    : await fetch(`${provider.url}/v1/messages`, {
                          method: 'POST',
                          headers: {
                              ...Object.fromEntries(
                                  PASS_HEADERS.flatMap((h) => {
                                      const v = c.req.header(h)
                                      return v ? [[h, v]] : []
                                  })
                              ),
                              'anthropic-version': c.req.header('anthropic-version') ?? '2023-06-01',
                              ...(key ? { 'x-api-key': key, authorization: `Bearer ${key}` } : {})
                          },
                          body: JSON.stringify(body),
                          signal: controller.signal
                      })
            clearTimeout(timer)
            if (!upstream.ok) {
                const text = (await upstream.text().catch(() => '')).slice(0, 2000)
                tasks.noteProvider(name, false, `${upstream.status}: ${text || upstream.statusText}`)
                log.warn(`${name}: ${upstream.status} ${text.slice(0, 200)}`)
                // The CLI reads the Messages error shape whatever the provider said.
                return anthropicError(
                    upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : upstream.status,
                    `${name}: ${text || upstream.statusText}`,
                    upstream.status === 429 ? 'rate_limit_error' : 'api_error'
                )
            }
            tasks.noteProvider(name, true)
            if (provider.kind === 'anthropic') {
                // As it came: the body stream, the content type, nothing else of the upstream's headers.
                return new Response(upstream.body, {
                    status: upstream.status,
                    headers: {
                        'content-type': upstream.headers.get('content-type') ?? 'application/json',
                        'cache-control': 'no-store'
                    }
                })
            }
            if (!body.stream) {
                const json = (await upstream.json()) as OpenAiResponse
                return c.json(fromOpenAiResponse(json, body.model))
            }
            return new Response(translateStream(upstream.body, body.model), {
                status: 200,
                headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }
            })
        } catch (error) {
            clearTimeout(timer)
            const message = fetchError(error)
            tasks.noteProvider(name, false, message)
            log.warn(`${name}: ${message}`)
            return anthropicError(502, `provider ${name} unreachable: ${message}`)
        }
    })

    /**
     * A provider's MCP server (streamable HTTP): the request goes on as it came, with the server's
     * bearer instead of the gateway's, and the answer (JSON or an SSE stream) comes back as it is.
     */
    app.all('/:provider/mcp/:server', async (c) => {
        const { tasks, providers } = c.get('app')
        const name = c.req.param('provider')
        const provider = providers.get(name)
        const server = provider?.mcp?.find((s) => s.name === c.req.param('server'))
        if (!provider || !server)
            return c.json({ error: `gateway: no MCP server ${c.req.param('server')} on ${name}` }, 404)
        const key = providers.mcpKey(server)
        if (server.token && !key)
            return c.json({ error: `${name}/${server.name}: ${server.token} is not set in .env` }, 401)
        const method = c.req.method
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), MCP_CONNECT_TIMEOUT_MS)
        try {
            const upstream = await fetch(server.url, {
                method,
                headers: {
                    ...Object.fromEntries(
                        MCP_PASS_HEADERS.flatMap((h) => {
                            const v = c.req.header(h)
                            return v ? [[h, v]] : []
                        })
                    ),
                    ...(key ? { authorization: `Bearer ${key}` } : {})
                },
                body:
                    method === 'GET' || method === 'HEAD' || method === 'DELETE'
                        ? undefined
                        : await c.req.arrayBuffer(),
                // Headers within the timeout; then the stream lives as long as the CLI keeps it open.
                signal: AbortSignal.any([controller.signal, c.req.raw.signal])
            })
            clearTimeout(timer)
            if (!upstream.ok && upstream.status >= 500) log.warn(`${name}/${server.name}: MCP ${upstream.status}`)
            const headers = new Headers({ 'cache-control': 'no-store' })
            for (const h of MCP_RETURN_HEADERS) {
                const v = upstream.headers.get(h)
                if (v) headers.set(h, v)
            }
            return new Response(upstream.body, { status: upstream.status, headers })
        } catch (error) {
            clearTimeout(timer)
            const message = fetchError(error)
            tasks.noteProvider(name, false, `MCP ${server.name}: ${message}`)
            log.warn(`${name}/${server.name}: ${message}`)
            return c.json({ error: `MCP ${server.name} on ${name} unreachable: ${message}` }, 502)
        }
    })

    app.all('/:provider/*', (c) => anthropicError(404, `gateway: no such route ${c.req.path}`, 'not_found_error'))

    return app
}

/** The upstream chat-completions SSE, re-told as Messages SSE frames. */
function translateStream(upstream: ReadableStream<Uint8Array> | null, model: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    const translator = new StreamTranslator(model)
    const reader = upstream?.getReader()
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const push = (events: ReturnType<StreamTranslator['push']>) => {
                for (const event of events) controller.enqueue(encoder.encode(sseFrame(event)))
            }
            if (!reader) {
                push(translator.end())
                controller.close()
                return
            }
            const { done, value } = await reader.read()
            if (done) {
                push(translator.end())
                controller.close()
                return
            }
            for (const item of parser.push(decoder.decode(value, { stream: true }))) {
                if (item === 'DONE') {
                    push(translator.end())
                    continue
                }
                push(translator.push(item))
            }
        },
        cancel() {
            void reader?.cancel()
        }
    })
}
