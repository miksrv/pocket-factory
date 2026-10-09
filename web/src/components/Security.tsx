import { useState } from 'react'

import { api, fmt, type LoginAttempt, type WebSession } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { useAuth } from './Auth'
import { useConfirm } from './Modal'
import { Button, Empty, ErrorBox, useToast } from './ui'

/**
 * Settings → Security: how the door is locked, who is inside and who knocked.
 * The browsers signed in (each can be signed out, or all the others at once)
 * and the last sign-in attempts: the lockout counts the failed ones, the bot
 * reports them, this is where the owner reads them back.
 */
export function SecuritySection({ telegram }: { telegram: boolean }) {
    const { auth } = useAuth()
    const sessions = useAsync(
        () => (auth.mode === 'password' ? api.auth.sessions() : Promise.resolve([] as WebSession[])),
        [auth.mode],
        30_000
    )
    const log = useAsync(() => api.auth.log(50), [], 30_000)
    const confirm = useConfirm()
    const [toast, showToast] = useToast()
    const [error, setError] = useState<string | null>(null)
    const { policy } = auth

    const revoke = async (session: WebSession) => {
        setError(null)
        try {
            await api.auth.revokeSession(session.id)
            showToast(`Signed out ${describe(session.user_agent)}`)
            sessions.reload()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }
    const signOutOthers = () =>
        confirm({
            title: 'Sign out every other browser?',
            message:
                'Every session but this one ends now; those browsers see the sign-in page on their next request. Do this when a sign-in you did not make shows up below.',
            action: 'Sign out others',
            pending: 'Signing out…',
            danger: true,
            icon: 'logout',
            onConfirm: async () => {
                const { signed_out } = await api.auth.logoutOthers()
                showToast(`Signed out ${fmt.plural(signed_out, 'other session')}`)
                sessions.reload()
            }
        })

    const others = (sessions.data ?? []).filter((s) => !s.current).length
    return (
        <>
            <div className='kv'>
                <span>Sign-in</span>
                <span>
                    {auth.mode === 'password' ? (
                        <>
                            password · user <code>{auth.user}</code> · WEB_AUTH_USER / WEB_AUTH_PASSWORD in .env
                        </>
                    ) : (
                        <span className='error'>
                            open — no password: whoever reaches this port is the owner. The API answers only to
                            localhost and WEB_ALLOWED_HOSTS; set WEB_AUTH_PASSWORD before the port is reachable from
                            anywhere else.
                        </span>
                    )}
                </span>
            </div>
            <div className='kv'>
                <span>Lockout</span>
                <span>
                    {fmt.plural(policy.max_failures, 'wrong password')} from one address within {policy.lock_minutes}{' '}
                    min lock it out for {policy.lock_minutes} min (WEB_LOGIN_MAX_FAILURES, WEB_LOGIN_LOCK_MIN); four
                    times as many from anywhere lock everyone
                </span>
            </div>
            <div className='kv'>
                <span>Sessions</span>
                <span>
                    an HttpOnly, SameSite=Strict cookie;{' '}
                    {policy.idle_hours > 0
                        ? `a browser asks for the password again after ${fmt.plural(policy.idle_hours, 'hour')} without you at the page (WEB_SESSION_IDLE_HOURS; a tab polling by itself does not count) and `
                        : 'no idle timeout (WEB_SESSION_IDLE_HOURS=0); a browser '}
                    stays signed in for at most {fmt.plural(policy.session_days, 'day')} since its last visit
                    (WEB_SESSION_DAYS)
                </span>
            </div>
            <div className='kv'>
                <span>Reports</span>
                <span>
                    {telegram
                        ? 'Telegram tells you about every sign-in, the first wrong password of a streak and a lock'
                        : 'Telegram is disabled — only the log below and the supervisor log'}
                </span>
            </div>
            <ErrorBox error={error ?? sessions.error ?? log.error} />
            {auth.mode === 'password' && (
                <>
                    <div className='security-head'>
                        <h4>Signed-in browsers ({sessions.data?.length ?? '…'})</h4>
                        <Button
                            size='sm'
                            variant='danger'
                            disabled={others === 0}
                            onClick={() => void signOutOthers()}
                        >
                            Sign out everywhere else
                        </Button>
                    </div>
                    <div className='security-table'>
                        <table>
                            <thead>
                                <tr>
                                    <th>Browser</th>
                                    <th>Address</th>
                                    <th>Signed in</th>
                                    <th>Last seen</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {(sessions.data ?? []).map((s) => (
                                    <tr key={s.id}>
                                        <td
                                            className='grow'
                                            title={s.user_agent ?? ''}
                                        >
                                            {describe(s.user_agent)}
                                            {s.current && (
                                                <>
                                                    {' '}
                                                    <span className='badge green plain'>this browser</span>
                                                </>
                                            )}
                                        </td>
                                        <td className='mono'>{s.ip ?? '—'}</td>
                                        <td title={fmt.when(s.created_at)}>{fmt.ago(s.created_at)}</td>
                                        <td title={fmt.when(s.last_seen_at)}>{fmt.ago(s.last_seen_at)}</td>
                                        <td style={{ textAlign: 'right' }}>
                                            {!s.current && (
                                                <Button
                                                    size='sm'
                                                    onClick={() => void revoke(s)}
                                                >
                                                    Sign out
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
            <div className='security-head'>
                <h4>Recent sign-ins</h4>
                <span
                    className='dim'
                    style={{ fontSize: 11.5 }}
                >
                    last 50 attempts, kept 90 days
                </span>
            </div>
            {log.data && log.data.length === 0 ? (
                <Empty>No sign-in attempts yet{auth.mode === 'open' ? ' — sign-in is off' : ''}.</Empty>
            ) : (
                <div className='security-table'>
                    <table>
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Result</th>
                                <th>Address</th>
                                <th>User</th>
                                <th>Browser</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(log.data ?? []).map((a) => (
                                <tr key={a.id}>
                                    <td title={fmt.when(a.ts)}>{fmt.ago(a.ts)}</td>
                                    <td>
                                        <span className={`badge ${RESULT[a.result].tone}`}>
                                            {RESULT[a.result].label}
                                        </span>
                                    </td>
                                    <td className='mono'>{a.ip}</td>
                                    <td className='mono'>{a.username ?? '—'}</td>
                                    <td
                                        className='grow'
                                        title={a.user_agent ?? ''}
                                    >
                                        {describe(a.user_agent)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {toast}
        </>
    )
}

const RESULT: Record<LoginAttempt['result'], { label: string; tone: string }> = {
    ok: { label: 'signed in', tone: 'done' },
    failed: { label: 'wrong password', tone: 'failed' },
    locked: { label: 'locked out', tone: 'queued' }
}

/** "Chrome on macOS" from a user-agent string; the raw header is the cell's title. */
function describe(ua: string | null): string {
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
