import { describe, expect, it } from 'vitest'

import type { TokensByDayRow } from '../../store/index.js'
import { dailySeries, ownerDays } from './usage.js'

describe('ownerDays', () => {
    it("cuts days at the owner's midnight, today so far last", () => {
        const days = ownerDays(3, 'Europe/Moscow', new Date('2026-10-06T22:30:00.000Z'))
        expect(days).toEqual([
            { date: '2026-10-05', start: '2026-10-04T21:00:00.000Z', end: '2026-10-05T21:00:00.000Z' },
            { date: '2026-10-06', start: '2026-10-05T21:00:00.000Z', end: '2026-10-06T21:00:00.000Z' },
            { date: '2026-10-07', start: '2026-10-06T21:00:00.000Z', end: '2026-10-06T22:30:00.000Z' }
        ])
    })

    it('keeps a 23-hour day whole across a DST change', () => {
        const days = ownerDays(2, 'Europe/Berlin', new Date('2026-03-30T12:00:00.000Z'))
        expect(days[0]).toEqual({
            date: '2026-03-29',
            start: '2026-03-28T23:00:00.000Z',
            end: '2026-03-29T22:00:00.000Z'
        })
    })
})

describe('dailySeries', () => {
    it('gives providers their slots in providers.yaml order, gray past the palette, whatever is missing', () => {
        const rows: TokensByDayRow[] = ['d', 'c', 'b', 'a', 'e'].map((provider, i) => ({
            day: 0,
            provider,
            model: 'm',
            tokens: i + 1
        }))
        rows.push({ day: 0, provider: null, model: 'claude-haiku-4-5', tokens: 9 })
        const series = dailySeries(rows, 1, ['a', 'b', 'c', 'x'])
        expect(series.map((s) => [s.label, s.slot])).toEqual([
            ['Haiku', 3],
            ['a', 5],
            ['b', 6],
            ['c', 8],
            ['d', null],
            ['e', null]
        ])
    })
})
