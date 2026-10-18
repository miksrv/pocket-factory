import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VaultOverview } from '../lib/api'
import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { NeedsLine, SecretsSection } from './Secrets'

const OVERVIEW: VaultOverview = {
    entries: [
        {
            name: 'TRAC_PASSWORD',
            secret: true,
            scope: { all: false, routines: ['trac-defects'], projects: [] },
            created_at: '2026-10-17T10:00:00Z',
            updated_at: '2026-10-17T10:00:00Z',
            used_by: [{ kind: 'routine', name: 'trac-defects', step: 'Trac' }]
        },
        {
            name: 'TRAC_URL',
            secret: false,
            value: 'https://trac.example.com',
            scope: { all: true },
            created_at: '2026-10-17T10:00:00Z',
            updated_at: '2026-10-17T10:00:00Z',
            used_by: []
        }
    ],
    routines: ['trac-defects', 'geometki-rewriter'],
    projects: ['geometki']
}

describe('SecretsSection', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('lists secrets without a value and variables with theirs', async () => {
        mockFetch({ 'GET /api/secrets': OVERVIEW })
        renderWithProviders(<SecretsSection />)
        expect(await screen.findByText('TRAC_PASSWORD')).toBeInTheDocument()
        expect(screen.queryByText('TRAC_URL')).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: /trac-defects/ })).toHaveAttribute('href', '/routines/trac-defects')
        await userEvent.setup().click(screen.getByRole('tab', { name: 'Variables' }))
        expect(screen.getByText('https://trac.example.com')).toBeInTheDocument()
    })

    it('adds a secret scoped to the routines picked', async () => {
        const fetch = mockFetch({
            'GET /api/secrets': OVERVIEW,
            'PUT /api/secrets/GSC_TOKEN': { ...OVERVIEW.entries[0], name: 'GSC_TOKEN' }
        })
        renderWithProviders(<SecretsSection />)
        const user = userEvent.setup()
        await user.click(await screen.findByRole('button', { name: 'New secret' }))
        const dialog = await screen.findByRole('dialog')
        await user.type(within(dialog).getByLabelText('Name'), 'gsc-token')
        expect(within(dialog).getByLabelText('Name')).toHaveValue('GSC_TOKEN')
        await user.type(within(dialog).getByLabelText('Secret'), 'tok-123456')
        await user.click(within(dialog).getByLabelText('only the routines and projects picked'))
        await user.click(within(dialog).getByLabelText('geometki-rewriter'))
        await user.click(within(dialog).getByRole('button', { name: 'Add secret' }))
        expect(fetch.requests().find((r) => r.method === 'PUT')).toMatchObject({
            url: '/api/secrets/GSC_TOKEN?create=1',
            body: {
                value: 'tok-123456',
                secret: true,
                scope: { all: false, routines: ['geometki-rewriter'], projects: [] }
            }
        })
    })

    it('updates a secret without its value: only the access changes', async () => {
        const fetch = mockFetch({ 'GET /api/secrets': OVERVIEW, 'PUT /api/secrets/TRAC_PASSWORD': OVERVIEW.entries[0] })
        renderWithProviders(<SecretsSection />)
        const user = userEvent.setup()
        await user.click(await screen.findByRole('button', { name: 'Update' }))
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByLabelText('New value')).toHaveValue('')
        await user.click(within(dialog).getByLabelText('every routine and chat'))
        await user.click(within(dialog).getByRole('button', { name: 'Update secret' }))
        const put = fetch.requests().find((r) => r.method === 'PUT')
        expect(put?.body).toEqual({ secret: true, scope: { all: true } })
    })
})

describe('NeedsLine', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('marks what a run gets and offers Set for what it misses', async () => {
        mockFetch({ 'GET /api/secrets': OVERVIEW })
        renderWithProviders(
            <NeedsLine
                routine='trac-defects'
                onChanged={vi.fn()}
                needs={[
                    { name: 'TRAC_URL', from: 'variable', kind: 'variable' },
                    { name: 'TRAC_USER', from: null, kind: 'variable' }
                ]}
            />
        )
        expect(screen.getByText('✓ variable')).toBeInTheDocument()
        expect(screen.getByText('not set')).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Set' }))
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText('New variable')).toBeInTheDocument()
        expect(within(dialog).getByLabelText('Name')).toHaveValue('TRAC_USER')
        expect(within(dialog).getByLabelText('trac-defects')).toBeChecked()
    })
})
