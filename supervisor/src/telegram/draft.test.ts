import type { Api } from 'grammy'
import { describe, expect, it, vi } from 'vitest'

import type { TaskEvent } from '../store/index.js'
import { draftId, type DraftState, draftText, LiveDraft, toolSummary } from './draft.js'

const state = (patch: Partial<DraftState> = {}): DraftState => ({
    head: '▶️',
    title: 'Fix the login page',
    startedAt: 0,
    waiting: null,
    steps: 0,
    step: null,
    prose: '',
    ...patch
})

describe('toolSummary', () => {
    it('names the command, the file or the pattern, cut to one line', () => {
        expect(toolSummary('Bash', { command: 'yarn test\necho done' })).toBe('Bash: yarn test')
        expect(toolSummary('Read', { file_path: '/src/a.ts' })).toBe('Read: /src/a.ts')
        expect(toolSummary('Agent', { description: 'Review the diff', prompt: '…' })).toBe('Agent: Review the diff')
        expect(toolSummary('Bash', { command: 'x'.repeat(120) })).toBe(`Bash: ${'x'.repeat(90)}…`)
        expect(toolSummary('TodoWrite', { todos: [] })).toBe('TodoWrite')
    })
})

describe('draftText', () => {
    it('shows the head, the steps, the time and the tool under way', () => {
        expect(draftText(state({ steps: 3, step: 'Bash: yarn test' }), 125_000)).toBe(
            '▶️ <b>Fix the login page</b>\n3 steps · 2 min · Bash: yarn test'
        )
        expect(draftText(state({ steps: 1 }), 12_000)).toBe('▶️ <b>Fix the login page</b>\n1 step · 12 s')
    })

    it('tells a wait instead of the steps, and the last prose under it', () => {
        expect(draftText(state({ waiting: 'waiting for a free slot', prose: 'Looking at **it**' }), 1000)).toBe(
            '▶️ <b>Fix the login page</b>\n⏳ waiting for a free slot\n\nLooking at <b>it</b>'
        )
    })

    it('escapes the title and keeps the prose to its tail', () => {
        expect(draftText(state({ title: 'a <b> & c' }), 0)).toContain('<b>a &lt;b&gt; &amp; c</b>')
        const long = 'x'.repeat(2000)
        expect(draftText(state({ prose: long }), 0)).toContain(`…${'x'.repeat(1200)}`)
    })

    it('gives every task a stable non-zero draft id', () => {
        expect(draftId('t1')).toBe(draftId('t1'))
        expect(draftId('t1')).not.toBe(draftId('t2'))
        expect(draftId('t1')).toBeGreaterThan(0)
    })
})

describe('LiveDraft', () => {
    const event = (task_id: string, type: TaskEvent['type'], payload: unknown, agent: string | null = null) =>
        ({ id: 1, task_id, ts: '', type, payload, agent, parent_tool_use_id: null }) as TaskEvent

    it('sends the draft at once, then at most every 1.5 s, and keeps it alive', async () => {
        vi.useFakeTimers()
        const sendMessageDraft = vi.fn().mockResolvedValue(true)
        const draft = new LiveDraft({ sendMessageDraft } as unknown as Api, () => undefined)
        draft.start('t1', 42, state())
        await vi.advanceTimersByTimeAsync(0)
        expect(sendMessageDraft).toHaveBeenCalledTimes(1)
        expect(sendMessageDraft.mock.calls[0][0]).toBe(42)
        expect(sendMessageDraft.mock.calls[0][3]).toMatchObject({ parse_mode: 'HTML', can_stop: true })
        draft.event(event('t1', 'tool_use', { name: 'Bash', input: { command: 'ls' } }))
        draft.event(event('t1', 'tool_use', { name: 'Read', input: { file_path: 'a' } }))
        await vi.advanceTimersByTimeAsync(1000)
        expect(sendMessageDraft).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(600)
        expect(sendMessageDraft).toHaveBeenCalledTimes(2)
        expect(sendMessageDraft.mock.calls[1][2]).toContain('2 steps')
        expect(sendMessageDraft.mock.calls[1][2]).toContain('Read: a')
        // Nothing happens for a while: the keep-alive refreshes it before Telegram drops it.
        await vi.advanceTimersByTimeAsync(20_000)
        expect(sendMessageDraft).toHaveBeenCalledTimes(3)
        draft.end('t1')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(sendMessageDraft).toHaveBeenCalledTimes(3)
        vi.useRealTimers()
    })

    it('counts sub-agents, keeps the orchestrator prose only, and stops the task behind a stopped draft', async () => {
        vi.useFakeTimers()
        const sendMessageDraft = vi.fn().mockResolvedValue(true)
        const stopped: string[] = []
        const draft = new LiveDraft({ sendMessageDraft } as unknown as Api, (id) => stopped.push(id))
        draft.start('t1', 42, state({ waiting: 'waiting for a free slot' }))
        draft.event(event('t1', 'agent', { phase: 'started', description: 'Review' }, 'reviewer'))
        draft.event(event('t1', 'text', { text: 'from a sub-agent' }, 'reviewer'))
        draft.event(event('t1', 'text', { text: 'Done with it.' }))
        await vi.advanceTimersByTimeAsync(2000)
        const text = sendMessageDraft.mock.calls.at(-1)![2] as string
        expect(text).toContain('1 step')
        expect(text).toContain('sub-agent reviewer: Review')
        expect(text).toContain('Done with it.')
        expect(text).not.toContain('from a sub-agent')
        expect(text).not.toContain('waiting')
        draft.stopped(42, draftId('t1'))
        draft.stopped(42, 12345)
        expect(stopped).toEqual(['t1'])
        draft.stop()
        vi.useRealTimers()
    })
})
