import { afterEach, describe, expect, it } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'

/** A `claude` that echoes the prompt after a pause, so several tasks overlap. */
const SLOW_CLAUDE = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('0.0.0 (Claude Code, fake)'); process.exit(0) }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const S = '00000000-0000-0000-0000-00000000000' + (process.pid % 10)
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
            setTimeout(() => {
                out({ type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: S, num_turns: 1, duration_ms: 1500, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
                process.exit(0)
            }, 1500)
        }
    }
})
`

const until = async (test: () => boolean, timeoutMs = 10_000) => {
    const start = Date.now()
    while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 50))
    }
}

describe('MAX_CONCURRENT_SESSIONS', () => {
    let t: TestApp
    afterEach(() => t.cleanup())

    it('is never overshot while tasks are starting (nothing yields before a task is registered)', async () => {
        t = createTestApp({ claude: SLOW_CLAUDE, config: (c) => (c.maxConcurrentSessions = 1) })
        const { tasks, store } = t.ctx
        const ids = [1, 2, 3].map(
            (n) => tasks.submit(tasks.newConversation('web', null, null, null).id, 'web', `task ${n}`).id
        )
        let peak = 0
        await until(() => {
            const running = ids.filter((id) => store.getTask(id)?.status === 'running').length
            peak = Math.max(peak, running)
            return ids.every((id) => store.getTask(id)?.status === 'done')
        }, 20_000)
        expect(peak).toBe(1)
    }, 30_000)
})
