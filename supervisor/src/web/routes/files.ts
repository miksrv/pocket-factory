import { Hono } from 'hono'

import type { Kind } from '../../files/catalog.js'
import type { Env } from '../context.js'

const KINDS: Kind[] = ['agents', 'skills', 'projects']

/** CRUD for agents, skills and projects — the same files the agent edits. */
export function fileRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    for (const kind of KINDS) {
        app.get(`/${kind}`, (c) => c.json(c.get('app').catalog.list(kind)))

        app.get(`/${kind}/:name`, (c) => c.json(c.get('app').catalog.get(kind, c.req.param('name'))))

        app.put(`/${kind}/:name`, async (c) => {
            const { catalog } = c.get('app')
            const body = (await c.req.json()) as { frontmatter?: Record<string, unknown>; body?: string }
            const name = c.req.param('name')
            const created = !catalog.exists(kind, name)
            const entry = catalog.save(kind, name, { frontmatter: body.frontmatter ?? {}, body: body.body ?? '' })
            return c.json(entry, created ? 201 : 200)
        })

        app.delete(`/${kind}/:name`, (c) => {
            c.get('app').catalog.remove(kind, c.req.param('name'))
            return c.body(null, 204)
        })
    }

    return app
}
