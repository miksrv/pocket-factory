import { describe, expect, it } from 'vitest'

import type { RoutineView } from '../routines/service.js'
import type { RoutineRun } from '../store/index.js'
import {
    findRoutine,
    parseRoutineData,
    previewText,
    routineCard,
    routineData,
    routineKey,
    routinesList,
    runsText
} from './routinesMenu.js'
import { renderPlain } from './view.js'
import { type Button, type View } from './view.js'

const NOW = Date.parse('2026-10-16T12:00:00Z')

const run = (patch: Partial<RoutineRun> = {}): RoutineRun => ({
    id: 1,
    schedule: 'daily',
    fired_at: '2026-10-16T09:00:00Z',
    trigger: 'schedule',
    status: 'queued',
    note: null,
    items: 0,
    task_id: 't1',
    duration_ms: 0,
    steps: null,
    task_status: 'done',
    ...patch
})

const view = (patch: Partial<RoutineView> = {}): RoutineView => ({
    name: 'daily',
    enabled: true,
    errors: [],
    warnings: [],
    triggers: [
        {
            kind: 'schedule',
            cron: '0 9 * * *',
            cron_text: 'every day at 09:00',
            tz: 'UTC',
            window: { days: null, hours: null },
            next_run: '2026-10-17T09:00:00Z'
        }
    ],
    project: 'work',
    agent: 'writer',
    skill: null,
    has_agent: true,
    steps: [{ kind: 'agent', name: 'agent', source: false, new_only: false, needs: [] }],
    notify: null,
    session: null,
    once: false,
    provider: null,
    model: null,
    next_run: '2026-10-17T09:00:00Z',
    last_run: run(),
    last_task: run(),
    active_task: null,
    conversation_id: null,
    seen: 0,
    dir: '/data/config/routines/daily',
    ...patch
})

/** The text blocks of a view, joined. */
const textOf = (v: View) => v.flatMap((b) => (b.kind === 'text' ? [b.html] : [])).join('\n\n')
const allButtons = (v: View): Button[] => v.flatMap((b) => (b.kind === 'buttons' ? b.buttons : []))
const labels = (v: View) => allButtons(v).map((b) => b.text)
const datas = (v: View) => allButtons(v).map((b) => b.data ?? b.url)

describe('routineKey', () => {
    it('is the name while it fits callback data, a hash of it otherwise, and both resolve', () => {
        const long = 'a'.repeat(80)
        expect(routineKey('daily')).toBe('daily')
        expect(routineKey(long)).toHaveLength(12)
        expect(Buffer.byteLength(routineData('preview', long, 'list'))).toBeLessThanOrEqual(64)
        const list = [view(), view({ name: long })]
        expect(findRoutine(list, 'daily')?.name).toBe('daily')
        expect(findRoutine(list, routineKey(long))?.name).toBe(long)
        expect(findRoutine(list, 'nope')).toBeUndefined()
    })

    it('parses its own data, with where the button sat', () => {
        expect(parseRoutineData(routineData('run', 'daily'))).toEqual({ action: 'run', key: 'daily', from: null })
        expect(parseRoutineData(routineData('off', 'daily', 'list'))).toEqual({
            action: 'off',
            key: 'daily',
            from: 'list'
        })
        expect(parseRoutineData(routineData('list'))).toEqual({ action: 'list', key: null, from: null })
        expect(parseRoutineData('a|t1|0|1')).toBeNull()
    })
})

describe('routinesList', () => {
    it('has a line and its own buttons per routine, and a refresh button', () => {
        const v = routinesList([view(), view({ name: 'nightly', enabled: false })], 'https://f.example', NOW)
        const text = textOf(v)
        expect(text).toContain('<b>Routines</b> · 2, 1 on')
        expect(text).toContain('🟢 <b>daily</b> — writer · work')
        expect(text).toContain('every day at 09:00 · last done 3 h ago · next in 21 h')
        expect(labels(v)).toEqual([
            '▶️ Run',
            '⏸ Off',
            '📋 Details',
            '▶️ Run',
            '▶ On',
            '📋 Details',
            '🔄 Refresh',
            '🌐 Web'
        ])
        expect(datas(v)).toEqual([
            'r|run|daily|l',
            'r|off|daily|l',
            'r|card|daily',
            'r|run|nightly|l',
            'r|on|nightly|l',
            'r|card|nightly',
            'r|list',
            'https://f.example/routines'
        ])
        // The buttons of a routine sit right under its line.
        expect(v[1]).toMatchObject({ kind: 'text' })
        expect(v[2]).toMatchObject({ kind: 'buttons' })
    })

    it('names the routine on its run button in the classic form, where every row is in one keyboard', () => {
        const { markup } = renderPlain(routinesList([view(), view({ name: 'nightly' })], null, NOW))
        const firsts = markup!.inline_keyboard.slice(0, 2).map((r) => r[0].text)
        expect(firsts).toEqual(['▶️ daily', '▶️ nightly'])
    })

    it('says so when there are none', () => {
        expect(textOf(routinesList([], null, NOW))).toMatch(/No routines yet/)
    })
})

