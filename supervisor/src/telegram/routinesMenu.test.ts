import type { InlineKeyboard } from 'grammy'
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
            prefilter: null,
            next_run: '2026-10-17T09:00:00Z'
        }
    ],
    project: 'work',
    agent: 'writer',
    skill: null,
    prefilter: null,
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
    ...patch
})

const buttons = (keyboard: InlineKeyboard) => keyboard.inline_keyboard.flat().map((b) => b.text)
const datas = (keyboard: InlineKeyboard) =>
    keyboard.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : undefined))

describe('routineKey', () => {
    it('is the name while it fits callback data, a hash of it otherwise, and both resolve', () => {
        const long = 'a'.repeat(80)
        expect(routineKey('daily')).toBe('daily')
        expect(routineKey(long)).toHaveLength(12)
        expect(Buffer.byteLength(routineData('preview', long))).toBeLessThanOrEqual(64)
        const list = [view(), view({ name: long })]
        expect(findRoutine(list, 'daily')?.name).toBe('daily')
        expect(findRoutine(list, routineKey(long))?.name).toBe(long)
        expect(findRoutine(list, 'nope')).toBeUndefined()
    })

    it('parses its own data', () => {
        expect(parseRoutineData(routineData('run', 'daily'))).toEqual({ action: 'run', key: 'daily' })
        expect(parseRoutineData(routineData('list'))).toEqual({ action: 'list', key: null })
        expect(parseRoutineData('a|t1|0|1')).toBeNull()
    })
})

describe('routinesList', () => {
    it('has a line and a button per routine, and a refresh button', () => {
        const { text, keyboard } = routinesList([view(), view({ name: 'nightly', enabled: false })], NOW)
        expect(text).toContain('<b>Routines</b> · 2, 1 on')
        expect(text).toContain('🟢 <b>daily</b> — writer · work')
        expect(text).toContain('every day at 09:00 · last done 3 h ago · next in 21 h')
        expect(buttons(keyboard)).toEqual(['🟢 daily', '⚪️ nightly', '🔄 Refresh'])
        expect(datas(keyboard)).toEqual(['r|card|daily', 'r|card|nightly', 'r|list'])
    })

    it('says so when there are none', () => {
        expect(routinesList([], NOW).text).toMatch(/No routines yet/)
    })
})

describe('routineCard', () => {
    it('shows the state, the facts and the buttons that act', () => {
        const { text, keyboard } = routineCard(view(), 'UTC', { now: NOW, webUrl: 'https://f.example' })
        expect(text).toContain('🟢 <b>daily</b> · on')
        expect(text).toContain('agent: writer · project: work')
        expect(text).toContain('triggers: every day at 09:00')
        expect(text).toContain('next: Sat 09:00 (in 21 h)')
        expect(buttons(keyboard)).toEqual(['▶️ Run now', '⏸ Switch off', '📜 Runs', '🌐 Open', '« Routines'])
        expect(keyboard.inline_keyboard[0][0]).toMatchObject({ style: 'success', callback_data: 'r|run|daily' })
        expect(keyboard.inline_keyboard.flat().find((b) => b.text === '🌐 Open')).toMatchObject({
            url: 'https://f.example/routines/daily'
        })
    })

    it('offers Switch on for a routine that is off, Preview for a poll, Stop for a run under way', () => {
        const off = routineCard(view({ enabled: false, prefilter: 'trac' }), 'UTC', { now: NOW })
        expect(buttons(off.keyboard)).toEqual(['▶️ Run now', '▶ Switch on', '👁 Preview', '📜 Runs', '« Routines'])
        const busy = routineCard(
            view({ active_task: { id: 't9', status: 'running', created_at: '2026-10-16T11:00:00Z' } }),
            'UTC',
            { now: NOW }
        )
        expect(busy.text).toContain('🔵 <b>daily</b> · running now')
        expect(datas(busy.keyboard)[0]).toBe('s|stop|t9')
    })

    it('has no Run now for an invalid file, and shows the error', () => {
        const { text, keyboard } = routineCard(view({ errors: ['agent "x" not found'] }), 'UTC', { now: NOW })
        expect(text).toContain('⚠️ agent &quot;x&quot; not found'.replace('&quot;', '"').replace('&quot;', '"'))
        expect(buttons(keyboard)).toEqual(['📜 Runs', '« Routines'])
    })

    it('adds the note of an action just taken', () => {
        expect(routineCard(view(), 'UTC', { now: NOW, note: '▶️ Queued.' }).text).toMatch(/\n\n▶️ Queued\.$/)
    })
})

describe('runsText and previewText', () => {
    it('lists the runs newest first with what came of them', () => {
        const text = runsText(
            view(),
            [
                run({ fired_at: '2026-10-16T09:00:00Z', trigger: 'manual' }),
                run({ fired_at: '2026-10-15T09:00:00Z', status: 'empty', trigger: 'poll' }),
                run({ fired_at: '2026-10-14T09:00:00Z', status: 'error', note: 'boom' })
            ],
            'UTC',
            NOW
        )
        expect(text.split('\n').slice(2)).toEqual([
            '▶️ Fri 09:00 · 3 h ago (by hand): done',
            '· Thu 09:00 · 1 d ago (0 new): nothing new',
            '⚠️ Wed 09:00 · 2 d ago: error — boom'
        ])
    })

    it('marks the new items of a preview and links them', () => {
        const text = previewText(view(), {
            items: [
                { key: 'a', title: 'Ticket A', url: 'https://t/a' },
                { key: 'b', title: 'Ticket B', seen_before: '2026-10-10T00:00:00Z' }
            ],
            new_keys: ['a'],
            ms: 42
        })
        expect(text).toContain('2 items, 1 new (42 ms)')
        expect(text).toContain('🆕 <a href="https://t/a">Ticket A</a>')
        expect(text).toContain('· Ticket B (changed)')
    })
})
