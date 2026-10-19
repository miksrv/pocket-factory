import { Hono } from 'hono'

import { localTime, startOfDay } from '../../routines/cron.js'
import type { TokensByDayRow } from '../../store/index.js'
import type { Env } from '../context.js'

/** The ranges the Overview's chart offers. */
const RANGES = [7, 30, 90]

/** The subscription's model families, each with its own colour slot (the chart's `--chart-<n>`), in stacking order. */
const FAMILIES: Array<{ match: RegExp; label: string; slot: number }> = [
    { match: /sonnet/i, label: 'Sonnet', slot: 1 },
    { match: /opus/i, label: 'Opus', slot: 2 },
    { match: /haiku/i, label: 'Haiku', slot: 3 },
    { match: /fable/i, label: 'Fable', slot: 4 }
]
/** Any other model on the subscription; providers take the slots left, in providers.yaml order. */
const OTHER_CLAUDE_SLOT = 7
const PROVIDER_SLOTS = [5, 6, 8]

export interface DailySeries {
    key: string
    label: string
    kind: 'subscription' | 'provider'
    /** The colour slot, fixed per model family or provider; null = past the palette (drawn gray). */
    slot: number | null
    values: number[]
    total: number
}

/** The last `count` days of the owner's zone as [start, end), oldest first, today (so far) last. */
export function ownerDays(
    count: number,
    tz: string,
    now = new Date()
): Array<{ date: string; start: string; end: string }> {
    const days: Array<{ date: string; start: string; end: string }> = []
    let end = now
    let start = startOfDay(now, tz)
    for (let i = 0; i < count; i++) {
        days.unshift({
            date: localTime(start, tz).key.slice(0, 10),
            start: start.toISOString(),
            end: end.toISOString()
        })
        end = start
        start = startOfDay(new Date(start.getTime() - 1), tz)
    }
    return days
}

/**
 * One series per model family on the subscription and per provider, each with a value for every
 * day; `providers` is providers.yaml's order, which fixes their colours. A model call with no
 * model id (the CLI's synthetic messages) has no tokens and never reaches here.
 */
export function dailySeries(rows: TokensByDayRow[], dayCount: number, providers: string[]): DailySeries[] {
    const series = new Map<string, DailySeries>()
    const known = [
        ...providers,
        ...rows.flatMap((r) => (r.provider && !providers.includes(r.provider) ? [r.provider] : []))
    ]
    const order = [...new Set(known)]
    for (const row of rows) {
        let key: string
        let label: string
        let slot: number | null
        if (row.provider) {
            key = `provider:${row.provider}`
            label = row.provider
            slot = PROVIDER_SLOTS[order.indexOf(row.provider)] ?? null
        } else {
            const family = FAMILIES.find((f) => f.match.test(row.model ?? ''))
            key = `claude:${family?.label.toLowerCase() ?? 'other'}`
            label = family?.label ?? 'Claude'
            slot = family?.slot ?? OTHER_CLAUDE_SLOT
        }
        let s = series.get(key)
        if (!s) {
            s = {
                key,
                label,
                kind: row.provider ? 'provider' : 'subscription',
                slot,
                values: Array<number>(dayCount).fill(0),
                total: 0
            }
            series.set(key, s)
        }
        s.values[row.day] += row.tokens
        s.total += row.tokens
    }
    // The subscription first, then the providers; within each, by slot, so the stack keeps its order whatever is missing.
    return [...series.values()].sort(
        (a, b) =>
            Number(a.kind === 'provider') - Number(b.kind === 'provider') ||
            (a.slot ?? 99) - (b.slot ?? 99) ||
            a.label.localeCompare(b.label)
    )
}

/**
 * Subscription rate limits: the 5-hour and 7-day windows as the CLI last
 * reported them. Readings arrive for free with every task; a probe spends one
 * Haiku turn to refresh them on demand.
 */
export function usageRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', (c) => {
        const { store, tasks } = c.get('app')
        return c.json({
            latest: tasks.limits() ?? null,
            history: store.listRateLimits(Math.min(Number(c.req.query('limit')) || 100, 1000)),
            probing: tasks.probing()
        })
    })

    /** Tokens per day and model for the Overview's chart: `?days=7|30|90`, days in TIMEZONE. */
    app.get('/daily', (c) => {
        const { config, store, tasks } = c.get('app')
        const asked = Number(c.req.query('days'))
        const count = RANGES.includes(asked) ? asked : 30
        const days = ownerDays(count, config.timezone)
        const providers = tasks.providerStatus().map((p) => p.name)
        return c.json({
            days: days.map((d) => d.date),
            series: dailySeries(store.tokensByDay(days), count, providers)
        })
    })

    app.post('/probe', async (c) => {
        const { tasks } = c.get('app')
        const snapshot = await tasks.probeLimits()
        if (!snapshot) return c.json({ error: 'the CLI reported no rate-limit status; check the supervisor log' }, 502)
        return c.json(snapshot)
    })

    return app
}
