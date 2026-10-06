import { describe, expect, it } from 'vitest'

import {
    cronMatches,
    describeCron,
    inWindow,
    isTimeZone,
    localTime,
    nextRun,
    parseCron,
    parseWindow,
    startOfDay
} from './cron.js'

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
const utc = (iso: string) => new Date(`${iso}Z`)

describe('parseCron', () => {
    it('expands every field of a plain expression', () => {
        const cron = parseCron('*/15 9-17 * * 1-5')
        expect(sorted(cron.minute)).toEqual([0, 15, 30, 45])
        expect(sorted(cron.hour)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
        expect(cron.dom.size).toBe(31)
        expect(cron.month.size).toBe(12)
        expect(sorted(cron.dow)).toEqual([1, 2, 3, 4, 5])
        expect(cron.domAny).toBe(true)
        expect(cron.dowAny).toBe(false)
        expect(cron.source).toBe('*/15 9-17 * * 1-5')
    })

    it('takes lists, stepped ranges and a step from a single value', () => {
        const cron = parseCron('5,10,1-3 0-10/5 10/10 * *')
        expect(sorted(cron.minute)).toEqual([1, 2, 3, 5, 10])
        expect(sorted(cron.hour)).toEqual([0, 5, 10])
        expect(sorted(cron.dom)).toEqual([10, 20, 30])
    })

    it('reads month and weekday names in any case', () => {
        const cron = parseCron('0 8 * JAN,jul Mon-Fri')
        expect(sorted(cron.month)).toEqual([1, 7])
        expect(sorted(cron.dow)).toEqual([1, 2, 3, 4, 5])
    })

    it('treats 7 as Sunday', () => {
        expect(sorted(parseCron('0 0 * * 7').dow)).toEqual([0])
        expect(sorted(parseCron('0 0 * * 5-7').dow)).toEqual([0, 5, 6])
    })

    it.each([
        ['@hourly', '0 * * * *'],
        ['@daily', '0 0 * * *'],
        ['@midnight', '0 0 * * *'],
        ['@weekly', '0 0 * * 0'],
        ['@MONTHLY', '0 0 1 * *']
    ])('expands the alias %s like %s', (alias, plain) => {
        const a = parseCron(alias)
        const b = parseCron(plain)
        expect(sorted(a.minute)).toEqual(sorted(b.minute))
        expect(sorted(a.hour)).toEqual(sorted(b.hour))
        expect(sorted(a.dom)).toEqual(sorted(b.dom))
        expect(sorted(a.dow)).toEqual(sorted(b.dow))
        expect(a.source).toBe(alias)
    })

    it('trims the expression and tolerates runs of whitespace', () => {
        const cron = parseCron('  0   12 *  * *  ')
        expect(sorted(cron.hour)).toEqual([12])
        expect(cron.source).toBe('0   12 *  * *')
    })

    it.each([
        ['', /five fields/],
        ['* * * *', /five fields.*got 4/],
        ['* * * * * *', /five fields.*got 6/],
        ['60 * * * *', /minute.*outside 0-59/],
        ['* 24 * * *', /hour.*outside 0-23/],
        ['* * 0 * *', /day of month.*outside 1-31/],
        ['* * * 13 *', /month.*outside 1-12/],
        ['* * * * 8', /weekday.*outside 0-7/],
        ['5-1 * * * *', /minute.*outside/],
        ['*/0 * * * *', /bad step/],
        ['*/x * * * *', /bad step/],
        ['a * * * *', /minute: "a" is not a number/],
        ['1,,2 * * * *', /empty list item/],
        ['* * * foo *', /month: "foo" is not a number/],
        ['* * * * monday', /weekday: "monday" is not a number/],
        ['-1 * * * *', /minute/]
    ])('rejects %j', (expr, message) => {
        expect(() => parseCron(expr)).toThrow(message)
    })
})

describe('localTime', () => {
    it('gives the wall clock in the zone and a minute key', () => {
        const t = localTime(utc('2026-03-02T07:05:00'), 'Europe/Warsaw')
        expect(t).toEqual({ minute: 5, hour: 8, dom: 2, month: 3, dow: 1, key: '2026-03-02T08:05' })
    })

    it('reports midnight as hour 0, not 24', () => {
        const t = localTime(utc('2026-01-01T00:00:00'), 'UTC')
        expect(t.hour).toBe(0)
        expect(t.key).toBe('2026-01-01T00:00')
        expect(t.dow).toBe(4)
    })
})

describe('cronMatches', () => {
    const at = (iso: string, tz = 'UTC') => localTime(utc(iso), tz)

    it('matches minute, hour and the day fields', () => {
        const cron = parseCron('30 8 * * 1-5')
        expect(cronMatches(cron, at('2026-10-05T08:30:00'))).toBe(true) // Monday
        expect(cronMatches(cron, at('2026-10-05T08:31:00'))).toBe(false)
        expect(cronMatches(cron, at('2026-10-04T08:30:00'))).toBe(false) // Sunday
    })

    it('ORs the two day fields when both are restricted', () => {
        const cron = parseCron('0 0 1 * 1')
        expect(cronMatches(cron, at('2026-10-01T00:00:00'))).toBe(true) // the 1st, a Thursday
        expect(cronMatches(cron, at('2026-10-05T00:00:00'))).toBe(true) // a Monday, the 5th
        expect(cronMatches(cron, at('2026-10-06T00:00:00'))).toBe(false)
    })

    it('lets the restricted day field decide alone when the other is a star', () => {
        expect(cronMatches(parseCron('0 0 15 * *'), at('2026-10-15T00:00:00'))).toBe(true)
        expect(cronMatches(parseCron('0 0 15 * *'), at('2026-10-16T00:00:00'))).toBe(false)
    })

    it('checks the month', () => {
        const cron = parseCron('0 0 * jan *')
        expect(cronMatches(cron, at('2026-01-20T00:00:00'))).toBe(true)
        expect(cronMatches(cron, at('2026-02-20T00:00:00'))).toBe(false)
    })

    it('reads the time in the given zone', () => {
        const cron = parseCron('0 9 * * *')
        expect(cronMatches(cron, at('2026-07-01T07:00:00', 'Europe/Warsaw'))).toBe(true)
        expect(cronMatches(cron, at('2026-07-01T09:00:00', 'Europe/Warsaw'))).toBe(false)
    })
})

describe('parseWindow', () => {
    it.each([undefined, null, 'mon-fri', 42])('returns no window for %j', (raw) => {
        expect(parseWindow(raw)).toEqual({})
    })

    it('parses days and hours', () => {
        const w = parseWindow({ days: 'mon-fri', hours: '09:00-18:30' })
        expect(sorted(w.days!)).toEqual([1, 2, 3, 4, 5])
        expect(w.hours).toEqual({ from: 540, to: 1110 })
    })

    it('accepts bare hours, lists and 7 as Sunday', () => {
        const w = parseWindow({ days: 'sat,7', hours: '22-6' })
        expect(sorted(w.days!)).toEqual([0, 6])
        expect(w.hours).toEqual({ from: 1320, to: 360 })
    })

    it('allows 24:00 as the end', () => {
        expect(parseWindow({ hours: '18:00-24:00' }).hours).toEqual({ from: 1080, to: 1440 })
    })

    it.each([
        [{ days: '' }, /window.days must be/],
        [{ days: 5 }, /window.days must be/],
        [{ days: 'someday' }, /window.days/],
        [{ hours: '9 to 5' }, /window.hours must be like/],
        [{ hours: 9 }, /window.hours must be like/],
        [{ hours: '25:00-26:00' }, /hours 0-24/],
        [{ hours: '09:60-10:00' }, /minutes 0-59/],
        [{ hours: '10:00-10:00' }, /empty/]
    ])('rejects %j', (raw, message) => {
        expect(() => parseWindow(raw)).toThrow(message)
    })
})

describe('inWindow', () => {
    const at = (iso: string) => localTime(utc(iso), 'UTC')

    it('allows everything without a window', () => {
        expect(inWindow({}, at('2026-10-04T03:00:00'))).toBe(true)
    })

    it('filters by weekday', () => {
        const w = parseWindow({ days: 'mon-fri' })
        expect(inWindow(w, at('2026-10-05T12:00:00'))).toBe(true)
        expect(inWindow(w, at('2026-10-04T12:00:00'))).toBe(false)
    })

    it('includes the start and excludes the end of the hours', () => {
        const w = parseWindow({ hours: '09:00-18:00' })
        expect(inWindow(w, at('2026-10-05T08:59:00'))).toBe(false)
        expect(inWindow(w, at('2026-10-05T09:00:00'))).toBe(true)
        expect(inWindow(w, at('2026-10-05T17:59:00'))).toBe(true)
        expect(inWindow(w, at('2026-10-05T18:00:00'))).toBe(false)
    })

    it('wraps past midnight when the end is before the start', () => {
        const w = parseWindow({ hours: '22:00-06:00' })
        expect(inWindow(w, at('2026-10-05T23:30:00'))).toBe(true)
        expect(inWindow(w, at('2026-10-05T05:59:00'))).toBe(true)
        expect(inWindow(w, at('2026-10-05T06:00:00'))).toBe(false)
        expect(inWindow(w, at('2026-10-05T12:00:00'))).toBe(false)
    })
})

describe('nextRun', () => {
    it('finds the next minute strictly after the start', () => {
        const next = nextRun(parseCron('* * * * *'), {}, 'UTC', utc('2026-10-06T10:00:30'))
        expect(next?.toISOString()).toBe('2026-10-06T10:01:00.000Z')
        const exact = nextRun(parseCron('0 * * * *'), {}, 'UTC', utc('2026-10-06T10:00:00'))
        expect(exact?.toISOString()).toBe('2026-10-06T11:00:00.000Z')
    })

    it('jumps days for a weekly schedule', () => {
        // Tuesday → the next Monday 08:00
        const next = nextRun(parseCron('0 8 * * mon'), {}, 'UTC', utc('2026-10-06T12:00:00'))
        expect(next?.toISOString()).toBe('2026-10-12T08:00:00.000Z')
    })

    it('reads the cron in the zone', () => {
        const next = nextRun(parseCron('0 9 * * *'), {}, 'America/Los_Angeles', utc('2026-07-01T00:00:00'))
        expect(next?.toISOString()).toBe('2026-07-01T16:00:00.000Z') // PDT, UTC-7
        const winter = nextRun(parseCron('0 9 * * *'), {}, 'America/Los_Angeles', utc('2026-01-15T00:00:00'))
        expect(winter?.toISOString()).toBe('2026-01-15T17:00:00.000Z') // PST, UTC-8
    })

    it('follows the zone across the spring-forward change', () => {
        // Europe/Warsaw goes from +01:00 to +02:00 on 2026-03-29 at 02:00 local.
        const before = nextRun(parseCron('30 8 * * *'), {}, 'Europe/Warsaw', utc('2026-03-28T12:00:00'))
        expect(before?.toISOString()).toBe('2026-03-29T06:30:00.000Z')
    })

    it('skips a local time that does not exist on the spring-forward day', () => {
        // 02:30 never happens in Warsaw on 2026-03-29; the next one is the day after.
        const next = nextRun(parseCron('30 2 * * *'), {}, 'Europe/Warsaw', utc('2026-03-28T12:00:00'))
        expect(next?.toISOString()).toBe('2026-03-30T00:30:00.000Z')
    })

    it('fires on the first of the two repeated hours at the fall-back change', () => {
        // Warsaw: 2026-10-25 03:00 +02:00 → 02:00 +01:00; 02:30 happens twice, first at 00:30Z.
        const next = nextRun(parseCron('30 2 * * *'), {}, 'Europe/Warsaw', utc('2026-10-24T12:00:00'))
        expect(next?.toISOString()).toBe('2026-10-25T00:30:00.000Z')
    })

    it('honours the window', () => {
        const cron = parseCron('0 * * * *')
        const window = parseWindow({ days: 'mon-fri', hours: '09:00-17:00' })
        // Saturday afternoon → Monday 09:00
        const next = nextRun(cron, window, 'UTC', utc('2026-10-03T15:00:00'))
        expect(next?.toISOString()).toBe('2026-10-05T09:00:00.000Z')
    })

    it('returns null for an expression that never matches', () => {
        expect(nextRun(parseCron('0 0 31 feb *'), {}, 'UTC', utc('2026-01-01T00:00:00'))).toBeNull()
    })

    it('finds a leap day within a year', () => {
        const next = nextRun(parseCron('0 0 29 feb *'), {}, 'UTC', utc('2027-06-01T00:00:00'))
        expect(next?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
    })
})

describe('startOfDay', () => {
    it('is midnight UTC in UTC', () => {
        expect(startOfDay(utc('2026-10-06T15:42:10'), 'UTC').toISOString()).toBe('2026-10-06T00:00:00.000Z')
    })

    it('is local midnight in a zone ahead of UTC', () => {
        // 23:30Z on the 5th is already the 6th in Warsaw (+02:00).
        expect(startOfDay(utc('2026-10-05T23:30:00'), 'Europe/Warsaw').toISOString()).toBe('2026-10-05T22:00:00.000Z')
    })

    it('is local midnight in a zone behind UTC', () => {
        // 03:00Z on the 6th is still the 5th in Los Angeles (-07:00).
        expect(startOfDay(utc('2026-10-06T03:00:00'), 'America/Los_Angeles').toISOString()).toBe(
            '2026-10-05T07:00:00.000Z'
        )
    })

    it.each([
        ['spring forward', '2026-03-29T20:00:00', '2026-03-28T23:00:00.000Z'],
        ['fall back', '2026-10-25T20:00:00', '2026-10-24T22:00:00.000Z']
    ])('lands on the right side of a DST change (%s)', (_, at, expected) => {
        expect(startOfDay(utc(at), 'Europe/Warsaw').toISOString()).toBe(expected)
    })

    // Bug: on a day whose midnight does not exist (America/Santiago springs forward at 24:00 on
    // 2026-09-05, so the 6th starts at 01:00 local = 04:00Z), the second offset read is taken at the
    // first guess (04:00Z, already -03:00) and the result lands at 03:00Z, 23:00 of the previous day.
    it.fails('handles a zone whose clocks change at midnight', () => {
        const start = startOfDay(utc('2026-09-06T15:00:00'), 'America/Santiago')
        expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z')
        expect(localTime(start, 'America/Santiago').key.slice(0, 10)).toBe('2026-09-06')
        expect(localTime(new Date(start.getTime() - 60_000), 'America/Santiago').key.slice(0, 10)).toBe('2026-09-05')
    })
})

describe('isTimeZone', () => {
    it.each(['UTC', 'Europe/Warsaw', 'America/Los_Angeles', 'Asia/Kolkata'])('accepts %s', (tz) => {
        expect(isTimeZone(tz)).toBe(true)
    })

    it.each(['Mars/Olympus', 'Europe/Nowhere', 'not a zone'])('rejects %s', (tz) => {
        expect(isTimeZone(tz)).toBe(false)
    })
})

describe('describeCron', () => {
    it.each([
        ['* * * * *', 'every minute'],
        ['*/15 * * * *', 'every 15 min'],
        ['*/15 9-17 * * *', 'every 15 min between 09:00 and 17:59'],
        ['5 * * * *', 'hourly at :05'],
        ['0 */6 * * *', 'every 6 hours at :00'],
        ['0 8 * * *', 'at 08:00 every day'],
        ['0 8 * * 1-5', 'at 08:00 on weekdays'],
        ['0 10 * * sat,sun', 'at 10:00 at weekends'],
        ['0 8,12,18 * * *', 'at 08:00, 12:00, 18:00 every day'],
        ['30 2 1 jan,jul *', 'at 02:30 on day 1 of the month in Jan, Jul'],
        ['0 9 * * mon,wed', 'at 09:00 on Mon, Wed'],
        ['0 9 1 * mon', 'at 09:00 on day 1 of the month or on Mon'],
        ['* 9-11 * * *', 'every minute of 09h–11h'],
        ['0,30 9 * * *', 'every 30 min between 09:00 and 09:59'],
        ['0,20 * * * *', 'at minutes 0, 20 of every hour every day'],
        ['0 1-3,5 * * *', 'at 01:00, 02:00, 03:00, 05:00 every day'],
        ['0 0,2,4,6,8,10,12 * * *', 'at :00 during 00h, 02h, 04h, 06h, 08h, 10h, 12h every day'],
        ['* * * * mon', 'every minute on Mon'],
        ['@monthly', 'at 00:00 on day 1 of the month']
    ])('%s → %s', (expr, text) => {
        expect(describeCron(parseCron(expr))).toBe(text)
    })
})
