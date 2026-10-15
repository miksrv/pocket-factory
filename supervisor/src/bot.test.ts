import { describe, expect, it } from 'vitest'

import { chunk, quoteReply, routeMessage, scheduleNotice } from './bot.js'
import type { ScheduleSpec } from './schedules/spec.js'
import type { ScheduleRun } from './store/index.js'

const LIMIT = 4000

const fences = (part: string) => part.split('\n').filter((l) => /^\s*```/.test(l)).length

describe('chunk', () => {
    it('keeps a short text whole', () => {
        expect(chunk('hello')).toEqual(['hello'])
        expect(chunk('')).toEqual([''])
        expect(chunk('x'.repeat(LIMIT))).toEqual(['x'.repeat(LIMIT)])
    })

    it('cuts on a line break and drops the leading whitespace of the next part', () => {
        const line = 'y'.repeat(99)
        const text = Array.from({ length: 60 }, () => line).join('\n')
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThan(1)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(part.startsWith('\n')).toBe(false)
        }
        expect(parts.join('\n')).toBe(text)
    })

    it('cuts a text without line breaks at the limit', () => {
        const text = 'z'.repeat(LIMIT * 2 + 10)
        expect(chunk(text).map((p) => p.length)).toEqual([LIMIT, LIMIT, 10])
    })

    it('cuts at the limit when the last line break is too early', () => {
        const text = `short\n${'w'.repeat(LIMIT * 2)}`
        expect(chunk(text)[0]).toHaveLength(LIMIT)
    })

    it('closes and reopens a code fence that straddles a cut, keeping its language', () => {
        const code = Array.from({ length: 120 }, (_, i) => `const line${i} = ${'0'.repeat(50)}`).join('\n')
        const text = `Intro\n\`\`\`ts\n${code}\n\`\`\`\nOutro`
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThanOrEqual(2)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(fences(part) % 2).toBe(0)
        }
        expect(parts[0].endsWith('\n```')).toBe(true)
        expect(parts[1].startsWith('```ts\n')).toBe(true)
        expect(parts.at(-1)!.endsWith('```\nOutro')).toBe(true)
    })

    it('keeps the fences balanced across three or more parts', () => {
        const code = Array.from({ length: 400 }, (_, i) => `line ${i} ${'.'.repeat(40)}`).join('\n')
        const parts = chunk(`\`\`\`python\n${code}\n\`\`\``)
        expect(parts.length).toBeGreaterThanOrEqual(3)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(fences(part) % 2).toBe(0)
        }
        expect(parts.slice(1).every((part) => part.startsWith('```python\n'))).toBe(true)
    })

    it('does not reopen a fence that closed before the cut', () => {
        const text = `\`\`\`\nshort\n\`\`\`\n${Array.from({ length: 80 }, () => 'p'.repeat(80)).join('\n')}`
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThan(1)
        expect(parts[1].startsWith('```')).toBe(false)
    })
})

describe('scheduleNotice', () => {
    const resets = new Date(Date.now() + 26 * 3_600_000).toISOString()
    const softStop = `soft stop: weekly window at 90% (limit 85%), resets ${resets}`
    const run = (status: ScheduleRun['status'], note: string | null): ScheduleRun => ({
        id: 1,
        schedule: 'inbox',
        fired_at: new Date().toISOString(),
        trigger: 'cron',
        status,
        note,
        items: 0,
        task_id: null,
        duration_ms: 0,
        task_status: null
    })
    const spec = (notify?: string) => ({ notify }) as unknown as ScheduleSpec

    it('tells every firing skipped for the soft-stop, with the reason and the reset', () => {
        const seen = new Map<string, string>()
        const first = scheduleNotice(run('skipped', softStop), spec(), seen, 'UTC')
        expect(first).toContain('**inbox** skipped this run: subscription weekly window at 90% (limit 85%)')
        expect(first).toContain('resume after the reset')
        expect(first).toContain('/run inbox')
        expect(first).not.toContain(resets)
        expect(scheduleNotice(run('skipped', softStop), spec(), seen, 'UTC')).toBe(first)
    })

    it('keeps quiet about the soft-stop for a schedule with notify: none', () => {
        expect(scheduleNotice(run('skipped', softStop), spec('none'), new Map(), 'UTC')).toBeNull()
    })

    it('tells an error once per distinct note and nothing about a queued run', () => {
        const seen = new Map<string, string>()
        expect(scheduleNotice(run('error', 'prefilter trac: 401'), spec(), seen, 'UTC')).toContain('could not run')
        expect(scheduleNotice(run('error', 'prefilter trac: 401'), spec(), seen, 'UTC')).toBeNull()
        expect(scheduleNotice(run('queued', null), spec(), seen, 'UTC')).toBeNull()
        expect(scheduleNotice(run('error', 'prefilter trac: 401'), spec(), seen, 'UTC')).toContain('could not run')
    })
})

describe('routeMessage', () => {
    const plain = { replied: false, topicAsks: false, topicEmpty: false }

    it('starts a new chat for every plain message in fresh mode', () => {
        expect(routeMessage({ mode: 'fresh', ...plain })).toBe('fresh')
    })

    it('stays in the topic in thread mode', () => {
        expect(routeMessage({ mode: 'thread', ...plain })).toBe('topic')
    })

    it('continues the chat a reply answers, in both modes', () => {
        expect(routeMessage({ mode: 'fresh', ...plain, replied: true })).toBe('replied')
        expect(routeMessage({ mode: 'thread', ...plain, replied: true })).toBe('replied')
    })

    it('hands a plain message to the question the topic waits on', () => {
        expect(routeMessage({ mode: 'fresh', ...plain, topicAsks: true })).toBe('topic')
    })

    it('fills the empty chat /new made instead of opening another one', () => {
        expect(routeMessage({ mode: 'fresh', ...plain, topicEmpty: true })).toBe('topic')
    })
})

describe('quoteReply', () => {
    it('quotes every line of the message replied to', () => {
        expect(quoteReply('Article ready\nhttps://geometki.com/places/1')).toBe(
            'In reply to this earlier message (its chat is gone):\n> Article ready\n> https://geometki.com/places/1'
        )
    })

    it('has nothing to quote for a message without text', () => {
        expect(quoteReply(undefined)).toBeNull()
        expect(quoteReply('  ')).toBeNull()
    })

    it('cuts a long message', () => {
        expect(quoteReply('x'.repeat(5000))!.length).toBeLessThan(3100)
    })
})
