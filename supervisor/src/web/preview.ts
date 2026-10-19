import { timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage } from 'node:http'
import net from 'node:net'
import { type Duplex, Readable } from 'node:stream'

import { type Context, Hono } from 'hono'
import { getCookie } from 'hono/cookie'

import { createLogger } from '../logger.js'
import { SESSION_COOKIE } from './auth.js'
import type { AppContext, Env } from './context.js'
import { clientIp } from './request.js'

const log = createLogger('preview')

/** How long the app gets to accept a WebSocket's connection. */
const UPGRADE_CONNECT_MS = 10_000

/** The most a request body to a preview may carry (a file upload in the app). */
export const PREVIEW_BODY_MAX = 50 * 1024 * 1024

/**
 * What every preview response gets instead of the factory's own headers: an opaque origin (no
 * `allow-same-origin`), so the agent's JavaScript cannot call `/api` with the owner's cookie
 * (its mutating requests carry `Origin: null`, which the API refuses), and open CORS, since every
 * request of such a page to its own server is cross-origin; the path key is what guards it.
 */
export const PREVIEW_CSP =
    'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock'

const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
])

const sameKey = (a: string, b: string) =>
    a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b))

const html = (title: string, body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:15px/1.5 ui-monospace,monospace;margin:15vh auto;max-width:36rem;padding:0 16px;color:#222;background:#faf8f3}a{color:inherit}</style></head><body>${body}</body></html>`

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/** The `cookie` header without the factory's own session: the app never sees it. */
export function withoutSession(cookie: string | undefined): string | null {
    if (!cookie) return null
    const kept = cookie
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith(`${SESSION_COOKIE}=`))
    return kept.length ? kept.join('; ') : null
}

/** A `Location` the app sent, as the browser must follow it: under the prefix when the app thinks it lives at `/`. */
export function rewriteLocation(location: string, base: string, strip: boolean, upstream: string): string {
    let target = location
    // An absolute URL back to the app itself (it believes it is `localhost:<port>`): keep only the path.
    try {
        const url = new URL(location)
        if (url.host === upstream || url.hostname === 'localhost' || url.hostname === '127.0.0.1')
            target = `${url.pathname}${url.search}${url.hash}`
        else return location
    } catch {
        // a path, not a URL
    }
    // `//host/…` is another site to a browser: never sent away from the preview through the factory's address.
    if (target.startsWith('//') || target.startsWith('/\\')) return base
    if (!target.startsWith('/')) return target
    if (!strip || target.startsWith(base)) return target
    return `${base}${target.slice(1)}`
}

/** A `Set-Cookie` of the app scoped to its prefix (an app at `/` would set `Path=/`, which is the factory's). */
export function rewriteSetCookie(cookie: string, base: string, strip: boolean): string {
    const parts = cookie.split(';').map((p) => p.trim())
    const kept = parts.filter((p, i) => i === 0 || !/^(domain|path)=/i.test(p))
    const path = parts.find((p) => /^path=/i.test(p))?.slice(5) ?? '/'
    const scoped = strip ? `${base}${path.replace(/^\//, '')}` : path.startsWith(base) ? path : base
    return [...kept, `Path=${scoped}`].join('; ')
}

/** Whether the request may open the signed-in address: a session, or open mode with a local / allowed Host. */
function signedIn(c: Context<Env>, app: AppContext): boolean {
    if (app.auth.mode === 'open') {
        const host = (c.req.header('host') ?? '').split(':')[0].toLowerCase()
        return (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            host.endsWith('.localhost') ||
            app.config.web.allowedHosts.has(host)
        )
    }
    return Boolean(app.auth.sessionOf(getCookie(c, SESSION_COOKIE), clientIp(c), true))
}

/**
 * `/preview/<project>/…`: the app a project's agent runs, through the factory. The bare address
 * needs the factory's sign-in and then redirects to the project's keyed base
 * (`/preview/<project>/<key>/`); under the key every request goes to the app as it is (or without
 * the prefix, when the agent said `strip_prefix`), with the preview's own headers.
 */
