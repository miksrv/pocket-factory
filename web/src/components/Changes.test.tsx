import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ChangedFile, TaskGit } from '../lib/api'
import { json, mockFetch } from '../test/fetch'
import { makeTask } from '../test/fixtures'
import { Changes } from './Changes'

const GIT: TaskGit = {
    start_head: 'aaaa',
    start_branch: 'main',
    branch: 'feature/login',
    head: 'bbbbbbbbbb',
    base: 'aaaaaaaaaa',
    default_branch: 'main',
    files: 4,
    added: 30,
    removed: 5
}

const file = (path: string, overrides: Partial<ChangedFile> = {}): ChangedFile => ({
    path,
    status: 'M',
    added: 10,
    removed: 1,
    binary: false,
    generated: false,
    ...overrides
})

const FILES = [
    file('web/src/Login.tsx'),
    file('web/src/logo.png', { status: 'A', binary: true, added: 0, removed: 0 }),
    file('README.md', { added: 2, removed: 0 }),
    file('yarn.lock', { generated: true, added: 300, removed: 200 })
]

const PATCH = [
    'diff --git a/web/src/Login.tsx b/web/src/Login.tsx',
    '--- a/web/src/Login.tsx',
    '+++ b/web/src/Login.tsx',
    '@@ -1,3 +1,3 @@ export function Login',
    ' import React',
    '-const old = 1',
    '+const fresh = 2'
].join('\n')

const renderChanges = (git: TaskGit | null = GIT, routes: Record<string, unknown> = {}) => {
    const fetch = mockFetch({
        'GET /api/tasks/t1/changes': { git, files: FILES, pr: null },
        'GET /api/tasks/t1/changes/file': { patch: PATCH, truncated: false },
        ...routes
    })
    const onChanged = vi.fn()
    render(
        <Changes
            task={makeTask({ status: 'done', git, result: 'Fixed the **login** form.' })}
            onChanged={onChanged}
        />
    )
    return { fetch, onChanged, user: userEvent.setup() }
}

describe('Changes', () => {
    it('renders nothing for a task outside a checkout', () => {
        mockFetch({})
        const { container } = render(<Changes task={makeTask({ git: null })} />)
        expect(container).toBeEmptyDOMElement()
    })

    // Bug: useAsync runs before the early return, so every task page without a checkout still asks
    // GET /api/tasks/:id/changes (and polls nothing, but the request is wasted and fails on the server).
    it.fails('does not ask for the changes of a task outside a checkout', () => {
        const fetch = mockFetch({})
        render(<Changes task={makeTask({ git: null })} />)
        expect(fetch).not.toHaveBeenCalled()
    })

    it('leads with the report, the size and the branch', async () => {
        renderChanges()
        expect(screen.getByRole('heading', { name: 'Changes' })).toBeInTheDocument()
        expect(screen.getByText('login').tagName).toBe('STRONG')
        expect(screen.getByText(/feature\/login → main/)).toBeInTheDocument()
        const size = screen.getByText('files').parentElement!
        expect(size).toHaveTextContent('4 files +30 −5')
        expect(await screen.findByText('Login.tsx')).toBeInTheDocument()
    })

    it('groups the files by folder and folds the generated ones', async () => {
        const { user } = renderChanges()
        await screen.findByText('Login.tsx')
        const folder = screen.getByText('web/src/').parentElement!
        expect(
            within(folder)
                .getAllByRole('button')
                .map((b) => b.querySelector('.name')?.textContent)
        ).toEqual(['Login.tsx', 'logo.png'])
        expect(screen.getByRole('button', { name: /README\.md/ })).toBeInTheDocument()
        const toggle = screen.getByRole('button', { name: /1 generated file/ })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(toggle).toHaveTextContent('+300 −200')
        expect(screen.queryByText('yarn.lock')).not.toBeInTheDocument()
        await user.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('yarn.lock')).toBeInTheDocument()
    })

    it("loads one file's diff when it is tapped", async () => {
        const { user, fetch } = renderChanges()
        const row = await screen.findByRole('button', { name: /Login\.tsx/ })
        expect(row).toHaveAttribute('aria-expanded', 'false')
        await user.click(row)
        expect(row).toHaveAttribute('aria-expanded', 'true')
        expect(await screen.findByText('+const fresh = 2')).toBeInTheDocument()
        expect(screen.getByText('-const old = 1')).toBeInTheDocument()
        // File headers are dropped, the hunk header is shortened.
        expect(screen.queryByText(/^diff --git/)).not.toBeInTheDocument()
        expect(screen.getByText('⋯ export function Login')).toBeInTheDocument()
        expect(fetch.requests().at(-1)?.url).toBe('/api/tasks/t1/changes/file?path=web%2Fsrc%2FLogin.tsx')
        await user.click(row)
        expect(screen.queryByText('+const fresh = 2')).not.toBeInTheDocument()
    })

    it('says a binary file has no diff without asking for one', async () => {
        const { user, fetch } = renderChanges()
        await user.click(await screen.findByRole('button', { name: /logo\.png/ }))
        expect(screen.getByText('A binary file: no line diff.')).toBeInTheDocument()
        expect(fetch.requests().filter((r) => r.url.includes('/changes/file'))).toHaveLength(0)
    })

    it('creates a pull request and links it', async () => {
        const pr = { number: 12, url: 'https://github.com/acme/app/pull/12', state: 'OPEN', title: 'Login fix' }
        const { user, onChanged, fetch } = renderChanges(GIT, { 'POST /api/tasks/t1/pr': pr })
        await user.click(await screen.findByRole('button', { name: /Create PR/ }))
        const link = await screen.findByRole('link', { name: /PR #12/ })
        expect(link).toHaveAttribute('href', pr.url)
        expect(onChanged).toHaveBeenCalledOnce()
        expect(fetch.requests().some((r) => r.method === 'POST' && r.url === '/api/tasks/t1/pr')).toBe(true)
    })

    it('shows why a pull request could not be created', async () => {
        const { user } = renderChanges(GIT, { 'POST /api/tasks/t1/pr': json({ error: 'push rejected' }, 500) })
        await user.click(await screen.findByRole('button', { name: /Create PR/ }))
        expect(await screen.findByText('push rejected')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Create PR/ })).toBeEnabled()
    })

    it('offers no pull request for work on the default branch', async () => {
        renderChanges({ ...GIT, branch: 'main' })
        await screen.findByText('Login.tsx')
        expect(screen.queryByRole('button', { name: /Create PR/ })).not.toBeInTheDocument()
    })

    it('links an existing pull request with its state', async () => {
        renderChanges({
            ...GIT,
            pr: { number: 3, url: 'https://github.com/acme/app/pull/3', state: 'MERGED', title: 'x' }
        })
        expect(await screen.findByRole('link', { name: /PR #3 · merged/ })).toBeInTheDocument()
    })

    it('mentions files left uncommitted', async () => {
        renderChanges({ ...GIT, uncommitted: 2 })
        expect(
            await screen.findByText('2 files were left uncommitted in the checkout and are not shown here.')
        ).toBeInTheDocument()
    })
})
