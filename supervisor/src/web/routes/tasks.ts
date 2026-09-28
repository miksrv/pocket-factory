import { Hono } from 'hono'

import type { TaskStatus } from '../../store/index.js'
import type { Env } from '../context.js'

export function taskRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** Newest first, `limit` per page; pass `before` = created_at of the last row for the next page. */
    app.get('/', (c) => {
        const { store } = c.get('app')
        const status = c.req.query('status') as TaskStatus | undefined
        const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
        return c.json(store.listTasks({ status, project: c.req.query('project') || undefined, before: c.req.query('before') || undefined, limit }))
    })

    app.get('/projects', (c) => c.json(c.get('app').store.taskProjects()))

    app.get('/:id', (c) => {
        const { store } = c.get('app')
        const task = store.getTask(c.req.param('id'))
        if (!task) return c.json({ error: 'task not found' }, 404)
        return c.json({ ...task, events: store.listEvents(task.id), conversation: store.getConversation(task.conversation_id) })
    })

    app.post('/:id/stop', (c) => {
        const { tasks } = c.get('app')
        return c.json({ stopped: tasks.stop(c.req.param('id')) })
    })

    return app
}
