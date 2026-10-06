import {
    createContext,
    type FormEvent,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState
} from 'react'

import { api, ApiError, type AuthState, fmt, UNAUTHORIZED } from '../lib/api'
import { Icon } from './Icon'
import { Button } from './ui'

interface AuthContextValue {
    auth: AuthState
    /** End this browser's session and show the sign-in page. */
    signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
    const value = useContext(AuthContext)
    if (!value) throw new Error('useAuth outside AuthProvider')
    return value
}

const USER_KEY = 'pf.login.user'

/**
 * Asks the API who this browser is before anything else renders. With a
 * password set and no live session the sign-in page takes the whole window;
 * a 401 from any later call (the session lapsed, or was signed out from
 * Settings → Security) brings it back, and a sign-in reloads the app state
 * from scratch, since every page under it was unmounted meanwhile.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
    const [auth, setAuth] = useState<AuthState | null>(null)
    const [error, setError] = useState<string | null>(null)
    const load = useCallback(async () => {
        try {
            setAuth(await api.auth.me())
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }, [])
    useEffect(() => {
        void load()
    }, [load])
    useEffect(() => {
        const signedOut = () =>
            setAuth((a) => (a && a.mode === 'password' ? { ...a, authenticated: false, user: null, session: null } : a))
        window.addEventListener(UNAUTHORIZED, signedOut)
        return () => window.removeEventListener(UNAUTHORIZED, signedOut)
    }, [])
    const signOut = useCallback(async () => {
        try {
            await api.auth.logout()
        } finally {
            setAuth((a) => (a ? { ...a, authenticated: false, user: null, session: null } : a))
        }
    }, [])

    if (!auth) {
        return (
            <div className='login'>
                {error && (
                    <div className='login-card'>
                        <Brand />
                        <div
                            className='error'
                            role='alert'
                        >
                            The API is unreachable: {error}
                        </div>
                        <Button
                            variant='primary'
                            onClick={() => void load()}
                        >
                            Try again
                        </Button>
                    </div>
                )}
            </div>
        )
    }
    if (auth.mode === 'password' && !auth.authenticated)
        return (
            <LoginPage
                policy={auth.policy}
                onSignedIn={load}
            />
        )
    return <AuthContext.Provider value={{ auth, signOut }}>{children}</AuthContext.Provider>
}

function Brand() {
    return (
        <div className='login-brand'>
            <img
                src='/icon-192.png'
                alt=''
                width={56}
                height={56}
            />
            <h1>Pocket Factory</h1>
        </div>
    )
}

/**
 * The sign-in form. A wrong password says how many tries are left before the
 * lock; a lock shows a countdown and disables the button until it ends. The
 * user name is remembered in this browser, the password never.
 */
export function LoginPage({ policy, onSignedIn }: { policy: AuthState['policy']; onSignedIn: () => void }) {
    const [username, setUsername] = useState(() => {
        try {
            return localStorage.getItem(USER_KEY) ?? ''
        } catch {
            return ''
        }
    })
    const [password, setPassword] = useState('')
    const [show, setShow] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
    const [lockedUntil, setLockedUntil] = useState<number | null>(null)
    const [now, setNow] = useState(Date.now())
    const passwordRef = useRef<HTMLInputElement>(null)
    const userRef = useRef<HTMLInputElement>(null)

    // The field that needs typing gets the focus: the password when the name is remembered.
    useEffect(() => {
        ;(username ? passwordRef : userRef).current?.focus()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // The countdown ticks once a second while locked and clears itself at the end.
    const locked = lockedUntil !== null && lockedUntil > now
    useEffect(() => {
        if (!locked) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [locked])
    useEffect(() => {
        if (lockedUntil !== null && lockedUntil <= now) {
            setLockedUntil(null)
            setError(null)
            setAttemptsLeft(null)
        }
    }, [lockedUntil, now])

    const submit = async (e: FormEvent) => {
        e.preventDefault()
        if (busy || locked) return
        setBusy(true)
        setError(null)
        try {
            await api.auth.login(username, password)
            try {
                localStorage.setItem(USER_KEY, username)
            } catch {
                // private mode etc.
            }
            setPassword('')
            onSignedIn()
        } catch (err) {
            const body = (err instanceof ApiError ? err.body : null) as {
                attempts_left?: number
                locked_until?: string | null
            } | null
            setPassword('')
            passwordRef.current?.focus()
            if (err instanceof ApiError && err.status === 429) {
                setLockedUntil(
                    body?.locked_until
                        ? new Date(body.locked_until).getTime()
                        : Date.now() + policy.lock_minutes * 60_000
                )
                setNow(Date.now())
                setError(null)
            } else if (err instanceof ApiError && err.status === 401) {
                if (body?.locked_until) {
                    setLockedUntil(new Date(body.locked_until).getTime())
                    setNow(Date.now())
                } else {
                    setError('Wrong username or password.')
                    setAttemptsLeft(typeof body?.attempts_left === 'number' ? body.attempts_left : null)
                }
            } else {
                setError(err instanceof Error ? err.message : String(err))
            }
        } finally {
            setBusy(false)
        }
    }

    const remaining = locked ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0
    const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`

    return (
        <div className='login'>
            <form
                className='login-card'
                onSubmit={(e) => void submit(e)}
                aria-busy={busy}
            >
                <Brand />
                <p className='login-sub'>Sign in to your factory.</p>
                <label className='field'>
                    <span>Username</span>
                    <input
                        ref={userRef}
                        name='username'
                        autoComplete='username'
                        autoCapitalize='none'
                        spellCheck={false}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        disabled={busy || locked}
                        required
                    />
                </label>
                <label className='field'>
                    <span>Password</span>
                    <span className='input-with-action'>
                        <input
                            ref={passwordRef}
                            name='password'
                            type={show ? 'text' : 'password'}
                            autoComplete='current-password'
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={busy || locked}
                            required
                            aria-invalid={error ? true : undefined}
                        />
                        <Button
                            variant='ghost'
                            className='input-action'
                            title={show ? 'Hide password' : 'Show password'}
                            aria-label={show ? 'Hide password' : 'Show password'}
                            aria-pressed={show}
                            onClick={() => setShow((v) => !v)}
                            tabIndex={-1}
                        >
                            <Icon
                                name={show ? 'eyeOff' : 'eye'}
                                size={15}
                            />
                        </Button>
                    </span>
                </label>
                {locked ? (
                    <div
                        className='login-notice locked'
                        role='alert'
                        aria-live='polite'
                    >
                        <Icon
                            name='warning'
                            size={14}
                        />
                        <span>
                            Too many wrong passwords. Try again in <strong>{countdown}</strong>.
                        </span>
                    </div>
                ) : error ? (
                    <div
                        className='login-notice error'
                        role='alert'
                        aria-live='polite'
                    >
                        <Icon
                            name='warning'
                            size={14}
                        />
                        <span>
                            {error}
                            {attemptsLeft !== null && attemptsLeft <= 2 && (
                                <>
                                    {' '}
                                    {attemptsLeft === 0
                                        ? 'The next one locks sign-in'
                                        : `${attemptsLeft} more and sign-in is locked`}{' '}
                                    for {fmt.plural(policy.lock_minutes, 'minute')}.
                                </>
                            )}
                        </span>
                    </div>
                ) : null}
                <Button
                    type='submit'
                    variant='primary'
                    className='login-submit'
                    disabled={busy || locked || !username || !password}
                >
                    {busy ? 'Signing in…' : locked ? `Locked · ${countdown}` : 'Sign in'}
                </Button>
                <p className='login-foot'>Every sign-in is logged and reported.</p>
            </form>
        </div>
    )
}
