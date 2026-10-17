import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { TaskEvent } from '../lib/api'
import { makeTask } from '../test/fixtures'
import { renderWithProviders } from '../test/render'
import { AssistantTurn } from './AssistantTurn'

const event = (id: number, type: TaskEvent['type'], payload: Record<string, unknown>): TaskEvent => ({
    id,
    task_id: 't1',
    ts: '2026-10-15T10:00:00.000Z',
    type,
    payload,
    agent: null,
    parent_tool_use_id: null
})

describe('AssistantTurn', () => {
    it('shows a delegation as a card with where the role runs and a link to its task', () => {
        renderWithProviders(
            <AssistantTurn
                task={makeTask({ id: 't1', status: 'done', result: 'Checked' })}
                events={[
                    event(1, 'status', {
                        status: 'running',
                        note: 'delegated to writer on gpu · small',
                        delegate: {
                            task_id: 'child-1',
                            agent: 'writer',
                            provider: 'gpu',
                            model: 'small',
                            fallback: null
                        }
                    }),
                    event(2, 'text', { text: 'The note is fine.' })
                ]}
            />
        )
        expect(screen.getByText('writer')).toBeInTheDocument()
        expect(screen.getByText(/gpu:small/)).toBeInTheDocument()
        const links = screen.getAllByRole('link', { name: 'Task' })
        expect(links.some((a) => a.getAttribute('href') === '/tasks/child-1')).toBe(true)
    })

    it('says why a role ran on the subscription instead', () => {
        renderWithProviders(
            <AssistantTurn
                task={makeTask({ id: 't1', status: 'done' })}
                events={[
                    event(1, 'status', {
                        status: 'running',
                        delegate: {
                            task_id: 'child-2',
                            agent: 'writer',
                            provider: null,
                            model: 'sonnet',
                            fallback: 'gpu unreachable: fetch failed'
                        }
                    })
                ]}
            />
        )
        expect(screen.getByText(/subscription · sonnet/)).toBeInTheDocument()
        expect(
            screen.getByText('Ran on the subscription, not on its provider: gpu unreachable: fetch failed')
        ).toBeInTheDocument()
    })
})
