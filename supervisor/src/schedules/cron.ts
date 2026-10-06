/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week)
 * matched in a time zone, without a dependency: the scheduler only ever asks
 * "does this minute match?" and "when is the next one?". Supported: `*`,
 * lists, ranges, steps (every 15 minutes as star-slash-15, `1-5/2`), month and weekday names, `7` as
 * Sunday. Standard semantics when both day fields are restricted: either
 * matches.
 */
export interface Cron {
    minute: Set<number>
    hour: Set<number>
    dom: Set<number>
    month: Set<number>
    dow: Set<number>
    /** Both day fields restricted → OR, as cron does; one of them a `*` → the other alone decides. */
    domAny: boolean
    dowAny: boolean
    source: string
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const ALIASES: Record<string, string> = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *'
}

function parseField(field: string, min: number, max: number, names: string[] | null, what: string): Set<number> {
    const out = new Set<number>()
    const value = (token: string): number => {
        const lower = token.toLowerCase()
        if (names) {
            const index = names.indexOf(lower.slice(0, 3))
            if (index >= 0 && lower.length === 3) return index + (names === MONTHS ? 1 : 0)
        }
        if (!/^\d+$/.test(token)) throw new Error(`${what}: "${token}" is not a number`)
        return Number(token)
    }
    for (const part of field.split(',')) {
        if (!part) throw new Error(`${what}: empty list item`)
        const [rangePart, stepPart] = part.split('/')
        const step = stepPart === undefined ? 1 : Number(stepPart)
        if (!Number.isInteger(step) || step < 1) throw new Error(`${what}: bad step "/${stepPart}"`)
        let lo: number
        let hi: number
        if (rangePart === '*') {
            lo = min
            hi = max
        } else if (rangePart.includes('-')) {
            const [a, b] = rangePart.split('-')
            lo = value(a)
            hi = value(b)
        } else {
            lo = value(rangePart)
            hi = stepPart === undefined ? lo : max
        }
        if (lo < min || hi > max || lo > hi) throw new Error(`${what}: "${part}" is outside ${min}-${max}`)
        for (let v = lo; v <= hi; v += step) out.add(v)
    }
    return out
}

export function parseCron(expression: string): Cron {
    const source = expression.trim()
    const text = ALIASES[source.toLowerCase()] ?? source
    const fields = text.split(/\s+/)
    if (fields.length !== 5)
        throw new Error(`a cron expression has five fields (minute hour day month weekday), got ${fields.length}`)
    const dow = parseField(fields[4], 0, 7, DAYS, 'weekday')
    if (dow.has(7)) {
        dow.delete(7)
        dow.add(0)
    }
    return {
        minute: parseField(fields[0], 0, 59, null, 'minute'),
        hour: parseField(fields[1], 0, 23, null, 'hour'),
        dom: parseField(fields[2], 1, 31, null, 'day of month'),
        month: parseField(fields[3], 1, 12, MONTHS, 'month'),
        dow,
        domAny: fields[2] === '*',
        dowAny: fields[4] === '*',
        source
    }
}

/** The wall-clock parts of an instant in a time zone. */
export interface LocalTime {
    minute: number
    hour: number
    dom: number
    month: number
    /** 0 = Sunday. */
    dow: number
    /** `YYYY-MM-DDTHH:MM` in that zone: the identity of a minute. */
    key: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

export function isTimeZone(tz: string): boolean {
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz })
        return true
    } catch {
        return false
    }
}

export function localTime(date: Date, tz: string): LocalTime {
    let fmt = formatters.get(tz)
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            weekday: 'short'
        })
        formatters.set(tz, fmt)
    }
    const parts: Record<string, string> = {}
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
    const hour = Number(parts.hour) % 24
    return {
        minute: Number(parts.minute),
        hour,
        dom: Number(parts.day),
        month: Number(parts.month),
        dow: DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
        key: `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, '0')}:${parts.minute}`
    }
}

/**
 * The instant the local day of `date` began in `tz` (its midnight), for
 * "today" counters. The zone's offset is read twice, so a day that starts
 * on a DST change still lands on the right side of it.
 */
export function startOfDay(date: Date, tz: string): Date {
    const wall = (ms: number) => {
        const t = localTime(new Date(ms), tz)
        const [y, m, d] = t.key.slice(0, 10).split('-').map(Number)
        return Date.UTC(y, m - 1, d, t.hour, t.minute)
    }
    const offset = (ms: number) => wall(ms) - Math.floor(ms / 60_000) * 60_000
    const [y, m, d] = localTime(date, tz).key.slice(0, 10).split('-').map(Number)
    const midnight = Date.UTC(y, m - 1, d)
    return new Date(midnight - offset(midnight - offset(midnight)))
}

