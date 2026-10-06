import { Hono } from 'hono'

import type { Kind } from '../../files/catalog.js'
import type { Env } from '../context.js'

const KINDS: Kind[] = ['agents', 'skills', 'projects', 'schedules']

/** CRUD for agents, skills, projects and schedules — the same files the agent edits. */
export function fileRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    for (const kind of KINDS) {
        app.get(`/${kind}`, (c) => c.json(c.get('app').catalog.list(kind)))

        app.get(`/${kind}/:name`, (c) => c.json(c.get('app').catalog.get(kind, c.req.param('name'))))

        /** Upsert; with `?create=1` the request is a "new file" and must not replace one that exists. */
        app.put(`/${kind}/:name`, async (c) => {
            const { catalog } = c.get('app')
            const body = (await c.req.json().catch(() => ({}))) as {
                frontmatter?: unknown
                body?: unknown
                updated_at?: unknown
            }
            const frontmatter = body.frontmatter ?? {}
            if (typeof frontmatter !== 'object' || Array.isArray(frontmatter))
                return c.json({ error: 'frontmatter must be an object' }, 400)
            if (body.body !== undefined && typeof body.body !== 'string')
                return c.json({ error: 'body must be a string' }, 400)
            const name = c.req.param('name')
            const created = !catalog.exists(kind, name)
            if (!created && c.req.query('create'))
                return c.json({ error: `${kind}/${name} already exists — open it from the list to edit it` }, 409)
            const current = created ? null : catalog.get(kind, name)
            if (current?.frontmatter_error) {
                return c.json(
                    {
                        error: `${kind}/${name} has invalid YAML frontmatter on disk (${current.frontmatter_error}); fix the file by hand before saving from the UI, or it would lose its frontmatter`
                    },
                    409
                )
            }
            // The form says which version it edited; the agent may have written the file since (a schedule's notes after a run).
            if (current && typeof body.updated_at === 'string' && body.updated_at !== current.updated_at) {
                return c.json(
                    {
                        error: `${kind}/${name} changed on disk since you opened it (updated ${current.updated_at}, maybe by the agent): reload it and apply your edit again`,
                        changed: true
                    },
                    409
                )
            }
            const fm = { ...(frontmatter as Record<string, unknown>) }
            // A schedule is switched on and off by PUT /api/schedules/:name/enabled, never by the form,
            // whose copy of the frontmatter predates the switch: the file on disk keeps its say.
            if (kind === 'schedules' && current) {
                if (current.frontmatter.enabled === undefined) delete fm.enabled
                else fm.enabled = current.frontmatter.enabled
            }
            const entry = catalog.save(kind, name, { frontmatter: fm, body: body.body ?? '' })
            return c.json(entry, created ? 201 : 200)
        })

        app.delete(`/${kind}/:name`, (c) => {
            c.get('app').catalog.remove(kind, c.req.param('name'))
            return c.body(null, 204)
        })
    }

    return app
}
