import path from 'node:path'

import { Hono } from 'hono'

import { BadName, type FolderKind, type Kind } from '../../files/catalog.js'
import type { Env } from '../context.js'

const KINDS: Kind[] = ['agents', 'skills', 'projects', 'routines']
const FOLDER_KINDS: FolderKind[] = ['skills', 'routines']

/** CRUD for agents, skills, projects and routines — the same files the agent edits. */
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
            // The form says which version it edited; the agent may have written the file since (a routine's notes after a run).
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
            // A routine is switched on and off by PUT /api/routines/:name/enabled, never by the form,
            // whose copy of the frontmatter predates the switch: the file on disk keeps its say.
            if (kind === 'routines' && current) {
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

    // A skill and a routine are folders: the scripts, data and references next to the main file are listed and edited here.
    for (const kind of FOLDER_KINDS) {
        // The path after `/<kind>/<name>/files/`, read from the raw URL segment by segment: a routine
        // named `files` keeps its path, a stray `%` is a bad name, not a crash.
        const relOf = (url: string) => {
            const segments = new URL(url).pathname.split('/')
            const at = segments.indexOf(kind)
            if (at < 0 || segments[at + 2] !== 'files') throw new BadName('not a folder file path')
            try {
                return segments
                    .slice(at + 3)
                    .map((s) => decodeURIComponent(s))
                    .join('/')
            } catch {
                throw new BadName('the file path is not valid URL encoding')
            }
        }
        app.get(`/${kind}/:name/files`, (c) => c.json(c.get('app').catalog.folderFiles(kind, c.req.param('name'))))
        app.get(`/${kind}/:name/files/*`, (c) => {
            const { catalog } = c.get('app')
            const name = c.req.param('name')
            const rel = relOf(c.req.url)
            if (c.req.query('raw')) {
                // A download, never rendered: the file is whatever a run or an upload put there.
                const bytes = catalog.readFolderBytes(kind, name, rel)
                c.header('Content-Type', 'application/octet-stream')
                c.header(
                    'Content-Disposition',
                    `attachment; filename="${path.basename(rel).replace(/["\\\r\n]/g, '_')}"`
                )
                c.header('Content-Security-Policy', "default-src 'none'; sandbox")
                c.header('X-Content-Type-Options', 'nosniff')
                return c.body(new Uint8Array(bytes))
            }
            return c.json({ path: rel, ...catalog.readFolderFile(kind, name, rel) })
        })
        /** Text from the editor (`text`, with the `updated_at` it opened), or an upload (`base64`); `exec` sets the executable bit. */
        app.put(`/${kind}/:name/files/*`, async (c) => {
            const rel = relOf(c.req.url)
            const body = (await c.req.json().catch(() => ({}))) as {
                text?: unknown
                base64?: unknown
                updated_at?: unknown
                exec?: unknown
            }
            const content =
                typeof body.text === 'string'
                    ? body.text
                    : typeof body.base64 === 'string'
                      ? Buffer.from(body.base64, 'base64')
                      : null
            if (content === null) return c.json({ error: 'text or base64 is required' }, 400)
            return c.json(
                c.get('app').catalog.writeFolderFile(kind, c.req.param('name'), rel, content, {
                    updatedAt: typeof body.updated_at === 'string' ? body.updated_at : undefined,
                    exec: typeof body.exec === 'boolean' ? body.exec : undefined
                })
            )
        })
        /** Rename or move a file inside the folder. */
        app.post(`/${kind}/:name/rename`, async (c) => {
            const body = (await c.req.json().catch(() => ({}))) as { from?: unknown; to?: unknown }
            if (typeof body.from !== 'string' || typeof body.to !== 'string')
                return c.json({ error: 'from and to are required' }, 400)
            return c.json(c.get('app').catalog.renameFolderFile(kind, c.req.param('name'), body.from, body.to))
        })
        app.delete(`/${kind}/:name/files/*`, (c) => {
            c.get('app').catalog.removeFolderFile(kind, c.req.param('name'), relOf(c.req.url))
            return c.body(null, 204)
        })
    }

    return app
}
