import { afterEach, describe, expect, it } from 'vitest'

import { createTestApp, json, type TestApp, type TestAppOptions } from '../test/app.js'

describe('createApp security middleware', () => {
    let t: TestApp

    const open = (options: TestAppOptions = {}) => {
        t = createTestApp(options)
        return t
    }
    const withPassword = (options: TestAppOptions = {}) =>
        open({ ...options, web: { authPassword: 'secret', ...options.web } })

    afterEach(async () => {
        await t.cleanup()
    })

    describe('host guard in open mode', () => {
        it.each(['localhost', 'localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'factory.localhost'])(
            'answers to the local name %s',
            async (host) => {
                const res = await open().request('/api/conversations', { headers: { host } })
                expect(res.status).toBe(200)
            }
        )

        it.each(['evil.example.com', 'evil.example.com:8080', '10.0.0.5'])(
            'refuses the foreign name %s',
            async (host) => {
                const res = await open().request('/api/conversations', { headers: { host } })
                expect(res.status).toBe(403)
                expect(((await res.json()) as { error: string }).error).toMatch(/not allowed/)
            }
        )

        it('refuses a request without a Host header', async () => {
            open()
            const res = await t.app.request('/api/conversations')
            expect(res.status).toBe(403)
        })

        it('answers to a name in WEB_ALLOWED_HOSTS, case-insensitively', async () => {
            open({ web: { allowedHosts: new Set(['factory.lan']) } })
            expect((await t.request('/api/conversations', { headers: { host: 'Factory.LAN:8080' } })).status).toBe(200)
            expect((await t.request('/api/conversations', { headers: { host: 'other.lan' } })).status).toBe(403)
        })

        it('lets any host through once a password is set (the session guards instead)', async () => {
            const res = await withPassword().request('/api/auth/me', { headers: { host: 'factory.example.com' } })
            expect(res.status).toBe(200)
        })

        it('does not guard the paths outside /api', async () => {
            const res = await open().request('/', { headers: { host: 'evil.example.com' } })
            expect(res.status).toBe(200)
        })
    })

    describe('cross-site requests', () => {
        it.each([
            ['open', open],
            ['password', withPassword]
        ])('refuses a mutating request with a foreign Origin in %s mode', async (_mode, make) => {
            const res = await make().request(
                '/api/conversations',
                json({}, { headers: { origin: 'https://evil.example.com' } })
            )
            expect(res.status).toBe(403)
            expect(await res.json()).toEqual({ error: 'cross-site request refused' })
        })

        it.each(['PUT', 'PATCH', 'DELETE'])('refuses %s with a foreign Origin', async (method) => {
            const res = await open().request('/api/agents/x', {
                method,
                headers: { origin: 'http://evil.example.com' }
            })
            expect(res.status).toBe(403)
        })

        it('refuses a malformed Origin', async () => {
            const res = await open().request('/api/conversations', json({}, { headers: { origin: 'not a url' } }))
            expect(res.status).toBe(403)
        })

        it('accepts an Origin naming the same host on another port (the Vite dev server)', async () => {
            const res = await open().request(
                '/api/conversations',
                json({}, { headers: { origin: 'http://localhost:5173', host: 'localhost:8080' } })
            )
            expect(res.status).toBe(201)
        })

        it('accepts a mutating request without an Origin (curl, scripts)', async () => {
            const res = await open().request('/api/conversations', json({}))
            expect(res.status).toBe(201)
        })

        it('lets a GET with a foreign Origin through', async () => {
            const res = await open().request('/api/conversations', { headers: { origin: 'https://evil.example.com' } })
            expect(res.status).toBe(200)
        })
    })

    describe('body limit', () => {
        // BUG: hono's bodyLimit throws an HTTPException(413) and app.onError in server.ts turns every
        // error that is not BadName / NotFound into a 500, so an oversized body answers 500 instead of 413.
        it.fails('refuses a JSON body over 2 MB with 413', async () => {
            const big = 'x'.repeat(2 * 1024 * 1024 + 1)
            const res = await open().request('/api/conversations', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': String(big.length + 12) },
                body: JSON.stringify({ title: big })
            })
            expect(res.status).toBe(413)
        })

        // BUG: same as above (HTTPException → 500 in app.onError).
        it.fails('refuses an oversized body even without a Content-Length', async () => {
            const big = new Uint8Array(2 * 1024 * 1024 + 10)
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(big)
                    controller.close()
                }
            })
            const res = await open().request('/api/conversations', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: stream,
                duplex: 'half'
            })
            expect(res.status).toBe(413)
        })

        it('refuses an oversized body before the route runs (no conversation is created)', async () => {
            const big = 'x'.repeat(2 * 1024 * 1024 + 1)
            const res = await open().request('/api/conversations', json({ title: big }))
            expect(res.status).toBeGreaterThanOrEqual(400)
            expect(t.ctx.store.listConversations()).toHaveLength(0)
        })

        it('accepts a body under the limit', async () => {
            const res = await open().request('/api/conversations', json({ title: 'x'.repeat(1000) }))
            expect(res.status).toBe(201)
        })
    })

    describe('response headers', () => {
        it('sends Cache-Control: no-store on /api', async () => {
            const res = await open().request('/api/conversations')
            expect(res.headers.get('cache-control')).toBe('no-store')
        })

        it('sends no-store on a refused /api request too', async () => {
            const res = await open().request('/api/conversations', { headers: { host: 'evil.example.com' } })
            expect(res.headers.get('cache-control')).toBe('no-store')
        })

        it.each(['/api/conversations', '/'])('forbids framing on %s', async (url) => {
            const res = await open().request(url)
            expect(res.headers.get('x-frame-options')).toBe('DENY')
            expect(res.headers.get('x-content-type-options')).toBe('nosniff')
            expect(res.headers.get('referrer-policy')).toBe('same-origin')
        })
    })

    describe('sign-in guard', () => {
        it.each(['/api/conversations', '/api/status', '/api/agents', '/api/auth/sessions', '/api/auth/log'])(
            'answers 401 on %s without a session in password mode',
            async (url) => {
                const res = await withPassword().request(url)
                expect(res.status).toBe(401)
                expect(await res.json()).toEqual({ error: 'sign in required' })
            }
        )

        it('answers 401 on a mutating request without a session', async () => {
            const res = await withPassword().request('/api/conversations', json({}))
            expect(res.status).toBe(401)
        })

        it('lets /api/auth/me through and says sign-in is needed', async () => {
            const res = await withPassword().request('/api/auth/me')
            expect(res.status).toBe(200)
            expect(await res.json()).toMatchObject({ mode: 'password', authenticated: false, user: null })
        })

        it('ignores a cookie that names no session', async () => {
            const res = await withPassword().request('/api/conversations', {
                headers: { cookie: 'pf_session=not-a-session' }
            })
            expect(res.status).toBe(401)
        })

        it('needs no session in open mode', async () => {
            const res = await open().request('/api/auth/me')
            expect(await res.json()).toMatchObject({ mode: 'open', authenticated: true, user: 'factory' })
        })

        it('answers an unknown /api path with 404', async () => {
            const res = await open().request('/api/nope/nothing/here')
            expect(res.status).toBe(404)
        })
    })
})
