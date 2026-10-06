import path from 'node:path'

import { Hono } from 'hono'

import type { Task } from '../../store/index.js'
import type { Env } from '../context.js'
import { cursorOf } from './cursor.js'

export function sessionRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** Most recently updated first; `before` + `before_id` = the last row shown, for the next page. */
    app.get('/', async (c) => {
        const { transcripts, store, config } = c.get('app')
        const list = transcripts.list(Math.min(Number(c.req.query('limit')) || 50, 200), cursorOf(c))
        // Resumed tasks share a session: keep the newest one (the list is newest first).
        const tasksBySession = new Map<string, Task>()
        for (const task of store.listTasks({ limit: 1000 })) {
            if (task.session_id && !tasksBySession.has(task.session_id)) tasksBySession.set(task.session_id, task)
        }
        const root = path.resolve(config.paths.workspacesRoot)
        const withHeads = await Promise.all(
            list.map(async (entry) => {
                const head = await transcripts.head(entry.path)
                const task = tasksBySession.get(entry.session_id)
                // The project the task detected, else the cwd relative to the
                // workspaces root ('.' is the root itself; tasks start there).
                const relative = head.cwd ? path.relative(root, head.cwd) : null
                const fromCwd =
                    relative === null ? null : relative === '' ? '.' : relative.startsWith('..') ? head.cwd : relative
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
