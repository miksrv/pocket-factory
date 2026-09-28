import { Hono } from 'hono'

import type { Env } from '../context.js'

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
            history: store.listRateLimits(Number(c.req.query('limit') ?? 100)),
            probing: tasks.probing()
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
