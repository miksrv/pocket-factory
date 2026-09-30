import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import type { Conversation, Task, TaskEvent } from '../../store/index.js'
import type { Env } from '../context.js'
import { cursorOf } from './cursor.js'

/** Absent, null or a string: what an optional text field of a request body may be. */
const isOptionalString = (v: unknown): v is string | null | undefined => v === undefined || v === null || typeof v === 'string'

export function conversationRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** Newest activity first; `before` + `before_id` = the last row shown, for the next page. */
    app.get('/', (c) => {
        const { store } = c.get('app')
        return c.json(store.listConversations(Math.min(Number(c.req.query('limit')) || 50, 200), cursorOf(c)))
    })

    /** A conversation the Chat page may show; a deleted one is gone for the API too, not only for the list. */
    const live = (c: { get: (key: 'app') => Env['Variables']['app']; req: { param: (name: 'id') => string } }): Conversation | undefined => {
        const conversation = c.get('app').store.getConversation(c.req.param('id'))
        return conversation && !conversation.deleted_at ? conversation : undefined
    }

    /** `project` binds the conversation to a checkout from the start: its tasks run there. */
    app.post('/', async (c) => {
        const { tasks } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; project?: unknown }
        if (!isOptionalString(body.title) || !isOptionalString(body.project)) return c.json({ error: 'title and project must be strings' }, 400)
        const project = body.project?.trim() || null
        if (project && !tasks.hasProject(project)) return c.json({ error: `unknown project "${project}" or its checkout is missing` }, 400)
        return c.json(tasks.newConversation('web', null, body.title ?? null, project), 201)
    })

    /** Change the project of a conversation (null unbinds); refused while a task runs. The session starts afresh in the new cwd. */
    app.patch('/:id', async (c) => {
        const { tasks } = c.get('app')
        const conversation = live(c)
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const body = (await c.req.json().catch(() => ({}))) as { project?: unknown }
        if (!isOptionalString(body.project)) return c.json({ error: 'project must be a string or null' }, 400)
        try {
            return c.json(tasks.setProject(conversation.id, body.project?.trim() || null))
        } catch (error) {
            return c.json({ error: (error as Error).message }, 409)
        }
    })

    const PAGE = 20

    /**
     * The conversation with its most recent tasks and their events, oldest
     * first. `has_more` says whether /history has earlier tasks.
     */
    app.get('/:id', (c) => {
        const { store } = c.get('app')
        const conversation = live(c)
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

    /** Earlier tasks of a conversation (with events), oldest first; `before` (+ `before_id`) = the oldest task shown. */
    app.get('/:id/history', (c) => {
        const { store } = c.get('app')
        const conversation = live(c)
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const page = store.listTasks({ conversationId: conversation.id, before: cursorOf(c), limit: PAGE + 1 })
        const tasks = page.slice(0, PAGE).reverse()
        return c.json({ tasks, events: store.listEventsOfTasks(tasks.map((t) => t.id)), has_more: page.length > PAGE })
    })

    /** The owner has the conversation on screen: clears its `unread` flag (the Chat list, the sidebar badge). */
    app.post('/:id/read', (c) => {
        const { store } = c.get('app')
        const conversation = live(c)
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        store.markConversationRead(conversation.id)
        return c.body(null, 204)
    })

    /** Remove from the Chat list. Refused while a task of it is queued or running. */
    app.delete('/:id', (c) => {
        const { tasks, store } = c.get('app')
        const conversation = live(c)
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        if (tasks.activeTask(conversation.id) || store.listTasks({ conversationId: conversation.id, status: 'queued', limit: 1 }).length) {
            return c.json({ error: 'a task of this conversation is still queued or running; stop it first' }, 409)
        }
        store.deleteConversation(conversation.id)
        return c.body(null, 204)
    })

    app.post('/:id/messages', async (c) => {
        const { tasks } = c.get('app')
        const conversation = live(c)
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const body = (await c.req.json().catch(() => ({}))) as { prompt?: string }
        const prompt = body.prompt?.trim()
        if (!prompt) return c.json({ error: 'prompt is required' }, 400)
        return c.json(tasks.submit(conversation.id, 'web', prompt), 201)
    })

    /**
     * Live feed: task status changes and streamed output for one conversation.
     * Subscribes first and buffers, then replays what the client missed from
     * the store, then flushes the buffer: nothing emitted during the replay
     * is lost. The open tasks are sent too, so a client that connected after
     * a status change (or reconnected) does not show a finished task as running.
     */
    app.get('/:id/stream', (c) => {
        const { tasks, store } = c.get('app')
        const conversation = live(c)
        if (!conversation) return c.json({ error: 'conversation not found' }, 404)
        const after = Number(c.req.query('after')) || 0

        return streamSSE(c, async (stream) => {
            const send = (event: string, data: unknown) =>
                stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined)

            let replaying = true
            let lastSent = after
            const buffered: Array<['task', Task] | ['event', TaskEvent]> = []
            const onTask = (task: Task) => {
                if (task.conversation_id !== conversation.id) return
                if (replaying) buffered.push(['task', task])
                else void send('task', task)
            }
            const onEvent = (event: TaskEvent) => {
                const task = store.getTask(event.task_id)
                if (task?.conversation_id !== conversation.id) return
                if (replaying) buffered.push(['event', event])
                else if (event.id > lastSent) {
                    lastSent = event.id
                    void send('event', event)
                }
            }
            tasks.on('task', onTask)
            tasks.on('event', onEvent)
            const unsubscribe = () => {
                tasks.off('task', onTask)
                tasks.off('event', onEvent)
            }
            stream.onAbort(unsubscribe)

            for (const task of store.openTasks(conversation.id)) await send('task', task)
            for (const event of store.listConversationEvents(conversation.id, after)) {
                lastSent = event.id
                await send('event', event)
            }
            replaying = false
            for (const [kind, data] of buffered) {
                if (kind === 'event') {
                    if (data.id <= lastSent) continue
                    lastSent = data.id
                }
                await send(kind, data)
            }
            buffered.length = 0

            while (!stream.aborted) {
                await send('ping', Date.now())
                await stream.sleep(15_000)
            }
            unsubscribe()
        })
    })

    return app
}
