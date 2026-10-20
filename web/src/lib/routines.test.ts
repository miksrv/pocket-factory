import { describe, expect, it } from 'vitest'

import type { RoutineRun } from './api'
import { runProgress } from './routines'

const run = (status: RoutineRun['status'], steps: RoutineRun['steps']): RoutineRun => ({
    id: 1,
    schedule: 'geo',
    fired_at: '2026-10-19T00:00:00Z',
    trigger: 'manual',
    status,
    note: null,
    items: 0,
    task_id: null,
    duration_ms: 0,
    steps,
    task_status: null
})

describe('runProgress', () => {
    it('names the running step of a run that goes on, and nothing once it ended', () => {
        expect(
            runProgress(
                run('running', [
                    { index: 0, name: 'place', kind: 'run', ok: true, ms: 5, log: '' },
                    { index: 1, name: 'GSC', kind: 'run', ok: true, ms: 0, log: '', running: true }
                ]),
                5
            )
        ).toBe('step 2 of 5 · GSC')
        expect(runProgress(run('running', []), 5)).toBe('starting the steps')
        expect(runProgress(run('queued', []), 5)).toBeNull()
        expect(runProgress(null, 5)).toBeNull()
    })
})
