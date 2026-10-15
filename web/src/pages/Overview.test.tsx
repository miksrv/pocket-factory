import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ModelsOverview, ProviderOverview } from '../lib/api'
import { renderWithProviders } from '../test/render'
import { ProvidersCard } from './Overview'

const usage = { tasks_today: 0, tokens_today: 0, tokens_total: 0, delegated_total: 0, last_task_at: null }

const provider = (overrides: Partial<ProviderOverview>): ProviderOverview => ({
    name: 'gpu',
    kind: 'anthropic',
    url: 'https://gpu.test',
    model: 'gemma4:12b',
    concurrency: 1,
    running: 0,
    reach: { at: '2026-10-15T10:00:00.000Z', error: null },
    last_request: null,
    ...usage,
    ...overrides
})

const models = (providers: ProviderOverview[]): ModelsOverview => ({
    subscription: { model: 'sonnet', ...usage, tokens_today: 300_000, tokens_total: 3_000_000 },
    providers,
    removed: []
})

describe('ProvidersCard', () => {
    it('shows each provider with its state and what it took off the subscription', () => {
        renderWithProviders(
            <ProvidersCard
                loggedIn
                models={models([
                    provider({ tokens_today: 100_000, tokens_total: 1_000_000, delegated_total: 3, running: 1 }),
                    provider({ name: 'cloud', reach: { at: '2026-10-15T10:00:00.000Z', error: 'cloud answered 503' } })
                ])}
            />
        )
        expect(screen.getByText('Claude subscription')).toBeInTheDocument()
        expect(screen.getByText(/gemma4:12b · answers · 1\/1 running/)).toBeInTheDocument()
        expect(screen.getByText(/cloud answered 503/)).toBeInTheDocument()
        expect(
            screen.getByText(
                /Off the subscription: 100k today · 1\.0M in all \(25 % of every token\) · 3 delegated roles/
            )
        ).toBeInTheDocument()
    })

    it('says when nothing ran on a provider yet', () => {
        renderWithProviders(
            <ProvidersCard
                loggedIn
                models={models([provider({})])}
            />
        )
        expect(screen.getByText('Every token so far went to the subscription.')).toBeInTheDocument()
    })

    it('is not shown without a provider', () => {
        renderWithProviders(
            <ProvidersCard
                loggedIn
                models={models([])}
            />
        )
        expect(screen.queryByText('Providers')).not.toBeInTheDocument()
        expect(screen.queryByText('Claude subscription')).not.toBeInTheDocument()
    })
})
