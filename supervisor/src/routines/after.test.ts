import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'
import type { StepOutput, StepResult } from './steps.js'

/** A `claude` for routine runs: reports "Report: done", or fails when the instructions say "Please fail". */
const FAKE = `#!/usr/bin/env node
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
        if (m.type !== 'user') continue
        const prompt = typeof m.message.content === 'string' ? m.message.content : m.message.content.map((c) => c.text ?? '').join('')
        out({ type: 'system', subtype: 'init', session_id: S, model: 'fake', tools: [], mcp_servers: [] })
        out({ ...m, session_id: S, parent_tool_use_id: null, isReplay: true })
        const failed = prompt.includes('Please fail')
        out({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, result: failed ? 'it broke' : 'Report: done', session_id: S, num_turns: 1, duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
        process.exit(0)
    }
})
`

const until = async (test: () => boolean, timeoutMs = 10_000) => {
    const start = Date.now()
    while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 30))
    }
}

describe('steps after the agent', () => {
    let t: TestApp
    afterEach(() => t.cleanup())

    /** A routine with the orchestrator and the given scripts after it; each appends a line to data/out.txt. */
    function setup(body: string, after: Array<Record<string, unknown>>) {
        t = createTestApp({ claude: FAKE })
        t.ctx.catalog.save('routines', 'nightly', {
            frontmatter: { enabled: true, triggers: [], steps: [{ agent: 'orchestrator' }, ...after] },
            body
        })
        fs.mkdirSync(path.join(t.ctx.catalog.folderOf('routines', 'nightly'), 'data'), { recursive: true })
        const events: Array<{ steps: StepResult[]; outputs: StepOutput[] }> = []
        t.ctx.routines.on('after', (_run, _spec, steps, outputs) => events.push({ steps, outputs }))
        return events
    }
    const out = () => {
        const file = path.join(t.ctx.catalog.folderOf('routines', 'nightly'), 'data', 'out.txt')
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    }
    const write = (line: string) => `echo "${line}" >> "$ROUTINE_DIR/data/out.txt"`

    it('runs the success and always scripts once the agent is done, with its status and report', async () => {
        const events = setup('Look and report.', [
            { run: write('$AGENT_STATUS|$TASK_ID|$(echo "$AGENT_RESULT" | head -c 5)'), name: 'Publish' },
            { run: write('alert'), if: 'failure' },
            { run: write('cleanup'), if: 'always' }
        ])
        const run = await t.ctx.routines.fire('nightly', 'manual')
        expect(run.status).toBe('queued')
        await until(() => events.length > 0)
        const task = t.ctx.store.getTask(run.task_id!)!
        expect(task.status).toBe('done')
        expect(out().trim().split('\n')).toEqual([`success|${task.id}|Repor`, 'cleanup'])
        expect(events[0].steps.map((s) => [s.index, s.name, s.ok])).toEqual([
            [1, 'Publish', true],
            [3, 'step 4', true]
        ])
        // The same run's row: its steps and note say what came after.
        const row = t.ctx.store.routineRunOfTask(task.id)!
        expect(row.steps?.map((s) => s.name)).toEqual(['Publish', 'step 4'])
        expect(row.note).toContain('after the agent: 2 step(s) ok')
    })

    it('runs the failure scripts when the agent failed, and a failing script stops the rest', async () => {
        const events = setup('Please fail.', [
            { run: write('published'), if: 'success' },
            { run: 'echo broken >&2; exit 3', name: 'Alert', if: 'failure' },
            { run: write('cleanup'), if: 'always' }
        ])
        const run = await t.ctx.routines.fire('nightly', 'manual')
        await until(() => events.length > 0)
        expect(t.ctx.store.getTask(run.task_id!)?.status).toBe('failed')
        expect(events[0].steps).toEqual([expect.objectContaining({ name: 'Alert', ok: false })])
        expect(out()).toBe('')
        expect(t.ctx.store.routineRunOfTask(run.task_id!)?.note).toContain('after the agent: Alert failed')
    })

    it('refuses another run while the scripts after the agent go', async () => {
        const events = setup('Look and report.', [{ run: `sleep 1; ${write('slow')}` }])
        const run = await t.ctx.routines.fire('nightly', 'manual')
        await until(() => t.ctx.store.getTask(run.task_id!)?.status === 'done')
        await until(() => t.ctx.routines.get('nightly')!.finishing)
        const second = await t.ctx.routines.fire('nightly', 'manual')
        expect(second).toMatchObject({
            status: 'skipped',
            note: 'the previous run is still running its steps after the agent'
        })
        await until(() => events.length > 0)
        expect(t.ctx.routines.get('nightly')!.finishing).toBe(false)
        expect(out()).toBe('slow\n')
    })
})
