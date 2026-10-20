import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import path from 'node:path'

import { serve } from '@hono/node-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'
import {
    PREVIEW_BODY_MAX,
    PREVIEW_CSP,
    previewUpgrade,
    rewriteLocation,
    rewriteSetCookie,
    withoutSession
} from './preview.js'

/** The app an agent would run: echoes what reached it, redirects, sets a cookie, answers a WebSocket handshake. */
function startUpstream(): Promise<{ server: http.Server; port: number; seen: http.IncomingMessage[] }> {
    const seen: http.IncomingMessage[] = []
    const server = http.createServer((req, res) => {
        seen.push(req)
        if (req.url?.endsWith('/upload')) {
            // Answers only once the whole body arrived, like an app storing a file.
            req.resume()
            req.on('end', () => res.end('stored'))
            return
        }
        if (req.url?.endsWith('/go')) {
            res.writeHead(302, { location: '/login' })
            return res.end()
        }
        res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': 'sid=1; Path=/; HttpOnly',
            'x-frame-options': 'DENY',
            'access-control-allow-credentials': 'true'
        })
        res.end(JSON.stringify({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null }))
    })
    server.on('upgrade', (req, socket) => {
        seen.push(req)
        if (req.url?.endsWith('/refuse')) {
            socket.end('HTTP/1.1 403 Forbidden\r\nset-cookie: pf_session=evil; Path=/\r\ncontent-length: 4\r\n\r\nnope')
            return
        }
        // Half a status line, then nothing.
        if (req.url?.endsWith('/stall')) return void socket.write('HTTP/1.1 101 Swi')
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
                'set-cookie: pf_session=evil; Path=/\r\nset-cookie: hmr=1; Path=/\r\n\r\nhello'
        )
        if (req.url?.endsWith('/reset')) setTimeout(() => (socket as net.Socket).resetAndDestroy(), 20)
        else socket.end()
    })
    return new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, seen }))
    )
}

