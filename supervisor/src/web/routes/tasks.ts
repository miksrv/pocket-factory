import { Hono } from 'hono'

import type { TaskStatus } from '../../store/index.js'
import type { Env } from '../context.js'

export function taskRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', (c) => {
        const { store } = c.get('app')
        const status = c.req.query('status') as TaskStatus | undefined
        const limit = Number(c.req.query('limit') ?? 100)
        return c.json(store.listTasks({ status, limit }))
    })

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
