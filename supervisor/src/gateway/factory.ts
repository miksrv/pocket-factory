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

/** What the `preview` tool tells the agent, whatever the project. */
const PREVIEW_DESCRIPTION = [
    'Show the owner an app you run in this project (a dev server, a static build, `docker compose up` inside your sandbox): call this with the port it listens on and give the owner the URL from the answer. One preview per project; a new call replaces the previous one.',
    'Serve on 0.0.0.0, not 127.0.0.1. The app is reached under a path, not at /: start it with the base path in $PREVIEW_BASE (`vite --base "$PREVIEW_BASE"`, Next `basePath`, CRA `PUBLIC_URL`, Django `FORCE_SCRIPT_NAME` …) and leave `strip_prefix` off; an app that only uses relative URLs and serves at / instead gets `strip_prefix: true`.',
    'The page runs in a sandbox of its own origin: localStorage, cookies set by JavaScript and service workers do not work in it.'
].join(' ')

/**
 * The factory's own MCP server, one endpoint per running task (`/factory/<task>/mcp`, a bearer
 * derived from the task id), streamable HTTP. `delegate` hands a brief to a role on another
 * provider and answers when the role is done (many minutes, so the answer is an SSE stream that
 * carries progress notifications until the result); offered to orchestrators on the subscription
 * while some agent file names a `provider:`. `preview` / `preview_stop` publish the app a
 * project's agent runs at `/preview/<project>/`; offered to a project's tasks on the subscription.
 * Mounted outside `/api`: no cookie, no CSRF, only the bearer.
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
        const offers = tasks.factoryTools(taskId)
        if (method === 'tools/list') {
            const agents = tasks.delegates()
            const previewTools = [
                {
                    name: 'preview',
                    description: PREVIEW_DESCRIPTION,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            port: {
                                type: 'integer',
                                minimum: 1,
                                maximum: 65535,
                                description: 'The port the app listens on'
                            },
                            strip_prefix: {
                                type: 'boolean',
                                description:
                                    'true: the app serves at / and gets its requests without the /preview/… prefix'
                            }
                        },
                        required: ['port']
                    }
                },
                {
                    name: 'preview_stop',
                    description: "Stop showing this project's app (the app itself keeps running until you stop it).",
                    inputSchema: { type: 'object', properties: {} }
                }
            ]
            return c.json(
                rpcResult(id, {
                    tools: [
                        ...(offers.preview ? previewTools : []),
                        ...(!offers.delegate
                            ? []
                            : [
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
                              ])
                    ]
                })
            )
        }
        if (method !== 'tools/call') return c.json(rpcError(id, -32601, `method ${method} not found`))
        const tool = String(params.name)
        const text = (value: string, isError = false) =>
            c.json(rpcResult(id, { content: [{ type: 'text', text: value }], isError }))
        if ((tool === 'preview' || tool === 'preview_stop') && offers.preview) {
            const args = (params.arguments ?? {}) as { port?: unknown; strip_prefix?: unknown }
            try {
                if (tool === 'preview_stop')
                    return text((await tasks.previewStop(taskId)) ? 'The preview is stopped.' : 'There was no preview.')
                const port = typeof args.port === 'number' ? args.port : Number(args.port)
                const preview = await tasks.preview(taskId, port, args.strip_prefix === true)
                return text(
                    [
                        `The owner opens it at ${preview.url}${preview.url.startsWith('/') ? ' on the factory' : ''} (they sign in to the factory first).`,
                        `Served under ${preview.base}${preview.strip ? ', with the prefix stripped before it reaches the app' : ' (the app must use this base path; it is $PREVIEW_BASE)'}.`,
                        `Port ${preview.port} in your sandbox${preview.expires_at ? `, until ${preview.expires_at} unless stopped earlier` : ''}.`
                    ].join(' ')
                )
            } catch (error) {
                return text(`preview failed: ${error instanceof Error ? error.message : String(error)}`, true)
            }
        }
        if (tool !== 'delegate' || !offers.delegate) return c.json(rpcError(id, -32602, `unknown tool ${tool}`))

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