function dayMatches(cron: Cron, t: LocalTime): boolean {
    if (!cron.month.has(t.month)) return false
    if (cron.domAny && cron.dowAny) return true
    if (cron.domAny) return cron.dow.has(t.dow)
    if (cron.dowAny) return cron.dom.has(t.dom)
    return cron.dom.has(t.dom) || cron.dow.has(t.dow)
}

export function cronMatches(cron: Cron, t: LocalTime): boolean {
    return dayMatches(cron, t) && cron.hour.has(t.hour) && cron.minute.has(t.minute)
}

/**
 * An active window on top of the cron: which weekdays and which hours (in the
 * schedule's zone) a firing is allowed in. `days` is a list or range of
 * weekday names (`mon-fri`, `mon,wed,fri`), `hours` is `HH:MM-HH:MM`
 * (end exclusive; an end before the start wraps past midnight).
 */
export interface Window {
    days?: Set<number>
    hours?: { from: number; to: number }
}

export function parseWindow(raw: unknown): Window {
    if (!raw || typeof raw !== 'object') return {}
    const { days, hours } = raw as { days?: unknown; hours?: unknown }
    const window: Window = {}
    if (days !== undefined) {
        if (typeof days !== 'string' || !days.trim())
            throw new Error('window.days must be like "mon-fri" or "mon,wed,fri"')
        window.days = parseField(days.trim(), 0, 7, DAYS, 'window.days')
        if (window.days.has(7)) {
            window.days.delete(7)
            window.days.add(0)
        }
    }
    if (hours !== undefined) {
        const m =
            typeof hours === 'string' ? /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(hours) : null
        if (!m) throw new Error('window.hours must be like "09:00-18:00"')
        const from = Number(m[1]) * 60 + Number(m[2] ?? 0)
        const to = Number(m[3]) * 60 + Number(m[4] ?? 0)
        if (from > 24 * 60 || to > 24 * 60 || Number(m[2] ?? 0) > 59 || Number(m[4] ?? 0) > 59)
            throw new Error('window.hours: hours 0-24, minutes 0-59')
        if (from === to) throw new Error('window.hours: the window is empty')
        window.hours = { from, to }
    }
    return window
}

export function inWindow(window: Window, t: LocalTime): boolean {
    if (window.days && !window.days.has(t.dow)) return false
    if (window.hours) {
        const m = t.hour * 60 + t.minute
        const { from, to } = window.hours
        if (from < to ? m < from || m >= to : m < from && m >= to) return false
    }
    return true
}

const MINUTE = 60_000

/**
 * The first minute after `from` that the cron and the window both allow, or
 * null within a year. Walks minute by minute but jumps to the next hour or
 * day when the larger field cannot match, so a weekly schedule is found in a
 * few hundred steps.
 */
export function nextRun(cron: Cron, window: Window, tz: string, from = new Date()): Date | null {
    let t = new Date(Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE)
    const limit = t.getTime() + 366 * 24 * 60 * MINUTE
    for (let steps = 0; steps < 200_000 && t.getTime() < limit; steps++) {
        const local = localTime(t, tz)
        if (!dayMatches(cron, local) || (window.days && !window.days.has(local.dow))) {
            // Next day, 00:00 local (DST may make it 23:00 or 01:00; the loop corrects).
            t = new Date(t.getTime() + ((23 - local.hour) * 60 + (60 - local.minute)) * MINUTE)
            continue
        }
        if (!cron.hour.has(local.hour)) {
            t = new Date(t.getTime() + (60 - local.minute) * MINUTE)
            continue
        }
        if (cron.minute.has(local.minute) && inWindow(window, local)) return t
        t = new Date(t.getTime() + MINUTE)
    }
    return null
}

const two = (n: number) => String(n).padStart(2, '0')
const cap = (w: string) => w.replace(/^./, (c) => c.toUpperCase())

/** Consecutive values as ranges: 1,2,3,5 → ["1–3", "5"]. */
function ranges(values: number[], name: (n: number) => string): string[] {
    const sorted = [...values].sort((a, b) => a - b)
    const out: string[] = []
    for (let i = 0; i < sorted.length;) {
        let j = i
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
        out.push(
            j - i >= 2
                ? `${name(sorted[i])}–${name(sorted[j])}`
                : sorted
                      .slice(i, j + 1)
                      .map(name)
                      .join(', ')
        )
        i = j + 1
    }
    return out
}

