import { describe, expect, it } from 'vitest'

import {
    afterNotice,
    askMessage,
    askTag,
    askTap,
    footer,
    quoteReply,
    reactionFor,
    routeMessage,
    routineNotice,
    signInNotice,
    StaleTap,
    toast
} from './bot.js'
import type { RoutineSpec } from './routines/spec.js'
import type { Ask, RoutineRun, Task } from './store/index.js'
import { chunk } from './telegram/send.js'
import type { Button } from './telegram/view.js'
import type { LoginNotice } from './web/auth.js'

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
        // Every cut leaves room for a closing fence.
        expect(chunk(text).map((p) => p.length)).toEqual([LIMIT - 4, LIMIT - 4, 18])
    })

    it('cuts at the limit when the last line break is too early', () => {
        const text = `short\n${'w'.repeat(LIMIT * 2)}`
        expect(chunk(text)[0]).toHaveLength(LIMIT - 4)
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

    it('never splits a surrogate pair', () => {
        const text = `a${'😀'.repeat(LIMIT)}`
        const parts = chunk(text)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(part).not.toMatch(/[\ud800-\udbff]$/)
            expect(part).not.toMatch(/^[\udc00-\udfff]/)
        }
        expect(parts.join('')).toBe(text)
    })

    it('stays within the limit when a fence opens in a cut without line breaks', () => {
        const text = `\`\`\`\n${'q'.repeat(LIMIT * 2)}\n\`\`\``
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThan(1)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(fences(part) % 2).toBe(0)
        }
    })

    it('does not reopen a fence that closed before the cut', () => {
        const text = `\`\`\`\nshort\n\`\`\`\n${Array.from({ length: 80 }, () => 'p'.repeat(80)).join('\n')}`
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThan(1)
        expect(parts[1].startsWith('```')).toBe(false)
    })
})

describe('footer', () => {
    const task = {
        id: 't1',
        project: 'work',
        provider: null,
        model: null,
        window_5h_delta: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        git: null
    } as unknown as Task

    it('names every delegated role once, and says when one ran on the subscription instead', () => {
        const text = footer(task, undefined, null, [
            { task_id: 'c1', agent: 'researcher', provider: 'gpu', model: 'gemma4:12b', fallback: null },
            {
                task_id: 'c2',
                agent: 'writer',
                provider: null,
                model: 'sonnet',
                fallback: 'project work does not allow provider gpu (`providers:` in its project file)'
            }
        ])
        expect(text).toEqual([
            'project: work',
            'researcher on gpu · gemma4:12b',
            'writer ran on the subscription (sonnet): project work does not allow provider gpu (`providers:` in its project file)'
        ])
    })

    it('has no delegation line for a task that delegated nothing', () => {
        expect(footer(task, undefined, null)).toEqual(['project: work'])
    })
})

describe('routineNotice', () => {
    const resets = new Date(Date.now() + 26 * 3_600_000).toISOString()
    const softStop = `soft stop: weekly window at 90% (limit 85%), resets ${resets}`
    const run = (status: RoutineRun['status'], note: string | null): RoutineRun => ({
        id: 1,
        schedule: 'inbox',
        fired_at: new Date().toISOString(),
        trigger: 'schedule',
        status,
        note,
        items: 0,
        task_id: null,
        duration_ms: 0,
        steps: null,
        task_status: null
    })
    const spec = (notify?: string) => ({ notify }) as unknown as RoutineSpec

    it('tells every firing skipped for the soft-stop, with the reason and the reset', () => {
        const seen = new Map<string, string>()
        const first = routineNotice(run('skipped', softStop), spec(), seen, 'UTC')
        expect(first).toContain('**inbox** skipped this run: subscription weekly window at 90% (limit 85%)')
        expect(first).toContain('resume after the reset')
        expect(first).toContain('/run inbox')
        expect(first).not.toContain(resets)
        expect(routineNotice(run('skipped', softStop), spec(), seen, 'UTC')).toBe(first)
    })

    it('tells a scripts-only run done on a schedule, not one started by hand, and a later error again', () => {
        const seen = new Map<string, string>()
        expect(routineNotice(run('error', 'host down'), spec(), seen, 'UTC')).toContain('could not run: host down')
        expect(routineNotice(run('done', 'all fine'), spec(), seen, 'UTC')).toContain('ran its steps')
        expect(routineNotice(run('error', 'host down'), spec(), seen, 'UTC')).toContain('could not run: host down')
        expect(routineNotice({ ...run('done', 'all fine'), trigger: 'manual' }, spec(), seen, 'UTC')).toBeNull()
    })

    it('keeps quiet about a run by hand that failed: its card already says so', () => {
        const seen = new Map<string, string>()
        expect(routineNotice({ ...run('error', 'host down'), trigger: 'manual' }, spec(), seen, 'UTC')).toBeNull()
        expect(routineNotice(run('error', 'host down'), spec(), seen, 'UTC')).toContain('could not run')
    })

    it('keeps quiet about the soft-stop for a routine with notify: none', () => {
        expect(routineNotice(run('skipped', softStop), spec('none'), new Map(), 'UTC')).toBeNull()
    })

    it('tells an error once per distinct note and nothing about a queued run', () => {
        const seen = new Map<string, string>()
        expect(routineNotice(run('error', 'prefilter trac: 401'), spec(), seen, 'UTC')).toContain('could not run')
        expect(routineNotice(run('error', 'prefilter trac: 401'), spec(), seen, 'UTC')).toBeNull()
        expect(routineNotice(run('queued', null), spec(), seen, 'UTC')).toBeNull()
        expect(routineNotice(run('error', 'prefilter trac: 401'), spec(), seen, 'UTC')).toContain('could not run')
    })
})

