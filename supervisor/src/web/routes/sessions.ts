import path from 'node:path'

import { Hono } from 'hono'

import type { Env } from '../context.js'

export function sessionRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** Most recently updated first; `before` = updated_at of the last row for the next page. */
    app.get('/', async (c) => {
        const { transcripts, store, config } = c.get('app')
        const list = transcripts.list(Math.min(Number(c.req.query('limit')) || 50, 200), c.req.query('before') || undefined)
        const tasksBySession = new Map(store.listTasks({ limit: 1000 }).map((task) => [task.session_id, task]))
        const root = path.resolve(config.paths.workspacesRoot)
        const withHeads = await Promise.all(
            list.map(async (entry) => {
                const head = await transcripts.head(entry.path)
                const task = tasksBySession.get(entry.session_id)
                // The project the task detected, else the cwd relative to the
                // workspaces root ('.' is the root itself; tasks start there).
                const relative = head.cwd ? path.relative(root, head.cwd) : null
                const fromCwd = relative === null ? null : relative === '' ? '.' : relative.startsWith('..') ? head.cwd : relative
                return {
                    ...entry,
                    ...head,
                    project: task?.project ?? fromCwd,
                    task_id: task?.id ?? null,
                    conversation_id: task?.conversation_id ?? null
                }
            })
        )
        return c.json(withHeads)
    })

    /** A window of the transcript: `limit` entries ending before index `before` (default: the end). */
    app.get('/:id', async (c) => {
        const { transcripts } = c.get('app')
        const summary = transcripts.find(c.req.param('id'))
        if (!summary) return c.json({ error: 'session not found' }, 404)
        const before = Number(c.req.query('before')) || undefined
        const limit = Math.min(Number(c.req.query('limit')) || 200, 1000)
        const window = await transcripts.read(summary.session_id, { before, limit })
        if (!window) return c.json({ error: 'session not found' }, 404)
        return c.json({ ...summary, ...window })
    })

    return app
}
