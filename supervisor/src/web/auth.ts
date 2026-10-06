import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'

import type { Config } from '../config.js'
import { createLogger } from '../logger.js'
import type { LoginAttempt, LoginResult, Store, WebSession } from '../store/index.js'

const log = createLogger('auth')

/** The cookie that carries a browser session; the value is a random token, the store keeps its hash. */
export const SESSION_COOKIE = 'pf_session'

/** How often a used session's `last_seen_at` and expiry are written (every request would be a write per poll). */
const TOUCH_EVERY_MS = 5 * 60_000
/** Sign-in attempts are kept this long for Settings → Security. */
const ATTEMPTS_KEEP_DAYS = 90

export interface LoginContext {
    ip: string
    userAgent: string | null
}

export type LoginOutcome =
    | { ok: true; token: string; session: WebSession }
    | { ok: false; reason: 'locked'; locked_until: string }
    | { ok: false; reason: 'failed'; attempts_left: number; locked_until: string | null }

/** What the bot tells the owner about: a successful sign-in, the first failure of a streak, a lock. */
export interface LoginNotice {
    kind: 'ok' | 'failed' | 'locked'
    ip: string
    username: string | null
    userAgent: string | null
    at: string
    /** Failures from this address in the current window (failed / locked). */
    failures: number
    locked_until: string | null
}

/**
 * The web UI's own sign-in: one owner, the password from `.env`, a session
 * cookie per browser and a lockout against guessing.
 *
 * - The password is compared in constant time (digests of both sides), and
 *   the comparison runs whether or not the user name matched, so a wrong
 *   name costs the same as a wrong password.
 * - A session is 32 random bytes in an HttpOnly cookie; the store holds the
 *   SHA-256, so a copy of the database signs nobody in. Sessions slide:
 *   each use (at most every few minutes) pushes the expiry `sessionDays`
 *   ahead; an unused one lapses.
 * - After `loginMaxFailures` failed attempts from one address within
 *   `loginLockMinutes`, sign-in from that address is refused for that long
 *   without even checking the password; attempts during the lock are
 *   recorded but neither counted nor extend it, so an attacker cannot lock
 *   the owner out for good. A second counter over every address at four
 *   times the threshold catches an attacker rotating addresses.
 * - Every attempt is a row in `login_attempts` and a line in the log, and a
 *   `notice` event tells the bot (success, first failure of a streak, lock).
 */
export class WebAuth extends EventEmitter<{ notice: [LoginNotice] }> {
    private readonly user: string
    private readonly password: string | undefined
    private readonly sessionMs: number
    private readonly lockMs: number
    private readonly maxFailures: number
    private readonly touched = new Map<string, number>()
    private timer: ReturnType<typeof setInterval> | undefined

    constructor(
        private readonly store: Store,
        config: Config['web']
    ) {
        super()
        this.user = config.authUser
        this.password = config.authPassword
        this.sessionMs = config.sessionDays * 86_400_000
        this.lockMs = config.loginLockMinutes * 60_000
        this.maxFailures = config.loginMaxFailures
    }

    /** `password`: sign-in required; `open`: no password in `.env`, whoever reaches the port is the owner. */
    get mode(): 'password' | 'open' {
        return this.password ? 'password' : 'open'
    }

    get username(): string {
        return this.user
    }

    get policy(): { max_failures: number; lock_minutes: number; session_days: number } {
        return {
            max_failures: this.maxFailures,
            lock_minutes: this.lockMs / 60_000,
            session_days: this.sessionMs / 86_400_000
        }
    }

    /** Housekeeping: expired sessions and old attempts go, now and once an hour. */
    start(): void {
        const sweep = () => {
            const sessions = this.store.purgeWebSessions()
            const attempts = this.store.purgeLoginAttempts(
                new Date(Date.now() - ATTEMPTS_KEEP_DAYS * 86_400_000).toISOString()
            )
            if (sessions || attempts) log.debug(`swept ${sessions} expired session(s), ${attempts} old attempt(s)`)
        }
        sweep()
        this.timer = setInterval(sweep, 3_600_000)
        this.timer.unref()
    }

    stop(): void {
        clearInterval(this.timer)
    }

    /** Is sign-in from this address refused right now, and until when? */
    lockedUntil(ip: string): string | null {
        const since = new Date(Date.now() - this.lockMs).toISOString()
        const own = this.store.loginFailures(ip, since)
        const all = this.store.loginFailures(null, since)
        const hit = own.count >= this.maxFailures ? own : all.count >= this.maxFailures * 4 ? all : null
        if (!hit?.last) return null
        const until = new Date(new Date(hit.last).getTime() + this.lockMs)
        return until.getTime() > Date.now() ? until.toISOString() : null
    }

    /** Check a name and password; records the attempt whatever the outcome. */
    login(username: string, password: string, ctx: LoginContext): LoginOutcome {
        const verdict = this.verify(username, password, ctx)
        if (!verdict.ok) return verdict
        this.record(ctx, verdict.username, 'ok')
        const token = randomBytes(32).toString('base64url')
        const session = this.store.createWebSession(hash(token), this.expiry(), ctx.ip, ctx.userAgent)
        log.info(`signed in from ${ctx.ip} (${describeUserAgent(ctx.userAgent)})`)
        this.emit('notice', {
            kind: 'ok',
            ip: ctx.ip,
            username: verdict.username,
            userAgent: ctx.userAgent,
            at: session.created_at,
            failures: 0,
            locked_until: null
        })
        return { ok: true, token, session }
    }

