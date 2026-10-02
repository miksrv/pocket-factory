import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import { SESSION_COOKIE } from '../auth.js'
import type { Env } from '../context.js'
import { clientOf, isSecure } from '../request.js'

/**
 * The web UI's sign-in. `/me` and `/login` are reachable without a session
 * (the guard in server.ts lets them through), everything else needs one.
 */
export function authRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** Who is asking: the mode, whether the browser is signed in, and the lock policy for the sign-in form. */
    app.get('/me', (c) => {
        const { auth } = c.get('app')
        const session = c.get('session')
        return c.json({
            mode: auth.mode,
            authenticated: auth.mode === 'open' || session !== null,
            user: auth.mode === 'open' || session ? auth.username : null,
            session: session ? { created_at: session.created_at, ip: session.ip } : null,
            policy: auth.policy
        })
    })

    app.post('/login', async (c) => {
        const { auth } = c.get('app')
        if (auth.mode === 'open') return c.json({ error: 'sign-in is not enabled: WEB_AUTH_PASSWORD is empty' }, 400)
        const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null
        if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') return c.json({ error: 'username and password are required' }, 400)
        const client = clientOf(c)
        const outcome = auth.login(body.username, body.password, client)
        if (!outcome.ok) {
            if (outcome.reason === 'locked') {
                const seconds = Math.max(1, Math.ceil((new Date(outcome.locked_until).getTime() - Date.now()) / 1000))
                c.header('Retry-After', String(seconds))
                return c.json({ error: 'too many failed sign-ins', locked_until: outcome.locked_until }, 429)
            }
            return c.json({ error: 'wrong username or password', attempts_left: outcome.attempts_left, locked_until: outcome.locked_until }, 401)
        }
        setCookie(c, SESSION_COOKIE, outcome.token, {
            path: '/',
            httpOnly: true,
            sameSite: 'Strict',
            secure: isSecure(c),
            maxAge: Math.floor(auth.policy.session_days * 86_400)
        })
        return c.json({ ok: true, user: auth.username, session: { created_at: outcome.session.created_at, ip: outcome.session.ip } })
    })

    app.post('/logout', (c) => {
        c.get('app').auth.logout(getCookie(c, SESSION_COOKIE))
        deleteCookie(c, SESSION_COOKIE, { path: '/' })
        return c.json({ ok: true })
    })

    /** Sign out every other browser; this one stays. */
    app.post('/logout-others', (c) => c.json({ signed_out: c.get('app').auth.logoutOthers(getCookie(c, SESSION_COOKIE)) }))

    app.get('/sessions', (c) => c.json(c.get('app').auth.sessions(getCookie(c, SESSION_COOKIE))))

    app.delete('/sessions/:id', (c) => {
        const id = c.req.param('id')
        if (!/^[0-9a-f]{64}$/.test(id)) return c.json({ error: 'not a session id' }, 400)
        return c.json({ revoked: c.get('app').auth.revoke(id) })
    })

    /** The last sign-in attempts, newest first. */
    app.get('/log', (c) => {
        const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 50))
        return c.json(c.get('app').auth.attempts(limit))
    })

    return app
}