/** The step when the set is 0, n, 2n, … (or a, a+n, …) and divides the period evenly; else null. */
function stepOf(values: number[], period: number): number | null {
    const sorted = [...values].sort((a, b) => a - b)
    if (sorted.length < 2) return null
    const step = sorted[1] - sorted[0]
    if (step < 1 || !sorted.every((v, i) => i === 0 || v - sorted[i - 1] === step)) return null
    return sorted[0] === 0 && period % step === 0 && sorted.length === period / step ? step : null
}

/**
 * The expression in words, every part of it: "at 08:00 on weekdays",
 * "every 15 min between 09:00 and 17:59 on Mon, Wed", "at 02:30 on day 1
 * in Jan, Jul", "every minute". What the owner typed, read back.
 */
export function describeCron(cron: Cron): string {
    const minutes = [...cron.minute].sort((a, b) => a - b)
    const hours = [...cron.hour].sort((a, b) => a - b)
    const allMinutes = minutes.length === 60
    const allHours = hours.length === 24
    const minuteStep = stepOf(minutes, 60)
    const hourStep = stepOf(hours, 24)

    // ---- time of day ----
    let time: string
    if (allMinutes && allHours) time = 'every minute'
    else if (allMinutes) time = `every minute of ${hourRanges(hours)}`
    else if (minuteStep && allHours) time = `every ${minuteStep} min`
    else if (minuteStep) time = `every ${minuteStep} min ${hourWindow(hours)}`
    else if (minutes.length === 1 && allHours) time = `hourly at :${two(minutes[0])}`
    else if (minutes.length === 1 && hourStep) time = `every ${hourStep} hours at :${two(minutes[0])}`
    else if (minutes.length === 1 && hours.length <= 6)
        time = `at ${hours.map((h) => `${two(h)}:${two(minutes[0])}`).join(', ')}`
    else if (minutes.length === 1) time = `at :${two(minutes[0])} ${hourWindow(hours)}`
    else if (allHours) time = `at minutes ${ranges(minutes, String).join(', ')} of every hour`
    else if (minutes.length * hours.length <= 6)
        time = `at ${hours.flatMap((h) => minutes.map((m) => `${two(h)}:${two(m)}`)).join(', ')}`
    else time = `at minutes ${ranges(minutes, String).join(', ')} ${hourWindow(hours)}`

    // ---- days ----
    const days: string[] = []
    const dow = [...cron.dow].sort((a, b) => a - b)
    const dom = [...cron.dom].sort((a, b) => a - b)
    const dowText =
        dow.join(',') === '1,2,3,4,5'
            ? 'on weekdays'
            : dow.join(',') === '0,6'
              ? 'at weekends'
              : dow.length === 7
                ? ''
                : `on ${ranges(dow, (d) => cap(DAYS[d])).join(', ')}`
    const domText = dom.length === 31 ? '' : `on day ${ranges(dom, String).join(', ')} of the month`
    if (!cron.domAny && !cron.dowAny) days.push([domText, dowText].filter(Boolean).join(' or '))
    else if (!cron.dowAny) days.push(dowText)
    else if (!cron.domAny) days.push(domText)
    if (time === 'every minute' && !days.filter(Boolean).length) return time
    if (!days.filter(Boolean).length && !time.startsWith('every') && !time.startsWith('hourly')) days.push('every day')

    // ---- months ----
    const months = [...cron.month].sort((a, b) => a - b)
    const monthText = months.length === 12 ? '' : `in ${ranges(months, (m) => cap(MONTHS[m - 1])).join(', ')}`

    return [time, ...days, monthText].filter(Boolean).join(' ')
}

function hourRanges(hours: number[]): string {
    return ranges(hours, (h) => `${two(h)}h`).join(', ')
}

/** "between 09:00 and 17:59" for a single run of hours, else the list. */
function hourWindow(hours: number[]): string {
    const sorted = [...hours].sort((a, b) => a - b)
    const contiguous = sorted.every((h, i) => i === 0 || h === sorted[i - 1] + 1)
    if (contiguous) return `between ${two(sorted[0])}:00 and ${two(sorted[sorted.length - 1])}:59`
    return `during ${hourRanges(sorted)}`
}
