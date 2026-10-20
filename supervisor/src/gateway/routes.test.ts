import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppContext, Env } from '../web/context.js'
import { gatewayRoutes, translateStream } from './routes.js'

const TOKEN = 'secret-bearer'

/** The gateway with just what its routes read of the app: one `kind: openai` provider, no key. */
function gateway() {
    const noteProvider = vi.fn()
    const ctx = {
        tasks: { gatewayToken: () => TOKEN, noteProvider },
        providers: {
            get: (name: string) => (name === 'box' ? { kind: 'openai', url: 'http://box' } : undefined),
            key: () => null
        }
    } as unknown as AppContext
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
        c.set('app', ctx)
        await next()
    })
    app.route('/gateway', gatewayRoutes())
    return { app, noteProvider }
}

const messages = (app: Hono<Env>, stream: boolean, signal?: AbortSignal) =>
    app.request('/gateway/box/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', max_tokens: 10, stream, messages: [{ role: 'user', content: 'hi' }] }),
        signal
    })

/** A pending promise that rejects once the signal aborts. */
const untilAborted = <T>(signal: AbortSignal) =>
    new Promise<T>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error)))

/** An upstream body: the chunks one per read, then its end or a failure. */
const streamOf = (chunks: string[], failWith?: Error) => {
    const left = [...chunks]
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            const chunk = left.shift()
            if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk))
            else if (failWith) controller.error(failWith)
            else controller.close()
        }
    })
}

const eventsOf = (text: string) => [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('gateway /v1/messages', () => {
    it('aborts the upstream request when the CLI goes away', async () => {
        let upstream: AbortSignal | undefined
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init: RequestInit) => {
                upstream = init.signal ?? undefined
                return untilAborted<Response>(upstream!)
            })
        )
        const { app } = gateway()
        const client = new AbortController()
        const answer = messages(app, true, client.signal)
        await vi.waitFor(() => expect(upstream).toBeDefined())
        expect(upstream!.aborted).toBe(false)
        client.abort()
        expect(upstream!.aborted).toBe(true)
        expect((await answer).status).toBe(502)
    })

    it('bounds a non-streaming body that never ends', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init: RequestInit) =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => untilAborted(init.signal!)
                } as unknown as Response)
            )
        )
        const { app, noteProvider } = gateway()
        const answer = messages(app, false)
        await vi.waitFor(() => expect(noteProvider).toHaveBeenCalledWith('box', true))
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect((await answer).status).toBe(502)
    })
})

describe('translateStream', () => {
    it('reads a last data line that has no trailing newline', async () => {
        const text = await new Response(
            translateStream(
                streamOf([
                    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
                    'data: {"choices":[{"delta":{"content":"!"}}]}'
                ]),
                'm'
            )
        ).text()
        expect(text.match(/"text":"!"/)).not.toBeNull()
        expect(eventsOf(text).at(-1)).toBe('message_stop')
    })

    it('ends with a Messages error when the upstream stream fails mid-answer', async () => {
        const text = await new Response(
            translateStream(streamOf(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n'], new Error('reset')), 'm')
        ).text()
        expect(eventsOf(text)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'error'])
        expect(text).toContain('upstream stream failed')
    })
})
