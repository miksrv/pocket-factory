import { timingSafeEqual } from 'node:crypto'

import { Hono } from 'hono'

import { createLogger } from '../logger.js'
import { VERSION } from '../version.js'
import type { Env } from '../web/context.js'

const log = createLogger('factory-mcp')

const sameToken = (a: string, b: string) =>
    a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b))

interface JsonRpcRequest {
    jsonrpc: '2.0'
    id?: string | number | null
    method: string
    params?: Record<string, unknown>
}

const rpcResult = (id: JsonRpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id: JsonRpcRequest['id'], code: number, message: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message }
})

/**
 * The factory's own MCP server, one endpoint per running task (`/factory/<task>/mcp`, a bearer
 * derived from the task id): streamable HTTP with a single tool, `delegate`, which hands a brief
 * to a role on another provider and answers when the role is done. The call can take many
 * minutes, so its answer is an SSE stream that carries progress notifications until the result.
 * Mounted outside `/api`: no cookie, no CSRF, only the bearer; offered only to orchestrators on
 * the subscription, and only while some agent file names a `provider:`.
 */
export function factoryRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.use('/:task/mcp', async (c, next) => {
        const { tasks } = c.get('app')
        const auth = c.req.header('authorization') ?? ''
        const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
        if (!sameToken(presented, tasks.factoryToken(c.req.param('task'))))
            return c.json(rpcError(null, -32001, 'factory: bad token'), 401)
        await next()
    })

    // No server-initiated stream and no session state: every request stands alone.
    app.get('/:task/mcp', (c) => c.body(null, 405))
    app.delete('/:task/mcp', (c) => c.body(null, 200))

    app.post('/:task/mcp', async (c) => {
        const { tasks } = c.get('app')
        const taskId = c.req.param('task')
        const message = (await c.req.json().catch(() => null)) as JsonRpcRequest | null
        if (!message || Array.isArray(message) || typeof message.method !== 'string')
            return c.json(rpcError(null, -32600, 'one JSON-RPC request per POST'), 400)
        // Notifications (`notifications/initialized`, cancellations) need no answer.
        if (message.id === undefined || message.id === null) return c.body(null, 202)
        const { id, method, params = {} } = message

        if (method === 'initialize')
            return c.json(
                rpcResult(id, {
                    protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'pocket-factory', version: VERSION }
                })
            )
        if (method === 'ping') return c.json(rpcResult(id, {}))
        if (method === 'tools/list') {
            const agents = tasks.delegates()
            return c.json(
                rpcResult(id, {
                    tools: [
                        {
                            name: 'delegate',
                            description: [
                                'Hand a task to a role that runs on another model (a self-hosted or another provider), outside this session, and wait for its report. The role saves its results as files in a work directory this tool names; read them there. If its model is unavailable the role runs on yours instead, and the answer says so.',
                                'Roles:',
                                ...agents.map(
                                    (a) =>
                                        `- ${a.name} (${a.provider}${a.model ? ` · ${a.model}` : ''})${a.description ? `: ${a.description}` : ''}`
                                )
                            ].join('\n'),
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    agent: {
                                        type: 'string',
                                        enum: agents.map((a) => a.name),
                                        description: 'The role to hand the task to'
                                    },
                                    prompt: {
                                        type: 'string',
                                        description:
                                            'A self-contained brief: what to do, for whom, what to save and under which file name. The role sees nothing of this conversation.'
                                    },
                                    files: {
                                        type: 'array',
                                        items: { type: 'string' },
                                        description:
                                            'Absolute paths of files the role should read (data, drafts); not their contents'
                                    }
                                },
                                required: ['agent', 'prompt']
                            }
                        }
                    ]
                })
            )
        }
        if (method !== 'tools/call') return c.json(rpcError(id, -32601, `method ${method} not found`))
        if (params.name !== 'delegate') return c.json(rpcError(id, -32602, `unknown tool ${String(params.name)}`))

        const args = (params.arguments ?? {}) as { agent?: unknown; prompt?: unknown; files?: unknown }
        const progressToken = (params._meta as { progressToken?: string | number } | undefined)?.progressToken
        const encoder = new TextEncoder()
        let closed = false
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const send = (payload: unknown) => {
                    if (closed) return
                    try {
                        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`))
                    } catch {
                        closed = true
                    }
                }
                let step = 0
                const progress = (note: string) => {
                    if (progressToken === undefined) {
                        // Nothing to report to: an SSE comment still tells the client the call is alive.
                        if (!closed) controller.enqueue(encoder.encode(': working\n\n'))
                        return
                    }
                    send({
                        jsonrpc: '2.0',
                        method: 'notifications/progress',
                        params: { progressToken, progress: ++step, message: note }
                    })
                }
                const answer = (text: string, isError: boolean) => {
                    send(rpcResult(id, { content: [{ type: 'text', text }], isError }))
                    if (!closed) {
                        closed = true
                        controller.close()
                    }
                }
                if (typeof args.agent !== 'string' || typeof args.prompt !== 'string')
                    return answer('delegate needs `agent` and `prompt` strings', true)
                const files = Array.isArray(args.files)
                    ? args.files.filter((f): f is string => typeof f === 'string')
                    : []
                tasks
                    .delegate(taskId, { agent: args.agent, prompt: args.prompt, files }, progress)
                    .then((outcome) => answer(outcome.text, !outcome.ok))
                    .catch((error: unknown) => {
                        const text = error instanceof Error ? error.message : String(error)
                        log.warn(`${taskId}: delegate failed: ${text}`)
                        answer(`delegate failed: ${text}`, true)
                    })
            },
            cancel() {
                // The CLI went away (its task stopped): the role is stopped with its parent, not here.
                closed = true
            }
        })
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }
        })
    })

    return app
}
