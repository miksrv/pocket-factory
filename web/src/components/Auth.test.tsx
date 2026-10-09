import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { type AuthState, UNAUTHORIZED } from '../lib/api'
import { json, mockFetch } from '../test/fetch'
import { AuthProvider, useAuth } from './Auth'

const POLICY = { max_failures: 5, lock_minutes: 10, session_days: 30, idle_hours: 8 }

const state = (overrides: Partial<AuthState> = {}): AuthState => ({
    mode: 'password',
    authenticated: false,
    user: null,
    session: null,
    policy: POLICY,
    ...overrides
})

const SIGNED_IN = state({ authenticated: true, user: 'owner', session: { created_at: '2026-10-06', ip: null } })

function Home() {
    const { auth, signOut } = useAuth()
    return (
        <>
            <h1>Overview</h1>
            <p>Signed in as {auth.user ?? 'nobody'}</p>
            <button
                type='button'
                onClick={() => void signOut()}
            >
                Sign out
            </button>
        </>
    )
}

/** The API's sign-in routes over a `signedIn` flag the login flips. */
function server(login: (body: { username: string; password: string }) => Response | null = () => null) {
    let signedIn = false
    const fetch = mockFetch({
        'GET /api/auth/me': () => (signedIn ? SIGNED_IN : state()),
        'POST /api/auth/login': ({ body }: { body: unknown }) => {
            const refusal = login(body as { username: string; password: string })
            if (refusal) return refusal
            signedIn = true
            return { ok: true, user: 'owner' }
        },
        'POST /api/auth/logout': () => {
            signedIn = false
            return { ok: true }
        }
    })
    return fetch
}

const renderApp = () => {
    render(
        <AuthProvider>
            <Home />
        </AuthProvider>
    )
    return userEvent.setup()
}

const signIn = async (user: ReturnType<typeof userEvent.setup>, username: string, password: string) => {
    const name = screen.getByRole('textbox', { name: 'Username' })
    await user.clear(name)
    await user.type(name, username)
    await user.type(screen.getByLabelText('Password'), password)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('AuthProvider', () => {
    it('renders the app at once without a password', async () => {
        mockFetch({ 'GET /api/auth/me': state({ mode: 'open', authenticated: true }) })
        renderApp()
        expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
    })

    it('shows the sign-in page in password mode and lets the owner in', async () => {
        const fetch = server()
        const user = renderApp()
        expect(await screen.findByRole('heading', { name: 'Pocket Factory' })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument()
        const submit = screen.getByRole('button', { name: 'Sign in' })
        expect(submit).toBeDisabled()
        await signIn(user, 'owner', 'secret')
        expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
        expect(screen.getByText('Signed in as owner')).toBeInTheDocument()
        expect(fetch.requests().find((r) => r.method === 'POST')?.body).toEqual({
            username: 'owner',
            password: 'secret'
        })
    })

    it('remembers the user name, never the password', async () => {
        server()
        const user = renderApp()
        await screen.findByRole('button', { name: 'Sign in' })
        await signIn(user, 'owner', 'secret')
        await screen.findByRole('heading', { name: 'Overview' })
        await user.click(screen.getByRole('button', { name: 'Sign out' }))
        expect(await screen.findByRole('textbox', { name: 'Username' })).toHaveValue('owner')
        expect(screen.getByLabelText('Password')).toHaveValue('')
        expect(screen.getByLabelText('Password')).toHaveFocus()
    })

    it('says a password was wrong and how many tries are left', async () => {
        server(() => json({ error: 'wrong', attempts_left: 1 }, 401))
        const user = renderApp()
        await screen.findByRole('button', { name: 'Sign in' })
        await signIn(user, 'owner', 'guess')
        const alert = await screen.findByRole('alert')
        expect(alert).toHaveTextContent('Wrong username or password. 1 more and sign-in is locked for 10 minutes.')
        expect(screen.getByLabelText('Password')).toHaveValue('')
        expect(screen.getByLabelText('Password')).toBeInvalid()
    })

    it('warns that the next wrong password locks', async () => {
        server(() => json({ error: 'wrong', attempts_left: 0 }, 401))
        const user = renderApp()
        await screen.findByRole('button', { name: 'Sign in' })
        await signIn(user, 'owner', 'guess')
        expect(await screen.findByRole('alert')).toHaveTextContent('The next one locks sign-in for 10 minutes.')
    })

    it('counts down a lock and keeps the form shut meanwhile', async () => {
        const until = new Date(Date.now() + 125_000).toISOString()
        server(() => json({ error: 'locked', locked_until: until }, 429))
        const user = renderApp()
        await screen.findByRole('button', { name: 'Sign in' })
        await signIn(user, 'owner', 'guess')
        expect(await screen.findByRole('alert')).toHaveTextContent(/Too many wrong passwords\. Try again in 2:0[45]/)
        expect(screen.getByRole('button', { name: /^Locked · 2:0[45]$/ })).toBeDisabled()
        expect(screen.getByRole('textbox', { name: 'Username' })).toBeDisabled()
        expect(screen.getByLabelText('Password')).toBeDisabled()
    })

    it('shows another failure as it is', async () => {
        server(() => json({ error: 'database is locked' }, 500))
        const user = renderApp()
        await screen.findByRole('button', { name: 'Sign in' })
        await signIn(user, 'owner', 'secret')
        expect(await screen.findByRole('alert')).toHaveTextContent('database is locked')
    })

    it('reveals the password on request', async () => {
        server()
        const user = renderApp()
        await screen.findByRole('button', { name: 'Sign in' })
        await user.type(screen.getByLabelText('Password'), 'secret')
        expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
        await user.click(screen.getByRole('button', { name: 'Show password' }))
        expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
        expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('goes back to the sign-in page when a later call is refused', async () => {
        mockFetch({ 'GET /api/auth/me': SIGNED_IN })
        renderApp()
        await screen.findByRole('heading', { name: 'Overview' })
        act(() => {
            window.dispatchEvent(new Event(UNAUTHORIZED))
        })
        expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    })

    it('says when the API is unreachable and tries again', async () => {
        const me = vi
            .fn()
            .mockReturnValueOnce(new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }))
            .mockReturnValue(state({ mode: 'open', authenticated: true }))
        mockFetch({ 'GET /api/auth/me': me })
        const user = renderApp()
        expect(await screen.findByRole('alert')).toHaveTextContent('The API is unreachable: 502 Bad Gateway')
        await user.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    })
})
