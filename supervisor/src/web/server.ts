import fs from 'node:fs'
import path from 'node:path'

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'

import { BadName, NotFound } from '../files/catalog.js'
import { MAX_ATTACHMENT_BYTES } from '../files/inbox.js'
import { createLogger } from '../logger.js'
import { ACTIVE_HEADER, SESSION_COOKIE } from './auth.js'
import type { AppContext, Env } from './context.js'
import { clientIp, clientOf } from './request.js'
import { activityRoutes } from './routes/activity.js'
import { auditRoutes } from './routes/audit.js'
import { authRoutes } from './routes/auth.js'
import { conversationRoutes } from './routes/conversations.js'
import { fileRoutes } from './routes/files.js'
import { hostRoutes } from './routes/hosts.js'
import { mcpRoutes } from './routes/mcp.js'
import { toolRoutes } from './routes/models.js'
import { presetRoutes } from './routes/presets.js'
import { scheduleRoutes } from './routes/schedules.js'
import { sessionRoutes } from './routes/sessions.js'
import { settingsRoutes } from './routes/settings.js'
import { statusRoutes } from './routes/status.js'
import { taskRoutes } from './routes/tasks.js'
import { toolchainRoutes } from './routes/toolchains.js'
import { usageRoutes } from './routes/usage.js'

const log = createLogger('web')

/** The host name from a Host header, without the port; IPv6 literals keep their brackets stripped. */
function hostnameOf(header: string | undefined): string {
    const raw = (header ?? '').trim().toLowerCase()
    if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'))
    return raw.split(':')[0]
}

const isLocal = (host: string) =>
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')

export function createApp(app: AppContext): Hono<Env> {
    const hono = new Hono<Env>()
    const { web } = app.config

    hono.use('*', async (c, next) => {
        c.set('app', app)
        await next()
    })

    // The UI controls an agent with repository and host credentials. The
    // sign-in below is the floor; put Tailscale / Caddy / Cloudflare Access
    // in front when the port is reachable from outside.
    hono.use('*', secureHeaders({ xFrameOptions: 'DENY', referrerPolicy: 'same-origin' }))

    // Prompts and Markdown files are small; anything bigger is a mistake or an attack.
    // An uploaded file (a photo, a log) gets Telegram's own ceiling instead.
    const smallBodies = bodyLimit({ maxSize: 2 * 1024 * 1024 })
    const uploads = bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024 })
    hono.use('/api/*', (c, next) =>
        c.req.method === 'POST' && /^\/api\/conversations\/[^/]+\/attachments$/.test(c.req.path)
            ? uploads(c, next)
            : smallBodies(c, next)
    )

    hono.use('/api/*', async (c, next) => {
        // What the API answers is the owner's: never a shared cache's, never the browser's after sign-out.
        c.header('Cache-Control', 'no-store')
        const host = hostnameOf(c.req.header('host'))
        // Without a password the API trusts whoever reaches the port, so it
        // must at least refuse a DNS-rebinding page, which arrives with a
        // foreign Host. Local names are always allowed; WEB_ALLOWED_HOSTS
        // adds a LAN or tunnel name. With a password the browser holds no
        // session for a foreign name, so any Host is fine.
        if (!web.authPassword && !isLocal(host) && !web.allowedHosts.has(host)) {
            return c.json({ error: `host "${host}" not allowed; set WEB_ALLOWED_HOSTS or WEB_AUTH_PASSWORD` }, 403)
        }
        // A cross-site form or fetch carries a foreign Origin. The session
        // cookie is SameSite=Strict, and a script's Basic header is attached
        // by the browser cross-site too, and the routes parse JSON whatever
        // the content type, so the check applies in both modes. Requests
        // without an Origin (curl, scripts) pass.
        const origin = c.req.header('origin')
        if (origin && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            let originHost = ''
            try {
                originHost = new URL(origin).hostname.toLowerCase()
            } catch {
                // malformed: treated as foreign
            }
            if (originHost !== host) return c.json({ error: 'cross-site request refused' }, 403)
        }
        await next()
    })

    // Sign-in. The SPA shell and its assets are public (they hold no data);
    // every API route but /auth/me and /auth/login needs a session cookie, or
    // a Basic header for a script. 401 is what the UI turns into its sign-in
    // page.
    hono.use('/api/*', async (c, next) => {
        const { auth } = app
        c.set('session', null)
        if (auth.mode === 'open') return next()
        const session = auth.sessionOf(getCookie(c, SESSION_COOKIE), clientIp(c), c.req.header(ACTIVE_HEADER) === '1')
        if (session) {
            c.set('session', session)
            return next()
        }
        if (c.req.path === '/api/auth/me' || (c.req.path === '/api/auth/login' && c.req.method === 'POST'))
            return next()
        if (auth.basic(c.req.header('authorization'), clientOf(c))) return next()
        return c.json({ error: 'sign in required' }, 401)
    })

    hono.onError((error, c) => {
        if (error instanceof BadName) return c.json({ error: error.message }, 400)
        if (error instanceof NotFound) return c.json({ error: error.message }, 404)
        log.error(`${c.req.method} ${c.req.path} failed`, error)
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
    })

    const api = new Hono<Env>()
    api.route('/auth', authRoutes())
    api.route('/status', statusRoutes())
    api.route('/tasks', taskRoutes())
    api.route('/usage', usageRoutes())
    api.route('/conversations', conversationRoutes())
    api.route('/sessions', sessionRoutes())
    api.route('/presets', presetRoutes())
    api.route('/audit', auditRoutes())
    api.route('/activity', activityRoutes())
    api.route('/tools', toolRoutes())
    api.route('/hosts', hostRoutes())
    api.route('/mcp', mcpRoutes())
    api.route('/settings', settingsRoutes())
    api.route('/toolchains', toolchainRoutes())
    // Before the file routes: /schedules/status and /schedules/:name/… must not be taken for a file name.
    api.route('/schedules', scheduleRoutes())
    api.route('/', fileRoutes())
    api.notFound((c) => c.json({ error: 'not found' }, 404))
    hono.route('/api', api)

    // Built SPA (web/dist). Unknown paths fall back to index.html for the router.
    if (fs.existsSync(path.join(web.distDir, 'index.html'))) {
        const root = path.relative(process.cwd(), web.distDir) || '.'
        hono.use('/*', serveStatic({ root }))
        hono.get('/*', (c) =>
            // An unknown API path must not turn into the SPA shell.
            c.req.path.startsWith('/api/')
                ? c.json({ error: 'not found' }, 404)
                : c.html(fs.readFileSync(path.join(web.distDir, 'index.html'), 'utf8'))
        )
    } else {
        hono.get('/', (c) => c.text('Pocket Factory API is up; the web UI is not built (yarn build in web/).'))
    }

    return hono
}

export function startServer(app: AppContext): void {
    const { host, port, authPassword } = app.config.web
    const hono = createApp(app)
    serve({ fetch: hono.fetch, hostname: host, port }, (info) => {
        log.info(
            `listening on http://${info.address}:${info.port}${authPassword ? ' (sign-in required)' : ' (NO AUTH — keep it on localhost or behind a proxy)'}`
        )
    })
}