describe('routineCard', () => {
    it('shows the state, the facts and the buttons that act', () => {
        const v = routineCard(view(), 'UTC', { now: NOW, webUrl: 'https://f.example' })
        const text = textOf(v)
        expect(text).toContain('🟢 <b>daily</b> · on')
        expect(text).toContain('agent: writer · project: work')
        expect(text).toContain('triggers: every day at 09:00')
        expect(text).toContain('next: Sat 09:00 (in 21 h)')
        expect(labels(v)).toEqual(['▶️ Run now', '⏸ Switch off', '📜 Runs', '🌐 Open', '« Routines'])
        expect(allButtons(v)[0]).toMatchObject({ style: 'success', data: 'r|run|daily' })
        expect(allButtons(v).find((b) => b.text === '🌐 Open')).toMatchObject({
            url: 'https://f.example/routines/daily'
        })
    })

    it('offers Switch on for a routine that is off, Preview for a source, Stop for a run under way', () => {
        const tracStep = { kind: 'trac' as const, name: 'tickets', source: true, new_only: true, needs: [] }
        const off = routineCard(view({ enabled: false, steps: [tracStep, view().steps[0]] }), 'UTC', { now: NOW })
        expect(labels(off)).toEqual(['▶️ Run now', '▶ Switch on', '👁 Preview', '📜 Runs', '« Routines'])
        const busy = routineCard(
            view({ active_task: { id: 't9', status: 'running', created_at: '2026-10-16T11:00:00Z' } }),
            'UTC',
            { now: NOW }
        )
        expect(textOf(busy)).toContain('🔵 <b>daily</b> · running now')
        expect(datas(busy)[0]).toBe('s|stop|t9|c')
    })

    it('has no Run now for an invalid file, and shows the error', () => {
        const v = routineCard(view({ errors: ['agent "x" not found'] }), 'UTC', { now: NOW })
        expect(textOf(v)).toContain('⚠️ agent &quot;x&quot; not found')
        expect(labels(v)).toEqual(['📜 Runs', '« Routines'])
    })

    it('adds the note of an action just taken, and Run with all after an empty manual run', () => {
        expect(textOf(routineCard(view(), 'UTC', { now: NOW, note: '▶️ Queued.' }))).toMatch(/\n\n▶️ Queued\.$/)
        const v = routineCard(view(), 'UTC', { now: NOW, emptyRun: 7 })
        expect(labels(v)).toContain('▶️ Run with all 7')
        expect(datas(v)).toContain('r|all|daily')
    })
})

describe('runsText and previewText', () => {
    it('lists the runs newest first with what came of them', () => {
        const v = runsText(
            view(),
            [
                run({ fired_at: '2026-10-16T09:00:00Z', trigger: 'manual' }),
                run({ fired_at: '2026-10-15T09:00:00Z', status: 'empty', trigger: 'schedule' }),
                run({ fired_at: '2026-10-14T09:00:00Z', status: 'error', note: 'boom' })
            ],
            'UTC',
            NOW
        )
        expect(textOf(v).split('\n').slice(2)).toEqual([
            '▶️ Fri 09:00 · 3 h ago (by hand): done',
            '· Thu 09:00 · 1 d ago: nothing new',
            '⚠️ Wed 09:00 · 2 d ago: error — boom'
        ])
        expect(datas(v)).toEqual(['r|card|daily'])
    })

    it('marks the new items of a preview and links them', () => {
        const tracStep = { kind: 'trac' as const, name: 'tickets', source: true, new_only: true, needs: [] }
        const text = textOf(
            previewText(view({ steps: [tracStep, view().steps[0]] }), {
                items: [
                    { key: 'a', title: 'Ticket A', url: 'https://t/a' },
                    { key: 'b', title: 'Ticket B', seen_before: '2026-10-10T00:00:00Z' }
                ],
                new_keys: ['a'],
                outputs: [{ name: 'stats', output: 'visits 42\n', ms: 5, truncated: false }],
                steps: [],
                ms: 42
            })
        )
        expect(text).toContain('<b>stats</b>')
        expect(text).toContain('<pre>visits 42</pre>')
        expect(text).toContain('2 items, 1 would be handed over')
        expect(text).toContain('🆕 <a href="https://t/a">Ticket A</a>')
        expect(text).toContain('· Ticket B (changed)')
    })
})
