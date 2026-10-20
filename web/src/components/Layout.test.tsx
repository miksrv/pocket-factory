import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { Layout } from './Layout'

vi.mock('./Auth', () => ({ useAuth: () => ({ auth: { mode: 'none' }, signOut: vi.fn() }) }))

const status = (approvals: number) => ({
    version: '1.7.3',
    claude: { logged_in: true, version: null, model: 'sonnet' },
    stats: { running: 0, chat_unread: 0, chat_needs_reply: 0, chat_active: 0 },
    sandboxes: { approvals }
})

afterEach(() => vi.unstubAllGlobals())

describe('Layout', () => {
    it('counts blocked requests waiting for the owner beside Settings', async () => {
        mockFetch({ 'GET /api/status': status(2) })
        renderWithProviders(<Layout />)
        const settings = screen.getByRole('link', { name: /Settings/ })
        expect(await within(settings).findByTitle('2 blocked request(s) waiting for your answer')).toHaveTextContent(
            '2'
        )
    })

    it('shows no badge beside Settings when nothing waits', async () => {
        mockFetch({ 'GET /api/status': status(0) })
        renderWithProviders(<Layout />)
        await screen.findByText('v1.7.3')
        expect(within(screen.getByRole('link', { name: /Settings/ })).queryByText('0')).toBeNull()
    })
})
