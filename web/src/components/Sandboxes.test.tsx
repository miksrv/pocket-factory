import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSandbox, SandboxesOverview } from '../lib/api'
import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { ProjectSandboxCard, SandboxesSection } from './Sandboxes'

const now = new Date().toISOString()

const OVERVIEW: SandboxesOverview = {
    mode: 'sbx',
    ok: true,
    error: null,
    version: 'v0.48.0',
    docker_login: true,
    claude_login: false,
    sandboxes: [
        {
            name: 'pf-shop',
            project: 'shop',
            status: 'running',
            workspaces: ['/w/shop'],
            active: 0,
            last_used_at: now,
            created_at: now,
            pinned: true
        },
        {
            name: 'pf-factory',
            project: null,
            status: 'stopped',
            workspaces: ['/w'],
            active: 0,
            last_used_at: null,
            created_at: now,
            pinned: false
        }
    ],
    approvals: [
        {
            id: 'network:abc',
            sandbox: 'pf-shop',
            project: 'shop',
            resource: 'db.example.com:5432',
            detail: '',
            seen_at: now
        }
    ],
    previews: [
        {
            project: 'shop',
            sandbox: 'pf-shop',
            port: 5173,
            host_port: 18100,
            strip: false,
            task_id: null,
            created_at: now,
            url: 'https://mikserver/preview/shop/',
            base: '/preview/shop/k/',
            expires_at: null
        }
    ],
    checked_at: now
}

describe('SandboxesSection', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('shows the daemon, the logins, the sandboxes, what waits and the previews', async () => {
        mockFetch({ 'GET /api/sandboxes': OVERVIEW })
        renderWithProviders(<SandboxesSection />)
        expect(await screen.findByText(/sbx v0\.48\.0 · 1 sandbox running of 2/)).toBeInTheDocument()
        expect(screen.getByText(/missing — ssh -t to the server/)).toBeInTheDocument()
        expect(screen.getByText('chats without a project')).toBeInTheDocument()
        expect(screen.getByText(/pf-shop · running · used .* · preview open/)).toBeInTheDocument()
        expect(screen.getByText('db.example.com:5432')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Open/ })).toHaveAttribute('href', 'https://mikserver/preview/shop/')
    })

    it('allows a blocked host and asks before a reset', async () => {
        const fetch = mockFetch({
            'GET /api/sandboxes': OVERVIEW,
            'POST /api/sandboxes/approvals/network%3Aabc': OVERVIEW,
            'POST /api/sandboxes/pf-shop/reset': OVERVIEW
        })
        renderWithProviders(<SandboxesSection />)
        const user = userEvent.setup()
        await user.click(await screen.findByRole('button', { name: 'Allow' }))
        expect(fetch.requests().find((r) => r.method === 'POST')).toMatchObject({
            url: '/api/sandboxes/approvals/network%3Aabc',
            body: { allow: true }
        })
        await user.click(screen.getAllByRole('button', { name: 'Reset' })[0])
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText(/the checkout and the factory’s files are not touched/)).toBeInTheDocument()
        await user.click(within(dialog).getByRole('button', { name: 'Reset' }))
        expect(fetch.requests().some((r) => r.method === 'POST' && r.url === '/api/sandboxes/pf-shop/reset')).toBe(true)
    })

    it('says the agents run on this machine in local mode', async () => {
        mockFetch({ 'GET /api/sandboxes': { ...OVERVIEW, mode: 'local', sandboxes: [], approvals: [], previews: [] } })
        renderWithProviders(<SandboxesSection />)
        expect(await screen.findByText(/on this machine/)).toBeInTheDocument()
    })
})

describe('ProjectSandboxCard', () => {
    afterEach(() => vi.unstubAllGlobals())

    it("shows the project's sandbox and preview with Stop", async () => {
        const project: ProjectSandbox = {
            mode: 'sbx',
            name: 'pf-shop',
            sandbox: OVERVIEW.sandboxes[0],
            preview: OVERVIEW.previews[0],
            approvals: []
        }
        const fetch = mockFetch({
            'GET /api/sandboxes/projects/shop': project,
            'DELETE /api/sandboxes/previews/shop': { closed: true }
        })
        renderWithProviders(<ProjectSandboxCard slug='shop' />)
        expect(await screen.findByText('port 5173 · since just now')).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Stop preview' }))
        expect(fetch.requests().find((r) => r.method === 'DELETE')).toMatchObject({
            url: '/api/sandboxes/previews/shop'
        })
    })
})