export function previewRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.all('/:project/*', async (c) => {
        const ctx = c.get('app')
        const project = c.req.param('project')
        // Only a project's own name makes (or reads) a key: a stranger's guesses leave nothing behind.
        if (!ctx.tasks.projects().includes(project))
            return c.html(html('No such project', `<p>No project ${escape(project)}.</p>`), 404)
        const prefix = `/preview/${encodeURIComponent(project)}/`
        // The path as the browser sent it (still percent-encoded): it goes to the app unchanged.
        const raw = new URL(c.req.url).pathname
        const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : ''
        const [first, ...tail] = rest.split('/')
        const key = ctx.previews.key(project)
        const upstream = ctx.previews.upstream(project)

        if (!sameKey(first ?? '', key)) {
            if (!signedIn(c, ctx)) {
                // A link from Telegram is a cross-site navigation, which carries no SameSite=Strict
                // cookie: the same address once more from this origin does.
                const url = new URL(c.req.url)
                if (!url.searchParams.has('pf_again')) {
                    url.searchParams.set('pf_again', '1')
                    const again = `${url.pathname}${url.search}`
                    return c.html(
                        `<!doctype html><meta http-equiv="refresh" content="0;url=${escape(again)}"><a href="${escape(again)}">Continue</a>`
                    )
                }
                return c.redirect(`/projects/${encodeURIComponent(project)}`, 302)
            }
            if (!upstream)
                return c.html(
                    html(
                        `No preview · ${escape(project)}`,
                        `<p>No preview for <b>${escape(project)}</b> right now.</p><p>Ask its agent to show the app (it calls <code>preview</code>), or open <a href="/projects/${encodeURIComponent(project)}">the project</a>.</p>`
                    ),
                    404
                )
            // The bare address and anything under it: the same path under the key.
            const url = new URL(c.req.url)
            url.searchParams.delete('pf_again')
            return c.redirect(`${prefix}${key}/${rest}${url.search}`, 302)
        }
        if (!upstream)
            return c.html(html('Preview stopped', `<p>The preview of ${escape(project)} is stopped.</p>`), 404)
        return proxy(c.req.raw, upstream, `${prefix}${key}/`, tail.join('/'))
    })

    app.all('/:project', (c) => c.redirect(`/preview/${encodeURIComponent(c.req.param('project'))}/`, 301))

    return app
}

const CORS_PREFLIGHT = (request: Request) =>
    new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': request.headers.get('access-control-request-method') ?? '*',
            'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? '*',
            'access-control-max-age': '600'
        }
    })

/** Counts the body as it streams and fails it past PREVIEW_BODY_MAX. */
function bounded(body: ReadableStream<Uint8Array>): Readable {
    let seen = 0
    return Readable.fromWeb(
        body.pipeThrough<Uint8Array>(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    seen += chunk.byteLength
                    if (seen > PREVIEW_BODY_MAX) controller.error(new Error('request body too large'))
                    else controller.enqueue(chunk)
                }
            })
        )
    )
}

