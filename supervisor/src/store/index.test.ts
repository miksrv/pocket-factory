import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openDatabase } from './db.js'
import { type Ask, type Conversation, type Cursor, Store, type Task } from './index.js'

const T0 = new Date('2026-10-06T10:00:00.000Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString()

const ASK: Ask = {
    kind: 'question',
    request_id: 'req-1',
    tool_use_id: 'tool-1',
    tool_name: 'AskUserQuestion',
    input: { questions: [{ question: 'Which branch?' }] },
    answers: {},
    agent: null,
    asked_at: T0.toISOString()
}

describe('Store', () => {
    let dir: string
    let db: DatabaseSync
    let store: Store

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-'))
        db = openDatabase(path.join(dir, 'factory.sqlite'))
        store = new Store(db)
    })

    afterEach(() => {
        vi.useRealTimers()
        db.close()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    /** Every page of a keyset-paged list, following the last row's cursor. */
    function pageAll<T extends { id: string }>(
        list: (limit: number, before?: Cursor) => T[],
        ts: (row: T) => string,
        size: number
    ): T[] {
        const rows: T[] = []
        let before: Cursor | undefined
        for (let guard = 0; guard < 100; guard++) {
            const page = list(size, before)
            rows.push(...page)
            if (page.length < size) return rows
            const last = page[page.length - 1]
            before = { ts: ts(last), id: last.id }
        }
        throw new Error('paging did not end')
    }

    describe('conversations', () => {
        it('creates, finds and reads a conversation', () => {
            const created = store.createConversation('telegram', '42', 'Hello', null)
            expect(created).toMatchObject({ channel: 'telegram', external_id: '42', title: 'Hello', session_id: null })
            expect(store.getConversation(created.id)).toEqual(created)
            expect(store.findConversation('telegram', '42')?.id).toBe(created.id)
            expect(store.findConversation('web', '42')).toBeUndefined()
            expect(store.getConversation('missing')).toBeUndefined()
        })

        it('updates the given fields and bumps updated_at', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            const c = store.createConversation('web', null)
            vi.setSystemTime(new Date(at(5)))
            store.updateConversation(c.id, { title: 'Renamed', session_id: 's-1', project: 'demo' })
            expect(store.getConversation(c.id)).toMatchObject({
                title: 'Renamed',
                session_id: 's-1',
                project: 'demo',
                created_at: T0.toISOString(),
                updated_at: at(5)
            })
        })

        it('soft-deletes: hidden from the list and lookups by channel, still readable by id', () => {
            const c = store.createConversation('telegram', '7')
            const other = store.createConversation('web', null)
            store.deleteConversation(c.id)
            expect(store.getConversation(c.id)?.deleted_at).not.toBeNull()
            expect(store.listConversations().map((x) => x.id)).toEqual([other.id])
            expect(store.findConversation('telegram', '7')).toBeUndefined()
        })

        it('lists by newest activity first', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            const a = store.createConversation('web', null, 'a')
            vi.setSystemTime(new Date(at(1)))
            const b = store.createConversation('web', null, 'b')
            vi.setSystemTime(new Date(at(2)))
            store.updateConversation(a.id, { title: 'a2' })
            expect(store.listConversations().map((c) => c.id)).toEqual([a.id, b.id])
        })

        it('reading does not count as activity', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            const c = store.createConversation('web', null)
            vi.setSystemTime(new Date(at(3)))
            store.markConversationRead(c.id)
            expect(store.getConversation(c.id)).toMatchObject({ read_at: at(3), updated_at: T0.toISOString() })
        })

        it.each([1, 2, 3, 7])(
            'pages rows with equal timestamps without skipping or repeating them (page size %i)',
            (size) => {
                vi.useFakeTimers({ toFake: ['Date'] })
                vi.setSystemTime(T0)
                const ids = Array.from({ length: 7 }, () => store.createConversation('web', null).id)
                vi.setSystemTime(new Date(at(1)))
                const newer = store.createConversation('web', null).id
                const rows = pageAll(
                    (limit, before) => store.listConversations(limit, before),
                    (c) => c.updated_at,
                    size
                )
                expect(rows.map((c) => c.id)).toEqual([newer, ...[...ids].sort().reverse()])
            }
        )
    })

    describe('tasks', () => {
        let conversation: Conversation

        beforeEach(() => {
            conversation = store.createConversation('web', null)
        })

        it('creates a queued task with the given fields', () => {
            const task = store.createTask(conversation.id, 'web', 'Do it', 'demo', 'nightly', 'opus', [
                { name: 'a.png', path: '/x/a.png', type: 'image/png', size: 3 }
            ])
            expect(store.getTask(task.id)).toEqual(task)
            expect(task).toMatchObject({
                status: 'queued',
                project: 'demo',
                schedule: 'nightly',
                model: 'opus',
                attachments: [{ name: 'a.png' }],
                ask: null,
                git: null,
                restarts: 0
            })
        })

        it('stores no attachments for an empty list', () => {
            expect(store.createTask(conversation.id, 'web', 'x', null, null, null, []).attachments).toBeNull()
        })

        it('moves queued → running → done and keeps the JSON columns as objects', () => {
            const task = store.createTask(conversation.id, 'web', 'Do it')
            const running = store.updateTask(task.id, { status: 'running', started_at: at(0), ask: ASK })
            expect(running).toMatchObject({ status: 'running', ask: ASK })
            const done = store.updateTask(task.id, {
                status: 'done',
                ask: null,
                result: 'Done.',
                finished_at: at(1),
                input_tokens: 10,
                output_tokens: 5,
                git: { start_head: 'abc' } as Task['git']
            })
            expect(done).toMatchObject({
                status: 'done',
                ask: null,
                result: 'Done.',
                finished_at: at(1),
                git: { start_head: 'abc' }
            })
        })

        it('records a failure with its error', () => {
            const task = store.createTask(conversation.id, 'web', 'Do it')
            store.updateTask(task.id, { status: 'running' })
            expect(store.updateTask(task.id, { status: 'failed', error: 'boom' })).toMatchObject({
                status: 'failed',
                error: 'boom'
            })
        })

        it('an empty patch changes nothing', () => {
            const task = store.createTask(conversation.id, 'web', 'Do it')
            expect(store.updateTask(task.id, {})).toEqual(task)
        })

        it('filters the list by status, conversation and project', () => {
            const other = store.createConversation('web', null)
            const a = store.createTask(conversation.id, 'web', 'a', 'p1')
            const b = store.createTask(other.id, 'web', 'b', 'p2')
            store.updateTask(b.id, { status: 'done' })
            expect(store.listTasks({ status: 'done' }).map((t) => t.id)).toEqual([b.id])
            expect(store.listTasks({ conversationId: conversation.id }).map((t) => t.id)).toEqual([a.id])
            expect(store.listTasks({ project: 'p2' }).map((t) => t.id)).toEqual([b.id])
            expect(store.taskProjects()).toEqual(['p1', 'p2'])
        })

        it.each([1, 2, 4])('pages tasks created in the same millisecond (page size %i)', (size) => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            const ids = Array.from({ length: 5 }, (_, i) => store.createTask(conversation.id, 'web', `t${i}`).id)
            const rows = pageAll(
                (limit, before) => store.listTasks({ limit, before }),
                (t) => t.created_at,
                size
            )
            expect(rows.map((t) => t.id)).toEqual([...ids].sort().reverse())
        })

        describe('nextQueuedTasks', () => {
            it('offers the oldest queued task of each idle conversation, oldest first', () => {
                vi.useFakeTimers({ toFake: ['Date'] })
                const other = store.createConversation('web', null)
                vi.setSystemTime(T0)
                const first = store.createTask(conversation.id, 'web', 'first')
                vi.setSystemTime(new Date(at(1)))
                const elsewhere = store.createTask(other.id, 'web', 'elsewhere')
                vi.setSystemTime(new Date(at(2)))
                store.createTask(conversation.id, 'web', 'second')
                expect(store.nextQueuedTasks(new Date(at(3))).map((t) => t.id)).toEqual([first.id, elsewhere.id])
            })

            it('skips a conversation with a running task', () => {
                const running = store.createTask(conversation.id, 'web', 'running')
                store.updateTask(running.id, { status: 'running' })
                store.createTask(conversation.id, 'web', 'waiting')
                expect(store.nextQueuedTasks()).toEqual([])
            })

            it('holds back a conversation whose oldest task waits for a window reset', () => {
                vi.useFakeTimers({ toFake: ['Date'] })
                vi.setSystemTime(T0)
                const waiting = store.createTask(conversation.id, 'web', 'waiting')
                store.updateTask(waiting.id, { not_before: at(30) })
                vi.setSystemTime(new Date(at(1)))
                store.createTask(conversation.id, 'web', 'later')
                expect(store.nextQueuedTasks(new Date(at(10)))).toEqual([])
                expect(store.nextQueuedTasks(new Date(at(30))).map((t) => t.id)).toEqual([waiting.id])
            })
        })

        it('re-queues orphaned running tasks under the restart limit and fails the rest', () => {
            const fresh = store.createTask(conversation.id, 'web', 'fresh')
            store.updateTask(fresh.id, { status: 'running', started_at: at(0), ask: ASK })
            const other = store.createConversation('web', null)
            const tired = store.createTask(other.id, 'web', 'tired')
            store.updateTask(tired.id, { status: 'running', restarts: 1 })
            const { requeued, failed } = store.recoverOrphanedTasks(1)
            expect(requeued.map((t) => t.id)).toEqual([fresh.id])
            expect(store.getTask(fresh.id)).toMatchObject({
                status: 'queued',
                restarts: 1,
                started_at: null,
                ask: null
            })
            expect(failed.map((t) => t.id)).toEqual([tired.id])
            expect(store.getTask(tired.id)).toMatchObject({ status: 'failed', ask: null })
            expect(store.getTask(tired.id)?.error).toMatch(/restarted/)
        })
    })

    describe('computed conversation flags', () => {
        let c: Conversation

        beforeEach(() => {
            c = store.createConversation('web', null, 'Thread')
        })

        const flags = () => {
            const { unread, needs_reply, active } = store.getConversation(c.id)!
            return { unread, needs_reply, active }
        }

        it('starts with no flags', () => {
            expect(flags()).toEqual({ unread: false, needs_reply: false, active: false })
        })

        it('is active while a task is queued or running', () => {
            const task = store.createTask(c.id, 'web', 'x')
            expect(flags()).toEqual({ unread: false, needs_reply: false, active: true })
            store.updateTask(task.id, { status: 'running' })
            expect(flags().active).toBe(true)
            store.updateTask(task.id, { status: 'cancelled', finished_at: at(1) })
            expect(flags()).toEqual({ unread: false, needs_reply: false, active: false })
        })

        it('needs a reply while a running task asks', () => {
            const task = store.createTask(c.id, 'web', 'x')
            store.updateTask(task.id, { status: 'running', ask: ASK })
            expect(flags()).toEqual({ unread: false, needs_reply: true, active: true })
            store.updateTask(task.id, { ask: null })
            expect(flags().needs_reply).toBe(false)
        })

        it.each(['done', 'failed'] as const)(
            'is unread after a task ends %s, until the conversation is read',
            (status) => {
                vi.useFakeTimers({ toFake: ['Date'] })
                vi.setSystemTime(T0)
                const task = store.createTask(c.id, 'web', 'x')
                store.updateTask(task.id, { status, finished_at: at(1) })
                expect(flags().unread).toBe(true)
                vi.setSystemTime(new Date(at(2)))
                store.markConversationRead(c.id)
                expect(flags().unread).toBe(false)
                // A later reply lights it again.
                const next = store.createTask(c.id, 'web', 'y')
                store.updateTask(next.id, { status: 'done', finished_at: at(3) })
                expect(flags().unread).toBe(true)
            }
        )

        it('counts the flags in stats, without deleted conversations', () => {
            const unread = store.createTask(c.id, 'web', 'x')
            store.updateTask(unread.id, {
                status: 'done',
                finished_at: at(1),
                input_tokens: 100,
                cache_read_tokens: 50
            })
            const asking = store.createConversation('web', null, 'Asking')
            const ask = store.createTask(asking.id, 'web', 'q')
            store.updateTask(ask.id, { status: 'running', ask: ASK })
            const gone = store.createConversation('web', null)
            store.createTask(gone.id, 'web', 'queued')
            store.deleteConversation(gone.id)

            const stats = store.stats(T0.toISOString())
            expect(stats).toMatchObject({
                queued: 1,
                running: 1,
                done_today: 1,
                failed_today: 0,
                chat_unread: 1,
                chat_needs_reply: 1,
                chat_active: 1,
                chat_unread_latest: { id: c.id, title: 'Thread' },
                chat_needs_reply_latest: { id: asking.id, title: 'Asking' },
                tokens_total: 150
            })
        })

        it('reports zeros on an empty store', () => {
            store.deleteConversation(c.id)
            expect(store.stats(T0.toISOString())).toEqual({
                queued: 0,
                running: 0,
                done_today: 0,
                failed_today: 0,
                tokens_today: 0,
                tokens_total: 0,
                chat_unread: 0,
                chat_needs_reply: 0,
                chat_active: 0,
                chat_unread_latest: null,
                chat_needs_reply_latest: null
            })
        })
    })

    describe('task events', () => {
        it('lists a task’s events after an id, oldest first, with their origin', () => {
            const c = store.createConversation('web', null)
            const task = store.createTask(c.id, 'web', 'x')
            const first = store.addEvent(task.id, 'text', { text: 'hi' })
            const second = store.addEvent(
                task.id,
                'tool_use',
                { name: 'Read' },
                { agent: 'Explore', parent_tool_use_id: 'tu-1' }
            )
            expect(store.listEvents(task.id).map((e) => e.id)).toEqual([first.id, second.id])
            expect(store.listEvents(task.id, first.id)).toEqual([
                expect.objectContaining({
                    id: second.id,
                    type: 'tool_use',
                    payload: { name: 'Read' },
                    agent: 'Explore',
                    parent_tool_use_id: 'tu-1'
                })
            ])
            expect(store.listEvents(task.id, second.id)).toEqual([])
        })

        it('lists a conversation’s events across its tasks only', () => {
            const c = store.createConversation('web', null)
            const other = store.createConversation('web', null)
            const t1 = store.createTask(c.id, 'web', '1')
            const t2 = store.createTask(c.id, 'web', '2')
            const foreign = store.createTask(other.id, 'web', 'x')
            const e1 = store.addEvent(t1.id, 'text', 1)
            store.addEvent(foreign.id, 'text', 'x')
            const e2 = store.addEvent(t2.id, 'text', 2)
            expect(store.listConversationEvents(c.id).map((e) => e.id)).toEqual([e1.id, e2.id])
            expect(store.listConversationEvents(c.id, e1.id).map((e) => e.id)).toEqual([e2.id])
            expect(store.listEventsOfTasks([t2.id, t1.id]).map((e) => e.id)).toEqual([e1.id, e2.id])
            expect(store.listEventsOfTasks([])).toEqual([])
        })

        it('lists the open tasks of a conversation, oldest first', () => {
            const c = store.createConversation('web', null)
            const done = store.createTask(c.id, 'web', 'done')
            store.updateTask(done.id, { status: 'done' })
            const open = store.createTask(c.id, 'web', 'open')
            expect(store.openTasks(c.id).map((t) => t.id)).toEqual([open.id])
        })
    })

    describe('web sessions', () => {
        it('creates, reads, touches and deletes a session', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            const session = store.createWebSession('h1', at(60), '192.0.2.1', 'ua')
            expect(store.getWebSession('h1')).toEqual(session)
            vi.setSystemTime(new Date(at(10)))
            store.touchWebSession('h1', at(120), null)
            expect(store.getWebSession('h1')).toMatchObject({
                last_seen_at: at(10),
                expires_at: at(120),
                ip: '192.0.2.1'
            })
            store.touchWebSession('h1', at(120), '192.0.2.9')
            expect(store.getWebSession('h1')?.ip).toBe('192.0.2.9')
            expect(store.deleteWebSession('h1')).toBe(true)
            expect(store.deleteWebSession('h1')).toBe(false)
            expect(store.getWebSession('h1')).toBeUndefined()
        })

        it('treats an expired session as gone and purges it', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            store.createWebSession('old', at(1), null, null)
            store.createWebSession('live', at(100), null, null)
            vi.setSystemTime(new Date(at(2)))
            expect(store.getWebSession('old')).toBeUndefined()
            expect(store.listWebSessions().map((s) => s.id)).toEqual(['live'])
            expect(store.purgeWebSessions()).toBe(1)
            expect(store.purgeWebSessions()).toBe(0)
        })

        it('lists the most recently used first', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            store.createWebSession('a', at(100), null, null)
            vi.setSystemTime(new Date(at(1)))
            store.createWebSession('b', at(100), null, null)
            vi.setSystemTime(new Date(at(2)))
            store.touchWebSession('a', at(100), null)
            expect(store.listWebSessions().map((s) => s.id)).toEqual(['a', 'b'])
        })

        it('signs out everywhere, or everywhere but one', () => {
            for (const id of ['a', 'b', 'c']) store.createWebSession(id, at(100_000), null, null)
            expect(store.deleteWebSessions('b')).toBe(2)
            expect(store.listWebSessions().map((s) => s.id)).toEqual(['b'])
            expect(store.deleteWebSessions()).toBe(1)
            expect(store.listWebSessions()).toEqual([])
        })
    })

    describe('login attempts', () => {
        it('counts failures since a time, per address or from anywhere', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            store.addLoginAttempt('192.0.2.1', 'factory', 'failed', null)
            vi.setSystemTime(new Date(at(5)))
            store.addLoginAttempt('192.0.2.1', 'factory', 'failed', null)
            store.addLoginAttempt('192.0.2.1', 'factory', 'locked', null)
            store.addLoginAttempt('192.0.2.1', 'factory', 'ok', null)
            vi.setSystemTime(new Date(at(6)))
            store.addLoginAttempt('192.0.2.2', null, 'failed', 'ua')

            expect(store.loginFailures('192.0.2.1', at(-1))).toEqual({ count: 2, last: at(5) })
            expect(store.loginFailures('192.0.2.1', at(0))).toEqual({ count: 1, last: at(5) })
            expect(store.loginFailures(null, at(-1))).toEqual({ count: 3, last: at(6) })
            expect(store.loginFailures('203.0.113.1', at(-1))).toEqual({ count: 0, last: null })
        })

        it('lists newest first and purges old rows', () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(T0)
            const old = store.addLoginAttempt('192.0.2.1', 'a', 'failed', null)
            vi.setSystemTime(new Date(at(1)))
            const recent = store.addLoginAttempt('192.0.2.1', 'b', 'ok', 'ua')
            expect(store.listLoginAttempts()).toEqual([recent, old])
            expect(store.listLoginAttempts(1)).toEqual([recent])
            expect(store.purgeLoginAttempts(at(1))).toBe(1)
            expect(store.listLoginAttempts()).toEqual([recent])
        })
    })
})