    /**
     * The lock and the credentials, with a failure recorded and told; a
     * success is left to the caller (a sign-in makes a session and a row, a
     * script's Basic header on every request must not).
     */
    private verify(
        username: string,
        password: string,
        ctx: LoginContext
    ): { ok: true; username: string } | Exclude<LoginOutcome, { ok: true }> {
        if (!this.password) throw new Error('sign-in is not enabled (WEB_AUTH_PASSWORD is empty)')
        const name = username.trim().slice(0, 200)
        const locked = this.lockedUntil(ctx.ip)
        if (locked) {
            this.record(ctx, name, 'locked')
            return { ok: false, reason: 'locked', locked_until: locked }
        }
        if (this.credentialsMatch(name, password)) return { ok: true, username: name }
        this.record(ctx, name, 'failed')
        const failures = this.store.loginFailures(ctx.ip, new Date(Date.now() - this.lockMs).toISOString()).count
        const lockedUntil = this.lockedUntil(ctx.ip)
        log.warn(
            `failed sign-in from ${ctx.ip} as "${name}" (${failures}/${this.maxFailures}${lockedUntil ? `, locked until ${lockedUntil}` : ''})`
        )
        // The owner hears about the first failure of a streak and about the lock; the ones between would only repeat it.
        if (failures === 1 || lockedUntil) {
            this.emit('notice', {
                kind: lockedUntil ? 'locked' : 'failed',
                ip: ctx.ip,
                username: name,
                userAgent: ctx.userAgent,
                at: new Date().toISOString(),
                failures,
                locked_until: lockedUntil
            })
        }
        return {
            ok: false,
            reason: 'failed',
            attempts_left: Math.max(0, this.maxFailures - failures),
            locked_until: lockedUntil
        }
    }

    /** The session a cookie token names, if it is alive; its expiry slides on use. */
    sessionOf(token: string | undefined, ip: string | null): WebSession | undefined {
        if (!token || token.length > 128) return undefined
        const id = hash(token)
        const session = this.store.getWebSession(id)
        if (!session) return undefined
        const last = this.touched.get(id) ?? 0
        if (Date.now() - last > TOUCH_EVERY_MS) {
            this.touched.set(id, Date.now())
            this.store.touchWebSession(id, this.expiry(), ip)
        }
        return session
    }

    /** `Authorization: Basic …` from a script; the same credentials, the same lockout, no session. */
    basic(header: string | undefined, ctx: LoginContext): boolean {
        if (!header?.startsWith('Basic ')) return false
        let decoded: string
        try {
            decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
        } catch {
            return false
        }
        const colon = decoded.indexOf(':')
        if (colon < 0) return false
        return this.verify(decoded.slice(0, colon), decoded.slice(colon + 1), ctx).ok
    }

    logout(token: string | undefined): boolean {
        if (!token) return false
        const id = hash(token)
        this.touched.delete(id)
        return this.store.deleteWebSession(id)
    }

    /** Sign out every browser but the one asking. */
    logoutOthers(token: string | undefined): number {
        this.touched.clear()
        return this.store.deleteWebSessions(token ? hash(token) : undefined)
    }

    revoke(id: string): boolean {
        this.touched.delete(id)
        return this.store.deleteWebSession(id)
    }

    sessions(token: string | undefined): Array<WebSession & { current: boolean }> {
        const current = token ? hash(token) : null
        return this.store.listWebSessions().map((s) => ({ ...s, current: s.id === current }))
    }

    attempts(limit = 50): LoginAttempt[] {
        return this.store.listLoginAttempts(limit)
    }

    private record(ctx: LoginContext, username: string, result: LoginResult): void {
        this.store.addLoginAttempt(ctx.ip, username || null, result, ctx.userAgent)
    }

    private expiry(): string {
        return new Date(Date.now() + this.sessionMs).toISOString()
    }

    private credentialsMatch(username: string, password: string): boolean {
        // Both comparisons always run: the time taken says nothing about which half was wrong.
        const userOk = equal(username, this.user)
        const passOk = equal(password, this.password ?? '')
        return userOk && passOk
    }
}

function hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

/** Constant-time string comparison through fixed-length digests. */
function equal(a: string, b: string): boolean {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/**
 * A browser in a few words for the log and Telegram ("Chrome on macOS",
 * "Safari on iPhone"); the raw header stays in the store.
 */
export function describeUserAgent(ua: string | null): string {
    if (!ua) return 'unknown client'
    if (/^curl\//i.test(ua)) return 'curl'
    const os = /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Mac OS X/.test(ua)
            ? 'macOS'
            : /Windows/.test(ua)
              ? 'Windows'
              : /Linux/.test(ua)
                ? 'Linux'
                : null
    const browser = /Edg\//.test(ua)
        ? 'Edge'
        : /OPR\//.test(ua)
          ? 'Opera'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Firefox\//.test(ua)
              ? 'Firefox'
              : /Safari\//.test(ua)
                ? 'Safari'
                : null
    if (!browser && !os) return ua.slice(0, 40)
    return browser && os ? `${browser} on ${os}` : (browser ?? os ?? 'unknown client')
}
