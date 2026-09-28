import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import type { Task, TaskEvent } from '../../store/index.js'
import type { Env } from '../context.js'

export function conversationRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** Newest activity first; `before` = updated_at of the last row for the next page. */
    app.get('/', (c) => {
        const { store } = c.get('app')
        return c.json(store.listConversations(Math.min(Number(c.req.query('limit')) || 50, 200), c.req.query('before') || undefined))
    })

    app.post('/', async (c) => {
        const { tasks } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as { title?: string }
        return c.json(tasks.newConversation('web', null, body.title ?? null), 201)
    })

    const PAGE = 20

    /**
     * The conversation with its most recent tasks and their events, oldest
     * first. `has_more` says whether /history has earlier tasks.
     */
    app.get('/:id', (c) => {
        const { store } = c.get('app')
        const conversation = store.getConversation(c.req.param('id'))
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const page = store.listTasks({ conversationId: conversation.id, limit: PAGE + 1 })
        const tasks = page.slice(0, PAGE).reverse()
        return c.json({
            ...conversation,
            tasks,
            events: store.listEventsOfTasks(tasks.map((t) => t.id)),
            has_more: page.length > PAGE
        })
    })

    /** Earlier tasks of a conversation (with events), oldest first; `before` = created_at of the oldest task shown. */
    app.get('/:id/history', (c) => {
        const { store } = c.get('app')
        const conversation = store.getConversation(c.req.param('id'))
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const page = store.listTasks({ conversationId: conversation.id, before: c.req.query('before') || undefined, limit: PAGE + 1 })
        const tasks = page.slice(0, PAGE).reverse()
        return c.json({ tasks, events: store.listEventsOfTasks(tasks.map((t) => t.id)), has_more: page.length > PAGE })
    })

    /** Remove from the Chat list. Refused while a task of it is queued or running. */
    app.delete('/:id', (c) => {
        const { tasks, store } = c.get('app')
        const conversation = store.getConversation(c.req.param('id'))
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        if (tasks.activeTask(conversation.id) || store.listTasks({ conversationId: conversation.id, status: 'queued', limit: 1 }).length) {
            return c.json({ error: 'a task of this conversation is still queued or running; stop it first' }, 409)
        }
        store.deleteConversation(conversation.id)
        return c.body(null, 204)
    })

    app.post('/:id/messages', async (c) => {
        const { tasks, store } = c.get('app')
        const conversation = store.getConversation(c.req.param('id'))
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const body = (await c.req.json()) as { prompt?: string }
        const prompt = body.prompt?.trim()
        if (!prompt) return c.json({ error: 'prompt is required' }, 400)
        return c.json(tasks.submit(conversation.id, 'web', prompt), 201)
    })

    /** Live feed: task status changes and streamed output for one conversation. */
    app.get('/:id/stream', (c) => {
        const { tasks, store } = c.get('app')
        const conversation = store.getConversation(c.req.param('id'))
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const after = Number(c.req.query('after') ?? 0)

        return streamSSE(c, async (stream) => {
            let open = true
            const send = (event: string, data: unknown) =>
                stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined)

            // Replay what the client missed, then follow live.
            for (const event of store.listConversationEvents(conversation.id, after)) await send('event', event)

            const onTask = (task: Task) => {
                if (task.conversation_id === conversation.id) void send('task', task)
            }
            const onEvent = (event: TaskEvent) => {
                const task = store.getTask(event.task_id)
                if (task?.conversation_id === conversation.id) void send('event', event)
            }
            tasks.on('task', onTask)
            tasks.on('event', onEvent)
            stream.onAbort(() => {
                open = false
                tasks.off('task', onTask)
                tasks.off('event', onEvent)
            })
            while (open) {
                await send('ping', Date.now())
                await stream.sleep(15_000)
            }
        })
    })

    return app
}