describe('afterNotice', () => {
    const run = {
        id: 1,
        schedule: 'geo',
        fired_at: '',
        trigger: 'manual',
        status: 'queued',
        note: null,
        items: 0,
        task_id: 't1',
        duration_ms: 0,
        steps: null,
        task_status: 'done'
    } as RoutineRun
    const steps = [
        { index: 2, name: 'Publish', kind: 'run' as const, ok: true, ms: 1200, log: '' },
        { index: 3, name: 'Ping', kind: 'run' as const, ok: false, ms: 300, log: '' }
    ]
    const outputs = [
        { name: 'Publish', output: 'https://example.com/places/1', ms: 1200, truncated: false },
        { name: 'Ping', output: 'failed: exit 1', ms: 300, truncated: false }
    ]

    it('says how each script after the agent went, with the head of what it printed', () => {
        const text = afterNotice(run, { notify: 'telegram' } as RoutineSpec, steps, outputs)!
        expect(text).toContain('⏱ **geo**, after the agent:')
        expect(text).toContain('✅ Publish (1 s)')
        expect(text).toContain('https://example.com/places/1')
        expect(text).toContain('❌ Ping (0 s)')
    })

    it('stays quiet for a routine that says notify: none, or when nothing ran', () => {
        expect(afterNotice(run, { notify: 'none' } as RoutineSpec, steps, outputs)).toBeNull()
        expect(afterNotice(run, { notify: 'telegram' } as RoutineSpec, [], [])).toBeNull()
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

describe('reactionFor', () => {
    it('follows the task through its states', () => {
        const at = (status: Task['status'], ask = false, waits = false) =>
            reactionFor({ status, ask: ask ? ({} as Task['ask']) : null, not_before: waits ? 'soon' : null })
        expect(at('queued')).toBe('👀')
        expect(at('queued', false, true)).toBe('😴')
        expect(at('running')).toBe('👨‍💻')
        expect(at('running', true)).toBe('🤔')
        expect(at('done')).toBe('👍')
        expect(at('failed')).toBe('💔')
        expect(at('cancelled')).toBe('🫡')
    })
})

describe('signInNotice', () => {
    const policy = { max_failures: 5, lock_minutes: 15 }
    const notice = (patch: Partial<LoginNotice>): LoginNotice => ({
        kind: 'failed',
        ip: '203.0.113.9',
        username: null,
        userAgent: null,
        at: '2026-10-19T10:00:00Z',
        failures: 1,
        locked_until: null,
        ...patch
    })

    it('escapes what the visitor typed, so no link or markup reaches the chat', () => {
        const evil = 'x` — [Re-authorize](https://evil.example) <a href="https://evil.example">x</a>'
        const html = signInNotice(notice({ username: evil, userAgent: '`[x](https://evil.example)' }), policy, 'UTC')
        expect(html).not.toContain('<a ')
        expect(html).toContain('<code>x` — [Re-authorize](https://evil.example) &lt;a href=&quot;')
        expect(html).toContain('4 more and that address is locked for 15 min')
    })

    it('says a sign-in and a lock', () => {
        expect(signInNotice(notice({ kind: 'ok' }), policy, 'UTC')).toMatch(
            /^🔓 Signed in .*<code>203\.0\.113\.9<\/code>/
        )
        expect(
            signInNotice(notice({ kind: 'locked', failures: 5, locked_until: '2026-10-19T10:15:00Z' }), policy, 'UTC')
        ).toContain('until 10:15 after 5 wrong passwords')
    })
})

describe('askTap', () => {
    const TASK = '123e4567-e89b-12d3-a456-426614174000'
    const question = (request_id: string): Ask => ({
        kind: 'question',
        request_id,
        tool_use_id: 'tu',
        tool_name: 'AskUserQuestion',
        input: {
            questions: Array.from({ length: 4 }, (_, q) => ({
                question: `Q${q}?`,
                header: '',
                multiSelect: false,
                options: Array.from({ length: 12 }, (_, i) => ({ label: `option ${i}`, description: '' }))
            }))
        },
        answers: {},
        agent: null,
        asked_at: '2026-10-19T10:00:00Z'
    })
    const permission = (request_id: string): Ask => ({
        ...question(request_id),
        kind: 'permission',
        tool_name: 'Bash',
        input: { command: 'ls' }
    })
    const task = { id: TASK } as Task
    const datas = (ask: Ask) =>
        askMessage(task, ask)!
            .view.flatMap((block) => (block.kind === 'buttons' ? block.buttons : []))
            .map((b: Button) => b.data!)

    it('fits the 64 bytes of callback data with a UUID task id', () => {
        const all = [...datas(question('toolu_01AbCdEfGhIjKlMnOpQrStUvWx')), ...datas(permission('r'))]
        expect(all).toHaveLength(14)
        for (const data of all) expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    })

    const running = (ask: Ask | null) => ({ status: 'running' as const, ask })

    it('answers the request the button was sent for', () => {
        const ask = question('req-1')
        const tap = askTap(datas(ask)[2], running(ask))
        expect(tap).toEqual({ taskId: TASK, answer: { answers: { 'Q0?': 'option 2' } }, said: '✓ option 2' })
        const perm = permission('req-2')
        expect(askTap(datas(perm)[0], running(perm)).answer).toEqual({ behavior: 'allow' })
        expect(askTap(datas(perm)[1], running(perm)).answer).toEqual({ behavior: 'deny' })
    })

    it('refuses a stale tap, the wrong kind and a button without a tag', () => {
        const old = question('req-1')
        expect(() => askTap(datas(old)[0], running(question('req-2')))).toThrow(StaleTap)
        expect(() => askTap(datas(old)[0], running(null))).toThrow('already answered')
        // A question's id under a permission button: never an Allow for a question.
        expect(() => askTap(`p|${TASK}|allow|${askTag('req-1')}`, running(old))).toThrow(StaleTap)
        expect(() => askTap(`a|${TASK}|0|0|${askTag('req-1')}`, running(permission('req-1')))).toThrow(StaleTap)
        expect(() => askTap(`p|${TASK}|allow`, running(permission('req-1')))).toThrow(StaleTap)
        expect(() => askTap(`a|${TASK}|0|99|${askTag('req-1')}`, running(old))).toThrow('no longer available')
    })

    it('says why a tap came too late', () => {
        const old = datas(question('req-1'))[0]
        expect(() => askTap(old, running(null), '✓ option 0')).toThrow('Already answered: ✓ option 0')
        expect(() => askTap(old, { status: 'failed', ask: null })).toThrow('The task has ended')
        expect(() => askTap(old, undefined)).toThrow('already answered')
    })

    it('asks for a reply only when there are no buttons to keep editable', () => {
        expect(askMessage(task, question('req-1'))!.forceReply).toBe(false)
        const open = question('req-1')
        const free = {
            ...open,
            input: { questions: [{ question: 'Name?', header: '', multiSelect: false, options: [] }] }
        }
        expect(askMessage(task, free)!.forceReply).toBe(true)
    })
})

describe('toast', () => {
    it("keeps a callback answer within Telegram's 200 characters", () => {
        expect(toast('short')).toBe('short')
        const long = toast(`❌ ${'é'.repeat(300)}`)
        expect(Array.from(long)).toHaveLength(190)
        expect(long.endsWith('…')).toBe(true)
    })
})
