import { Hono } from 'hono'

import type { Env } from '../context.js'

export function sessionRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', async (c) => {
        const { transcripts, store } = c.get('app')
        const list = transcripts.list(Number(c.req.query('limit') ?? 100))
        const tasksBySession = new Map(store.listTasks({ limit: 1000 }).map((task) => [task.session_id, task]))
        const withPrompts = await Promise.all(
            list.map(async (entry) => ({
                ...entry,
                first_prompt: await transcripts.firstPrompt(entry.path),
                task_id: tasksBySession.get(entry.session_id)?.id ?? null,
                conversation_id: tasksBySession.get(entry.session_id)?.conversation_id ?? null
            }))
        )
        return c.json(withPrompts)
    })

    app.get('/:id', async (c) => {
        const { transcripts } = c.get('app')
        const summary = transcripts.find(c.req.param('id'))
        if (!summary) return c.json({ error: 'session not found' }, 404)
        return c.json({ ...summary, entries: await transcripts.read(summary.session_id) })
    })

    return app
}
