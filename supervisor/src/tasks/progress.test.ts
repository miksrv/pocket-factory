import { afterEach, describe, expect, it } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'

/**
 * A `claude` that answers one model call, then works for a while before the
 * result: what a long task looks like from the outside.
 */
const SLOW_CLAUDE = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('0.0.0 (Claude Code, fake)'); process.exit(0) }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const S = '00000000-0000-0000-0000-000000000001'
let buf = ''
process.stdin.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const m = JSON.parse(line)
        if (m.type === 'control_request')
            out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
        if (m.type === 'user') {
            out({ type: 'system', subtype: 'init', session_id: S, model: 'fake', tools: [], mcp_servers: [] })
            out({ ...m, session_id: S, parent_tool_use_id: null, isReplay: true })
            out({ type: 'assistant', session_id: S, parent_tool_use_id: null, message: { id: 'msg_1', model: 'fake', role: 'assistant', content: [{ type: 'text', text: 'Working…' }], usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } })
            setTimeout(() => {
                out({ type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: S, num_turns: 3, duration_ms: 2000, total_cost_usd: 0, usage: { input_tokens: 120, output_tokens: 30 } })
                process.exit(0)
            }, 2000)
        }
    }
})
`

const until = async (test: () => boolean, timeoutMs = 5000) => {
    const start = Date.now()
    while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 50))
    }
}

describe('a running task reports its progress', () => {
    let t: TestApp
    afterEach(() => t.cleanup())

    it('writes turns, tokens and wall-clock to the row before the result lands', async () => {
        t = createTestApp({ claude: SLOW_CLAUDE })
        const { tasks, store } = t.ctx
        const conversation = tasks.newConversation('web', null, null, null)
        const task = tasks.submit(conversation.id, 'web', 'take your time')
        await until(() => (store.getTask(task.id)?.num_turns ?? 0) > 0).catch((e: unknown) => {
            const row = store.getTask(task.id)
            throw new Error(
                `${String(e)}: ${JSON.stringify(row)} events=${JSON.stringify(store.listEvents?.(task.id) ?? null)}`
            )
        })
        const running = store.getTask(task.id)!
        expect(running.status).toBe('running')
        expect(running.num_turns).toBe(1)
        expect(running.cache_read_tokens).toBe(1000)
        expect(running.duration_ms).toBeGreaterThanOrEqual(0)
        await until(() => store.getTask(task.id)?.status === 'done', 8000).catch((e: unknown) => {
            const row = store.getTask(task.id)
            throw new Error(
                `${String(e)}: ${JSON.stringify(row)} events=${JSON.stringify(store.listEvents(task.id).map((ev) => [ev.type, ev.payload]))}`
            )
        })
        const done = store.getTask(task.id)!
        // The CLI's own count wins at the end; the wall-clock covers the whole run.
        expect(done.num_turns).toBe(3)
        expect(done.duration_ms).toBeGreaterThanOrEqual(2000)
    }, 20_000)
})
