import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTestApp, json, type RequestOptions, type TestApp, type TestAppOptions } from '../test/app.js'
import { describeUserAgent, type LoginNotice } from './auth.js'

const PASSWORD = 'correct horse'
const START = new Date('2026-10-06T12:00:00.000Z')

/** The cookie value a response sets, if any. */
function sessionCookie(res: Response): string | null {
    const header = res.headers.get('set-cookie') ?? ''
    const match = /pf_session=([^;]*)/.exec(header)
    return match ? match[1] : null
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

describe('web sign-in', () => {
    let t: TestApp

    const setup = (options: TestAppOptions = {}) => {
        t = createTestApp({ ...options, web: { authPassword: PASSWORD, ...options.web } })
        return t
    }

    const login = (password = PASSWORD, init: RequestOptions = {}, username = 'factory') =>
        t.request('/api/auth/login', json({ username, password }, init))

    const signIn = async (init: RequestOptions = {}) => {
        const res = await login(PASSWORD, init)
        expect(res.status).toBe(200)
        return sessionCookie(res)!
    }

    /** What the SPA sends while the owner is at the page. */
    const active: RequestOptions = { headers: { 'x-factory-active': '1' } }

    const withCookie = (token: string, init: RequestOptions = {}): RequestOptions => {
        const headers = new Headers(init.headers)
        headers.set('cookie', `pf_session=${token}`)
        return { ...init, headers }
    }

    afterEach(async () => {
        vi.useRealTimers()
        await t.cleanup()
    })

    describe('login', () => {
        it('sets an HttpOnly, SameSite=Strict session cookie that opens the API', async () => {
            setup()
            const res = await login()
            expect(res.status).toBe(200)
            expect(await res.json()).toMatchObject({ ok: true, user: 'factory', session: { ip: '127.0.0.1' } })
            const header = res.headers.get('set-cookie')!
            expect(header).toMatch(/HttpOnly/)
            expect(header).toMatch(/SameSite=Strict/)
            expect(header).toMatch(/Path=\//)
            expect(header).toMatch(/Max-Age=2592000/)
            expect(header).not.toMatch(/Secure/)
            const token = sessionCookie(res)!
            expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

            const me = await t.request('/api/auth/me', withCookie(token))
            expect(await me.json()).toMatchObject({ mode: 'password', authenticated: true, user: 'factory' })
            expect((await t.request('/api/conversations', withCookie(token))).status).toBe(200)
        })

        it('marks the cookie Secure behind an https proxy', async () => {
            setup()
            const res = await login(PASSWORD, { headers: { 'x-forwarded-proto': 'https' } })
            expect(res.headers.get('set-cookie')).toMatch(/Secure/)
        })

        it('stores only a hash of the token', async () => {
            setup()
            const token = await signIn()
            const [session] = t.ctx.store.listWebSessions()
            expect(session.id).toMatch(/^[0-9a-f]{64}$/)
            expect(session.id).not.toContain(token)
        })

        it.each([
            ['wrong password', 'factory', 'nope'],
            ['wrong user', 'admin', PASSWORD]
        ])('refuses a %s with 401 and the attempts left', async (_case, username, password) => {
            setup()
            const res = await login(password, {}, username)
            expect(res.status).toBe(401)
            expect(await res.json()).toEqual({
                error: 'wrong username or password',
                attempts_left: 4,
                locked_until: null
            })
            expect(sessionCookie(res)).toBeNull()
            expect(t.ctx.store.listLoginAttempts()[0]).toMatchObject({ result: 'failed', username, ip: '127.0.0.1' })
        })

        it.each([{}, { username: 'factory' }, { username: 1, password: 'x' }])(
            'refuses a malformed body %j with 400',
            async (body) => {
                setup()
                const res = await t.request('/api/auth/login', json(body))
                expect(res.status).toBe(400)
            }
        )

        it('is not available in open mode', async () => {
            t = createTestApp()
            const res = await login()
            expect(res.status).toBe(400)
        })

        it('records the successful attempt with the user agent', async () => {
            setup()
            await login(PASSWORD, { headers: { 'user-agent': 'curl/8.4.0' } })
            expect(t.ctx.store.listLoginAttempts()[0]).toMatchObject({
                result: 'ok',
                username: 'factory',
                user_agent: 'curl/8.4.0'
            })
        })
    })

    describe('lockout', () => {
        const fail = (init: RequestOptions = {}) => login('wrong', init)

        it('locks an address after WEB_LOGIN_MAX_FAILURES failures (429 + Retry-After)', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(START)
            setup({ web: { loginMaxFailures: 3, loginLockMinutes: 10 } })
            expect(((await (await fail()).json()) as { attempts_left: number }).attempts_left).toBe(2)
            expect(((await (await fail()).json()) as { attempts_left: number }).attempts_left).toBe(1)
            const third = await fail()
            expect(third.status).toBe(401)
            expect(await third.json()).toMatchObject({ attempts_left: 0, locked_until: '2026-10-06T12:10:00.000Z' })

            // The right password does not help while the address is locked.
            const locked = await login()
            expect(locked.status).toBe(429)
            expect(locked.headers.get('retry-after')).toBe('600')
            expect(await locked.json()).toEqual({
                error: 'too many failed sign-ins',
                locked_until: '2026-10-06T12:10:00.000Z'
            })
            expect(sessionCookie(locked)).toBeNull()
        })

        it('records attempts during a lock as locked, without counting or extending it', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(START)
            setup({ web: { loginMaxFailures: 2, loginLockMinutes: 10 } })
            await fail()
            await fail()
            vi.setSystemTime(new Date(START.getTime() + 5 * 60_000))
            const during = await fail()
            expect(during.status).toBe(429)
            expect(during.headers.get('retry-after')).toBe('300')
            expect(await during.json()).toMatchObject({ locked_until: '2026-10-06T12:10:00.000Z' })
            expect(t.ctx.store.listLoginAttempts().map((a) => a.result)).toEqual(['locked', 'failed', 'failed'])

            // Once the lock has run out, the owner signs in.
            vi.setSystemTime(new Date(START.getTime() + 10 * 60_000 + 1000))
            const after = await login()
            expect(after.status).toBe(200)
        })

        it('keeps other addresses free', async () => {
            setup({ web: { loginMaxFailures: 2 } })
            await fail({ ip: '203.0.113.1' })
            await fail({ ip: '203.0.113.1' })
            expect((await login(PASSWORD, { ip: '203.0.113.1' })).status).toBe(429)
            expect((await login(PASSWORD, { ip: '203.0.113.2' })).status).toBe(200)
        })

        it('locks everyone after four times the threshold from any mix of addresses', async () => {
            setup({ web: { loginMaxFailures: 3 } })
            for (let i = 1; i <= 6; i++) {
                await fail({ ip: `198.51.100.${i}` })
                await fail({ ip: `198.51.100.${i}` })
            }
            expect((await login(PASSWORD, { ip: '198.51.100.99' })).status).toBe(429)
        })

        it('reports the lock policy on /api/auth/me', async () => {
            setup({ web: { loginMaxFailures: 7, loginLockMinutes: 15, sessionDays: 3 } })
            const res = await t.request('/api/auth/me')
            expect(await res.json()).toMatchObject({
                policy: { max_failures: 7, lock_minutes: 15, session_days: 3, idle_hours: 8 }
            })
        })
    })

    describe('client address', () => {
        it('ignores X-Forwarded-For and X-Real-IP unless the proxy is trusted', async () => {
            setup({ web: { loginMaxFailures: 2 } })
            await login('wrong', { ip: '192.0.2.10', headers: { 'x-forwarded-for': '1.1.1.1' } })
            await login('wrong', {
                ip: '192.0.2.10',
                headers: { 'x-forwarded-for': '2.2.2.2', 'x-real-ip': '3.3.3.3' }
            })
            // A spoofed header does not dodge the per-address lock.
            const res = await login(PASSWORD, { ip: '192.0.2.10', headers: { 'x-forwarded-for': '4.4.4.4' } })
            expect(res.status).toBe(429)
            expect(new Set(t.ctx.store.listLoginAttempts().map((a) => a.ip))).toEqual(new Set(['192.0.2.10']))
        })

        it.each([
            [{ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, '10.0.0.1'],
            [{ 'x-forwarded-for': '9.9.9.9' }, '9.9.9.9'],
            [{ 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, '8.8.8.8'],
            [{ 'x-real-ip': '::ffff:7.7.7.7' }, '7.7.7.7'],
            [{}, '172.16.0.1']
        ])('behind a trusted proxy takes the address from %j', async (headers, ip) => {
            setup({ web: { trustProxy: true } })
            await login('wrong', { ip: '172.16.0.1', headers })
            expect(t.ctx.store.listLoginAttempts()[0].ip).toBe(ip)
        })

        it('strips the IPv4-mapped prefix of the socket address', async () => {
            setup()
            await login('wrong', { ip: '::ffff:192.0.2.7' })
            expect(t.ctx.store.listLoginAttempts()[0].ip).toBe('192.0.2.7')
        })
    })

    describe('Basic auth for scripts', () => {
        it('opens the API with the same credentials and makes no session', async () => {
            setup()
            const res = await t.request('/api/conversations', {
                headers: { authorization: basic('factory', PASSWORD) }
            })
            expect(res.status).toBe(200)
            expect(res.headers.get('set-cookie')).toBeNull()
            expect(t.ctx.store.listWebSessions()).toHaveLength(0)
            expect(t.ctx.store.listLoginAttempts()).toHaveLength(0)
        })

        it.each([
            ['a wrong password', basic('factory', 'nope')],
            ['a wrong user', basic('root', PASSWORD)],
            ['no colon', `Basic ${Buffer.from('factory').toString('base64')}`],
            ['another scheme', `Bearer ${PASSWORD}`]
        ])('refuses %s with 401', async (_case, authorization) => {
            setup()
            const res = await t.request('/api/conversations', { headers: { authorization } })
            expect(res.status).toBe(401)
        })

        it('counts wrong Basic credentials toward the lock', async () => {
            setup({ web: { loginMaxFailures: 2 } })
            const headers = { authorization: basic('factory', 'nope') }
            await t.request('/api/conversations', { headers })
            await t.request('/api/conversations', { headers })
            const good = await t.request('/api/conversations', {
                headers: { authorization: basic('factory', PASSWORD) }
            })
            expect(good.status).toBe(401)
            expect(t.ctx.store.listLoginAttempts().map((a) => a.result)).toEqual(['locked', 'failed', 'failed'])
        })
    })

    describe('sessions', () => {
        it('logout ends the session and clears the cookie', async () => {
            setup()
            const token = await signIn()
            const res = await t.request('/api/auth/logout', withCookie(token, { method: 'POST' }))
            expect(res.status).toBe(200)
            expect(res.headers.get('set-cookie')).toMatch(/pf_session=;.*Max-Age=0/)
            expect((await t.request('/api/conversations', withCookie(token))).status).toBe(401)
            expect(t.ctx.store.listWebSessions()).toHaveLength(0)
        })

        it('lists the signed-in browsers and marks the current one', async () => {
            setup()
            const first = await signIn({ headers: { 'user-agent': 'first' } })
            await signIn({ headers: { 'user-agent': 'second' }, ip: '192.0.2.2' })
            const res = await t.request('/api/auth/sessions', withCookie(first))
            const sessions = (await res.json()) as Array<{ current: boolean; user_agent: string; ip: string }>
            expect(sessions).toHaveLength(2)
            expect(sessions.find((s) => s.current)?.user_agent).toBe('first')
            expect(sessions.find((s) => !s.current)).toMatchObject({ user_agent: 'second', ip: '192.0.2.2' })
        })

        it('logout-others keeps only the asking browser', async () => {
            setup()
            const keep = await signIn()
            const other = await signIn()
            const third = await signIn()
            const res = await t.request('/api/auth/logout-others', withCookie(keep, { method: 'POST' }))
            expect(await res.json()).toEqual({ signed_out: 2 })
            expect((await t.request('/api/conversations', withCookie(keep))).status).toBe(200)
            expect((await t.request('/api/conversations', withCookie(other))).status).toBe(401)
            expect((await t.request('/api/conversations', withCookie(third))).status).toBe(401)
        })

        it('revokes one session by id and refuses a malformed id', async () => {
            setup()
            const mine = await signIn()
            const other = await signIn()
            const sessions = (await (await t.request('/api/auth/sessions', withCookie(mine))).json()) as Array<{
                id: string
                current: boolean
            }>
            const target = sessions.find((s) => !s.current)!
            const res = await t.request(`/api/auth/sessions/${target.id}`, withCookie(mine, { method: 'DELETE' }))
            expect(await res.json()).toEqual({ revoked: true })
            expect((await t.request('/api/conversations', withCookie(other))).status).toBe(401)
            const bad = await t.request('/api/auth/sessions/xyz', withCookie(mine, { method: 'DELETE' }))
            expect(bad.status).toBe(400)
        })

        it('expires a session that is not used for WEB_SESSION_DAYS', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(START)
            setup({ web: { sessionDays: 1 } })
            const token = await signIn()
            vi.setSystemTime(new Date(START.getTime() + 86_400_000 + 1000))
            expect((await t.request('/api/conversations', withCookie(token))).status).toBe(401)
        })

        it('slides the expiry of a session in use', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(START)
            setup({ web: { sessionDays: 1, sessionIdleHours: 0 } })
            const token = await signIn()
            vi.setSystemTime(new Date(START.getTime() + 20 * 3_600_000))
            expect((await t.request('/api/conversations', withCookie(token, active))).status).toBe(200)
            vi.setSystemTime(new Date(START.getTime() + 30 * 3_600_000))
            expect((await t.request('/api/conversations', withCookie(token, active))).status).toBe(200)
            // A poll alone does not slide it: gone a day after the last activity.
            vi.setSystemTime(new Date(START.getTime() + 55 * 3_600_000))
            expect((await t.request('/api/conversations', withCookie(token))).status).toBe(401)
        })

        it('ends a session after WEB_SESSION_IDLE_HOURS without the owner at the page', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(START)
            setup({ web: { sessionDays: 30, sessionIdleHours: 8 } })
            const token = await signIn()
            vi.setSystemTime(new Date(START.getTime() + 7 * 3_600_000))
            expect((await t.request('/api/conversations', withCookie(token, active))).status).toBe(200)
            // Slid by the activity at +7 h: alive at +14 h …
            vi.setSystemTime(new Date(START.getTime() + 14 * 3_600_000))
            expect((await t.request('/api/conversations', withCookie(token, active))).status).toBe(200)
            // … and gone at +23 h, for good: a later active request does not revive it.
            vi.setSystemTime(new Date(START.getTime() + 23 * 3_600_000))
            expect((await t.request('/api/conversations', withCookie(token))).status).toBe(401)
            expect((await t.request('/api/conversations', withCookie(token, active))).status).toBe(401)
            expect(
                await t.request('/api/auth/sessions', withCookie(await signIn())).then((r) => r.json())
            ).toHaveLength(1)
        })

        it('does not count a tab polling by itself as activity', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(START)
            setup({ web: { sessionIdleHours: 8 } })
            const token = await signIn()
            for (let h = 1; h <= 8; h++) {
                vi.setSystemTime(new Date(START.getTime() + h * 3_600_000 - 1000))
                expect((await t.request('/api/status', withCookie(token))).status).toBe(200)
            }
            vi.setSystemTime(new Date(START.getTime() + 8 * 3_600_000 + 1000))
            expect((await t.request('/api/status', withCookie(token))).status).toBe(401)
        })

        it('keeps a session for WEB_SESSION_DAYS when the idle timeout is off', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(START)
            setup({ web: { sessionDays: 30, sessionIdleHours: 0 } })
            const token = await signIn()
            vi.setSystemTime(new Date(START.getTime() + 20 * 86_400_000))
            expect((await t.request('/api/conversations', withCookie(token))).status).toBe(200)
        })

        it('serves the attempt log newest first', async () => {
            setup()
            await login('wrong')
            await login()
            const token = await signIn()
            const res = await t.request('/api/auth/log?limit=2', withCookie(token))
            const log = (await res.json()) as Array<{ result: string }>
            expect(log.map((a) => a.result)).toEqual(['ok', 'ok'])
        })
    })

    describe('notice events', () => {
        it('tells about a sign-in, the first failure of a streak and the lock, not the failures between', async () => {
            setup({ web: { loginMaxFailures: 3 } })
            const notices: LoginNotice[] = []
            t.ctx.auth.on('notice', (n) => notices.push(n))
            await login('wrong', { headers: { 'user-agent': 'curl/8.0' } })
            await login('wrong')
            await login('wrong')
            await login()
            expect(notices.map((n) => [n.kind, n.failures])).toEqual([
                ['failed', 1],
                ['locked', 3]
            ])
            expect(notices[0]).toMatchObject({ ip: '127.0.0.1', username: 'factory', userAgent: 'curl/8.0' })
            expect(notices[1].locked_until).not.toBeNull()
        })

        it('tells about a successful sign-in', async () => {
            setup()
            const notices: LoginNotice[] = []
            t.ctx.auth.on('notice', (n) => notices.push(n))
            await signIn({ ip: '192.0.2.44' })
            expect(notices).toEqual([expect.objectContaining({ kind: 'ok', ip: '192.0.2.44', failures: 0 })])
        })
    })
})

describe('describeUserAgent', () => {
    it.each([
        [null, 'unknown client'],
        ['curl/8.4.0', 'curl'],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
            'Chrome on macOS'
        ],
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
            'Safari on iOS'
        ],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0',
            'Edge on Windows'
        ],
        ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
        [
            'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 OPR/80',
            'Opera on Android'
        ],
        ['Mozilla/5.0 (Windows NT 10.0)', 'Windows'],
        ['python-requests/2.32.3 and some more text after it', 'python-requests/2.32.3 and some more tex']
    ])('describes %s as %s', (ua, expected) => {
        expect(describeUserAgent(ua)).toBe(expected)
    })
})