const notAnswering = (project: string, port: number) =>
    new Response(
        html(
            'Preview not answering',
            `<p>The app of <b>${escape(project)}</b> does not answer on port ${port}.</p><p>Is it still running, and listening on 0.0.0.0?</p>`
        ),
        { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
    )

/**
 * One request to the app through `node:http` (fetch cannot set `Host`, and dev servers refuse a
 * Host they do not know): the app believes it is on `localhost:<port>`, gets no factory cookie or
 * authorization, and answers with the preview's own headers.
 */
async function proxy(
    request: Request,
    upstream: NonNullable<ReturnType<AppContext['previews']['upstream']>>,
    base: string,
    rest: string
): Promise<Response> {
    if (request.method === 'OPTIONS' && request.headers.has('access-control-request-method'))
        return CORS_PREFLIGHT(request)
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > PREVIEW_BODY_MAX) return new Response('request body too large', { status: 413 })

    const { preview } = upstream
    const incoming = new URL(request.url)
    const path = `${preview.strip ? `/${rest}` : `${base}${rest}`}${incoming.search}`
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
        if (HOP_BY_HOP.has(name) || name === 'host' || name === 'cookie' || name === 'authorization') return
        headers[name] = value
    })
    const cookie = withoutSession(request.headers.get('cookie') ?? undefined)
    if (cookie) headers.cookie = cookie
    headers.host = `localhost:${preview.port}`
    headers['x-forwarded-host'] = incoming.host
    headers['x-forwarded-proto'] = request.headers.get('x-forwarded-proto') ?? incoming.protocol.replace(':', '')
    if (preview.strip) headers['x-forwarded-prefix'] = base.replace(/\/$/, '')
    const body = request.body && request.method !== 'GET' && request.method !== 'HEAD' ? bounded(request.body) : null

    let response: http.IncomingMessage
    try {
        response = await new Promise<http.IncomingMessage>((resolve, reject) => {
            const req = http.request(
                { host: upstream.host, port: upstream.port, method: request.method, path, headers },
                resolve
            )
            req.on('error', reject)
            if (body) {
                body.on('error', (error) => req.destroy(error))
                body.pipe(req)
            } else req.end()
        })
    } catch (error) {
        log.debug(`${preview.project}: ${error instanceof Error ? error.message : String(error)}`)
        return notAnswering(preview.project, preview.port)
    }

    const out = new Headers()
    for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || name === 'set-cookie') continue
        if (name.startsWith('access-control-') || name === 'x-frame-options') continue
        if (name === 'location') {
            out.set('location', rewriteLocation(String(value), base, preview.strip, `localhost:${preview.port}`))
            continue
        }
        for (const one of Array.isArray(value) ? value : [value]) out.append(name, one)
    }
    for (const line of response.headers['set-cookie'] ?? [])
        out.append('set-cookie', rewriteSetCookie(line, base, preview.strip))
    out.append('content-security-policy', PREVIEW_CSP)
    out.set('access-control-allow-origin', '*')
    out.set('cross-origin-resource-policy', 'cross-origin')
    out.set('x-content-type-options', 'nosniff')
    out.set('referrer-policy', 'no-referrer')
    const status = response.statusCode ?? 502
    const empty = request.method === 'HEAD' || status === 204 || status === 304
    if (empty) response.resume()
    return new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
        status,
        statusText: response.statusMessage,
        headers: out
    })
}

/**
 * WebSocket upgrades under a preview's key (Vite HMR, Next dev): the handshake goes to the app with
 * the same rewrites, then the two sockets are piped. Anything else is closed.
 */
export function previewUpgrade(ctx: AppContext) {
    return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        // Node drops its own error listener before `upgrade`: an unhandled reset would take the process down.
        socket.on('error', () => socket.destroy())
        const fail = (status: string): void => {
            if (!socket.writable) socket.destroy()
            else socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
        }
        try {
            const url = new URL(req.url ?? '/', 'http://factory')
            const match = /^\/preview\/([^/]+)\/([^/]+)\/(.*)$/.exec(url.pathname)
            if (!match) return fail('404 Not Found')
            const project = decodeURIComponent(match[1])
            if (!ctx.tasks.projects().includes(project)) return fail('404 Not Found')
            if (!sameKey(match[2], ctx.previews.key(project))) return fail('404 Not Found')
            const upstream = ctx.previews.upstream(project)
            if (!upstream) return fail('404 Not Found')
            const base = `/preview/${match[1]}/${match[2]}/`
            const path = upstream.preview.strip ? `/${match[3]}` : `${base}${match[3]}`
            const lines = [`${req.method ?? 'GET'} ${path}${url.search} HTTP/1.1`]
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = req.rawHeaders[i]
                const lower = name.toLowerCase()
                if (lower === 'host' || lower === 'cookie' || lower === 'authorization') continue
                lines.push(`${name}: ${req.rawHeaders[i + 1]}`)
            }
            const cookie = withoutSession(req.headers.cookie)
            if (cookie) lines.push(`cookie: ${cookie}`)
            lines.push(`host: localhost:${upstream.preview.port}`)
            const target = net.connect(upstream.port, upstream.host, () => {
                target.setTimeout(0)
                target.write(`${lines.join('\r\n')}\r\n\r\n`)
                if (head.length) target.write(head)
                target.pipe(socket)
                socket.pipe(target)
            })
            // An app that never answers the connection must not hold both sockets open.
            target.setTimeout(UPGRADE_CONNECT_MS, () => {
                target.destroy()
                fail('504 Gateway Timeout')
            })
            target.on('error', () => fail('502 Bad Gateway'))
            target.on('close', () => socket.destroy())
            socket.on('close', () => target.destroy())
        } catch {
            fail('400 Bad Request')
        }
    }
}
