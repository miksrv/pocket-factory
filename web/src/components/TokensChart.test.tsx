import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { TokensChart } from './TokensChart'

describe('TokensChart', () => {
    it('shows every series with its total, and asks for another range', async () => {
        const fetch = mockFetch({
            'GET /api/usage/daily': {
                days: ['2026-10-05', '2026-10-06'],
                series: [
                    {
                        key: 'claude:sonnet',
                        label: 'Sonnet',
                        kind: 'subscription',
                        slot: 1,
                        values: [0, 42_000],
                        total: 42_000
                    },
                    { key: 'provider:gpu', label: 'gpu', kind: 'provider', slot: 5, values: [7000, 0], total: 7000 }
                ]
            }
        })
        renderWithProviders(<TokensChart />)
        expect(await screen.findByText('42k')).toBeInTheDocument()
        expect(screen.getByText('7k')).toBeInTheDocument()
        expect(screen.getByText('49k in total')).toBeInTheDocument()
        expect(screen.getByRole('columnheader', { name: 'gpu' })).toBeInTheDocument()

        await userEvent.click(screen.getByRole('tab', { name: '7 days' }))
        expect(fetch.requests().map((r) => r.url)).toContain('/api/usage/daily?days=7')
    })

    it('says so when nothing ran in the range', async () => {
        mockFetch({ 'GET /api/usage/daily': { days: ['2026-10-06'], series: [] } })
        renderWithProviders(<TokensChart />)
        expect(await screen.findByText('No model calls in the last 30 days.')).toBeInTheDocument()
    })
})
