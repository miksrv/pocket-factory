import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Ask, Conversation, Task } from '../store/index.js'
import { type WebNotice, WebNotifier } from './webNotify.js'

const MIN = 60_000

const ask = (request_id: string): Ask =>
    ({ kind: 'question', request_id, tool_name: 'AskUserQuestion', input: {}, answers: {} }) as unknown as Ask

describe('WebNotifier', () => {
    let tasks: Map<string, Task>
    let conversation: Conversation
    let told: Array<[WebNotice, string]>
    let notifier: WebNotifier

    const update = (patch: Partial<Task>, id = 't1'): Task => {
        const task = { ...tasks.get(id)!, ...patch }
        tasks.set(id, task)
        notifier.onTask(task)
        return task
    }
    const finish = (status: 'done' | 'failed' = 'done') =>
        update({ status, ask: null, finished_at: new Date().toISOString() })

    beforeEach(() => {
        vi.useFakeTimers({ now: new Date('2026-10-06T10:00:00Z') })
        conversation = { id: 'c1', channel: 'web', read_at: null, deleted_at: null } as unknown as Conversation
        tasks = new Map([
            ['t1', { id: 't1', conversation_id: 'c1', source: 'web', status: 'running', ask: null, finished_at: null }]
        ] as Array<[string, Task]>)
        told = []
        notifier = new WebNotifier({
            afterMs: 2 * MIN,
            task: (id) => tasks.get(id),
            conversation: () => conversation,
            notify: (kind, task) => told.push([kind, task.id])
        })
    })
    afterEach(() => {
        notifier.stop()
        vi.useRealTimers()
    })

    it('tells about a reply nobody opened in the web, once', () => {
        finish()
        vi.advanceTimersByTime(2 * MIN - 1)
        expect(told).toEqual([])
        vi.advanceTimersByTime(1)
        expect(told).toEqual([['reply', 't1']])
        update({})
        vi.advanceTimersByTime(5 * MIN)
        expect(told).toHaveLength(1)
    })

    it('keeps quiet when the web marked the reply read', () => {
        finish()
        vi.advanceTimersByTime(MIN)
        conversation = { ...conversation, read_at: new Date().toISOString() }
        vi.advanceTimersByTime(MIN)
        expect(told).toEqual([])
    })

    it('tells about a failed task, never about a cancelled one or a deleted thread', () => {
        finish('failed')
        vi.advanceTimersByTime(2 * MIN)
        expect(told).toEqual([['reply', 't1']])

        tasks.set('t2', { ...tasks.get('t1')!, id: 't2', status: 'running', finished_at: null })
        update({ status: 'cancelled', finished_at: new Date().toISOString() }, 't2')
        vi.advanceTimersByTime(2 * MIN)
        expect(told).toHaveLength(1)

        tasks.set('t3', { ...tasks.get('t1')!, id: 't3', status: 'running', finished_at: null })
        update({ status: 'done', finished_at: new Date().toISOString() }, 't3')
        conversation = { ...conversation, deleted_at: new Date().toISOString() }
        vi.advanceTimersByTime(2 * MIN)
        expect(told).toHaveLength(1)
    })

    it('ignores tasks from Telegram and schedules, which have their own delivery', () => {
        update({ source: 'telegram' })
        finish()
        vi.advanceTimersByTime(5 * MIN)
        expect(told).toEqual([])
    })

    it('tells about an unanswered question, then sends the reply at once', () => {
        update({ ask: ask('r1') })
        vi.advanceTimersByTime(2 * MIN)
        expect(told).toEqual([['ask', 't1']])
        expect(notifier.isEscalated('t1')).toBe(true)
        finish()
        vi.advanceTimersByTime(0)
        expect(told).toEqual([
            ['ask', 't1'],
            ['reply', 't1']
        ])
    })

    it('keeps quiet about a question answered in the web in time', () => {
        update({ ask: ask('r1') })
        vi.advanceTimersByTime(MIN)
        update({ ask: null })
        vi.advanceTimersByTime(MIN)
        expect(told).toEqual([])
        expect(notifier.isEscalated('t1')).toBe(false)
    })

    it('is off with a zero delay', () => {
        notifier = new WebNotifier({
            afterMs: 0,
            task: (id) => tasks.get(id),
            conversation: () => conversation,
            notify: (kind, task) => told.push([kind, task.id])
        })
        update({ ask: ask('r1') })
        finish()
        vi.advanceTimersByTime(10 * MIN)
        expect(told).toEqual([])
    })
})
