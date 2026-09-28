import { Hono } from 'hono'

import type { Env } from '../context.js'

const PERIODS: Record<string, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }

/** Who worked how much: per-agent runs, tokens, last activity and what is running now. */
export function activityRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/agents', (c) => {
        const { store } = c.get('app')
        const period = c.req.query('period') ?? '7d'
        const since = PERIODS[period] ? new Date(Date.now() - PERIODS[period]).toISOString() : undefined
        return c.json(store.agentActivity(since))
    })

    return app
}
