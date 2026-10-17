import { describe, expect, it } from 'vitest'

import type { AgentActivity, CatalogEntry } from '../lib/api'
import { rosterOf } from './AgentsPanel'

const entry = (name: string): CatalogEntry => ({
    kind: 'agents',
    name,
    path: `agents/${name}.md`,
    frontmatter: { description: `${name} does things` },
    body: '',
    updated_at: '2026-10-16T10:00:00.000Z',
    size: 0
})

const active = (agent: string | null): AgentActivity => ({
    agent,
    runs: 2,
    running: 0,
    tokens: 1000,
    last_active: '2026-10-16T10:00:00.000Z'
})

describe('rosterOf', () => {
    const entries = [entry('reviewer')]
    const activity = [active(null), active('reviewer'), active('Explore'), active('old-name')]

    it('shows a file as editable, a name the CLI reports as a built-in, and leaves a deleted agent off', () => {
        const rows = rosterOf(entries, activity, 0, ['Explore', 'Plan', 'reviewer'])
        expect(rows.map((r) => [r.name, r.builtin])).toEqual([
            ['orchestrator', true],
            ['reviewer', false],
            ['Explore', true]
        ])
        expect(rows.find((r) => r.name === 'reviewer')?.entry).toBe(entries[0])
    })

    it('shows every active name as a built-in until a session has reported its agents', () => {
        for (const reported of [undefined, []]) {
            const rows = rosterOf(entries, activity, 0, reported)
            expect(rows.map((r) => r.name)).toEqual(['orchestrator', 'reviewer', 'Explore', 'old-name'])
        }
    })

    it('keeps a file without activity and a built-in without a file', () => {
        const rows = rosterOf([entry('idle')], [active('Plan')], 3, ['Plan'])
        expect(rows.map((r) => r.name)).toEqual(['orchestrator', 'idle', 'Plan'])
        expect(rows[0].description).toContain('3 queued')
        expect(rows[1].activity).toBeUndefined()
    })
})
