import { Hono } from 'hono'

import type { Env } from '../context.js'

export function historyRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', async (c) => c.json(await c.get('app').history.log(Number(c.req.query('limit') ?? 50))))

    app.get('/:repo/:hash', async (c) => {
        const diff = await c.get('app').history.show(c.req.param('repo'), c.req.param('hash'))
        if (diff === null) return c.json({ error: 'commit not found' }, 404)
        return c.text(diff)
    })

    return app
}
