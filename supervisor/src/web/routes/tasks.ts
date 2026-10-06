import { Hono } from 'hono'

import type { TaskStatus } from '../../store/index.js'
import type { Env } from '../context.js'
import { cursorOf } from './cursor.js'

export function taskRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** Newest first, `limit` per page; pass `before` + `before_id` = the last row shown for the next page. */
    app.get('/', (c) => {
        const { store } = c.get('app')
        const status = c.req.query('status') as TaskStatus | undefined
        const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
        return c.json(store.listTasks({ status, project: c.req.query('project') || undefined, before: cursorOf(c), limit }))
    })

    app.get('/projects', (c) => c.json(c.get('app').store.taskProjects()))

    app.get('/:id', (c) => {
        const { store } = c.get('app')
        const task = store.getTask(c.req.param('id'))
        if (!task) return c.json({ error: 'task not found' }, 404)
        return c.json({ ...task, events: store.listEvents(task.id), conversation: store.getConversation(task.conversation_id) })
    })

    /**
     * The owner's answer to what a running task asked (`task.ask`): for a
     * question `{ answers: { "<question>": "<label or free text>" } }` (any
     * subset), for a permission `{ behavior: 'allow' | 'deny', message? }`.
     */
    app.post('/:id/answer', async (c) => {
        const { tasks } = c.get('app')
        const body = (await c.req.json().catch(() => null)) as { answers?: unknown; behavior?: unknown; message?: unknown } | null
        if (!body || typeof body !== 'object') return c.json({ error: 'a JSON body is required' }, 400)
        try {
            if (body.answers !== undefined) {
                if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) return c.json({ error: 'answers must be an object' }, 400)
                const answers = Object.fromEntries(Object.entries(body.answers as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
                return c.json(tasks.answer(c.req.param('id'), { answers }))
            }
            if (body.behavior === 'allow') return c.json(tasks.answer(c.req.param('id'), { behavior: 'allow' }))
            if (body.behavior === 'deny') return c.json(tasks.answer(c.req.param('id'), { behavior: 'deny', message: typeof body.message === 'string' ? body.message : undefined }))
            return c.json({ error: 'answers, or behavior allow / deny, is required' }, 400)
        } catch (error) {
            return c.json({ error: (error as Error).message }, 409)
        }
    })

    /** What the task changed in its checkout: the range, the files (live from git) and the branch's pull request. */
    app.get('/:id/changes', async (c) => {
        try {
            return c.json(await c.get('app').tasks.changes(c.req.param('id')))
        } catch (error) {
            return c.json({ error: (error as Error).message }, 409)
        }
    })

    /** The diff of one file of the task's changes: `?path=`. */
    app.get('/:id/changes/file', async (c) => {
        const file = c.req.query('path')
        if (!file) return c.json({ error: 'path is required' }, 400)
        try {
            return c.json(await c.get('app').tasks.changePatch(c.req.param('id'), file))
        } catch (error) {
            return c.json({ error: (error as Error).message }, 409)
        }
    })

    /** Push the task's branch and open a pull request against the default branch. */
    app.post('/:id/pr', async (c) => {
        try {
            return c.json(await c.get('app').tasks.createPr(c.req.param('id')))
        } catch (error) {
            return c.json({ error: (error as Error).message }, 409)
        }
    })

    app.post('/:id/stop', (c) => {
        const { tasks } = c.get('app')
        return c.json({ stopped: tasks.stop(c.req.param('id')) })
    })

    return app
}
