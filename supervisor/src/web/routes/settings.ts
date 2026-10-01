import { Hono } from 'hono'

import { MODEL_ALIASES } from '../../claude/models.js'
import type { Env } from '../context.js'

/**
 * Settings the owner changes at run time, kept in `meta`. Today only the
 * orchestrator's model: one value for the whole factory, applied to the next
 * task in every conversation (Telegram `/model` writes the same key).
 */
export function settingsRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/model', (c) => c.json({ model: c.get('app').tasks.model(), aliases: MODEL_ALIASES }))

    app.put('/model', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { model?: unknown } | null
        if (!body || typeof body.model !== 'string') return c.json({ error: 'model (an alias) is required' }, 400)
        try {
            return c.json({ model: c.get('app').tasks.setModel(body.model), aliases: MODEL_ALIASES })
        } catch (error) {
            return c.json({ error: (error as Error).message }, 400)
        }
    })

    return app
}