describe('previews', () => {
    let t: TestApp
    let upstream: Awaited<ReturnType<typeof startUpstream>>
    beforeEach(async () => {
        t = createTestApp({ web: { authPassword: 'pw' } })
        t.ctx.catalog.save('projects', 'shop', { frontmatter: {}, body: '' })
        fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'shop'))
        upstream = await startUpstream()
    })
    afterEach(async () => {
        upstream.server.close()
        await t.cleanup()
    })

    const signIn = async () => {
        const res = await t.request('/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'factory', password: 'pw' })
        })
        return (res.headers.get('set-cookie') ?? '').split(';')[0]
    }

    it('rewrites what the app says about itself to the prefix', () => {
        const base = '/preview/shop/k/'
        expect(rewriteLocation('/login', base, true, 'localhost:3000')).toBe('/preview/shop/k/login')
        expect(rewriteLocation('http://localhost:3000/a?b=1', base, true, 'localhost:3000')).toBe(
            '/preview/shop/k/a?b=1'
        )
        expect(rewriteLocation('/preview/shop/k/x', base, false, 'localhost:3000')).toBe('/preview/shop/k/x')
        expect(rewriteLocation('https://github.com/login', base, true, 'localhost:3000')).toBe(
            'https://github.com/login'
        )
        expect(rewriteSetCookie('sid=1; Path=/; Domain=localhost; HttpOnly', base, true)).toBe(
            'sid=1; HttpOnly; Path=/preview/shop/k/'
        )
        expect(withoutSession('pf_session=abc; theme=dark')).toBe('theme=dark')
        expect(withoutSession('pf_session=abc')).toBeNull()
    })

    it('needs the sign-in for the address, then sends the browser to the keyed base', async () => {
        // A link from elsewhere (Telegram) carries no Strict cookie: the page asks once more from here.
        const first = await t.request('/preview/shop/')
        expect(first.status).toBe(200)
        expect(await first.text()).toContain('url=/preview/shop/?pf_again=1')
        const anonymous = await t.request('/preview/shop/?pf_again=1')
        expect(anonymous.status).toBe(302)
        expect(anonymous.headers.get('location')).toBe('/projects/shop')
        const cookie = await signIn()
        const none = await t.request('/preview/shop/', { headers: { cookie } })
        expect(none.status).toBe(404)
        expect(await none.text()).toContain('No preview for <b>shop</b>')
        await t.ctx.previews.open('shop', upstream.port)
        const res = await t.request('/preview/shop/app?x=1&pf_again=1', { headers: { cookie } })
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe(`${t.ctx.previews.base('shop')}app?x=1`)
        // A path with a space or Cyrillic reaches the app as the browser encoded it.
        const encoded = await t.request(`${t.ctx.previews.base('shop')}my%20file/%D1%84.png`)
        expect(((await encoded.json()) as { url: string }).url).toBe(
            `${t.ctx.previews.base('shop')}my%20file/%D1%84.png`
        )
        expect((await t.request('/preview/nope/', { headers: { cookie } })).status).toBe(404)
    })

    it('proxies under the key with the full path, an opaque origin, and never the session cookie', async () => {
        await t.ctx.previews.open('shop', upstream.port)
        const base = t.ctx.previews.base('shop')
        // No session at all: the key is the access (a sandboxed page sends no cookies with its fetches).
        const res = await t.request(`${base}api/items?q=1`, { headers: { cookie: 'pf_session=secret; theme=dark' } })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            url: `${base}api/items?q=1`,
            host: `localhost:${upstream.port}`,
            cookie: 'theme=dark'
        })
        expect(res.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
        expect(res.headers.get('access-control-allow-credentials')).toBeNull()
        expect(res.headers.get('x-frame-options')).toBeNull()
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
        expect(res.headers.get('set-cookie')).toBe(`sid=1; HttpOnly; Path=${base}`)
        // A wrong key is no key.
        expect((await t.request('/preview/shop/0000/api?pf_again=1')).status).toBe(302)
    })

    it('strips the prefix for an app that serves at /, and answers CORS preflights itself', async () => {
        await t.ctx.previews.open('shop', upstream.port, { strip: true })
        const base = t.ctx.previews.base('shop')
        expect(((await (await t.request(`${base}a/b`)).json()) as { url: string }).url).toBe('/a/b')
        const redirect = await t.request(`${base}go`)
        expect(redirect.status).toBe(302)
        expect(redirect.headers.get('location')).toBe(`${base}login`)
        const preflight = await t.request(`${base}api`, {
            method: 'OPTIONS',
            headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
        })
        expect(preflight.status).toBe(204)
        expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type')
    })

    it('says so when the app does not answer, and stops with the owner', async () => {
        await t.ctx.previews.open('shop', upstream.port)
        upstream.server.close()
        upstream.server.closeAllConnections()
        const res = await t.request(`${t.ctx.previews.base('shop')}`)
        expect(res.status).toBe(502)
        expect(await t.ctx.previews.close('shop', 'stopped by the owner')).toBe(true)
        expect(t.ctx.previews.get('shop')).toBeNull()
    })

    it('refuses a chunked upload past the limit with 413, not as an app that does not answer', async () => {
        await t.ctx.previews.open('shop', upstream.port)
        const chunk = new Uint8Array(1024 * 1024)
        let sent = 0
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent++ > PREVIEW_BODY_MAX / chunk.byteLength) controller.close()
                else controller.enqueue(chunk)
            }
        })
        const res = await t.request(`${t.ctx.previews.base('shop')}upload`, {
            method: 'POST',
            body,
            duplex: 'half'
        })
        expect(res.status).toBe(413)
    })

    it('passes a WebSocket handshake under the key to the app, and closes anything else', async () => {
        await t.ctx.previews.open('shop', upstream.port)
        const base = t.ctx.previews.base('shop')
        const server = serve({ fetch: t.app.fetch, hostname: '127.0.0.1', port: 0 })
        server.on('upgrade', previewUpgrade(t.ctx, { timeoutMs: 300 }))
        await new Promise((resolve) => server.once('listening', resolve))
        const port = (server.address() as AddressInfo).port
        const handshake = (url: string) =>
            new Promise<string>((resolve) => {
                const socket = net.connect(port, '127.0.0.1', () =>
                    socket.write(
                        `GET ${url} HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\ncookie: pf_session=x\r\n\r\n`
                    )
                )
                let data = ''
                socket.on('data', (chunk) => (data += chunk.toString()))
                socket.on('close', () => resolve(data))
            })
        try {
            const answer = await handshake(`${base}hmr`)
            expect(answer).toContain('101 Switching Protocols')
            expect(answer).toMatch(/hello$/)
            // The app's cookies get the prefix as over HTTP; one named like the factory's session never passes.
            expect(answer).toContain(`set-cookie: hmr=1; Path=${base}\r\n`)
            expect(answer).not.toContain('pf_session')
            const req = upstream.seen.at(-1)!
            expect(req.url).toBe(`${base}hmr`)
            expect(req.headers.cookie).toBeUndefined()
            expect(await handshake('/preview/shop/wrong/hmr')).toContain('404')
            // A refused upgrade is its status alone; a reset after the upgrade cuts the socket, no HTTP inside it.
            const refused = await handshake(`${base}refuse`)
            expect(refused).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/)
            expect(refused).not.toContain('pf_session')
            expect(refused).not.toContain('nope')
            const reset = await handshake(`${base}reset`)
            expect(reset).toMatch(/hello$/)
            expect(reset).not.toContain('502')
            expect(await handshake(`${base}stall`)).toMatch(/^HTTP\/1\.1 504 Gateway Timeout\r\n/)
            // A malformed escape must not take the process down; a stranger's name leaves no key behind.
            expect(await handshake('/preview/%E0%A4%A/x/hmr')).toContain('400')
            expect(await handshake('/preview/stranger/x/hmr')).toContain('404')
            expect(t.ctx.store.getMeta<Record<string, string>>('preview.keys')).not.toHaveProperty('stranger')
        } finally {
            server.close()
        }
    })
})
