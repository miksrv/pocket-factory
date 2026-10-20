import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { runClaude, type RunnerEvent, RunTimeout } from './runner.js'

// The fake CLI of the Playwright suite speaks the same stream-json protocol (see its header).
const FAKE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../e2e/fixtures/bin')

const run = (prompt: string) =>
    runClaude({
        prompt,
        cwd: process.cwd(),
        maxTurns: 5,
        permissionMode: 'default',
        env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ''}` }
    }).result

describe('runClaude', () => {
    it('returns the answer to the prompt', async () => {
        const result = await run('hello')
        expect(result.text).toBe('Echo: hello')
        expect(result.isError).toBe(false)
        expect(result.openAgentsAtResult).toBe(0)
        expect(result.stoppedAgentsAtResult).toBe(0)
    })

    it('skips a result the CLI produced before it took the prompt', async () => {
        // A resumed session first answers the notifications about background tasks the
        // previous run left behind: an empty result of 0 turns, then the prompt's own.
        const result = await run('orphan check')
        expect(result.text).toBe('Echo: orphan check')
        expect(result.numTurns).toBe(1)
    })

    it('counts a sub-agent stopped after the orchestrator last spoke', async () => {
        const result = await run('stopped agent')
        expect(result.text).toBe('Waiting for the client report.')
        expect(result.openAgentsAtResult).toBe(0)
        expect(result.stoppedAgentsAtResult).toBe(1)
    })

    it('reports an error result as an error', async () => {
        const result = await run('please fail')
        expect(result.isError).toBe(true)
    })
})

/**
 * A `claude` of the test's own: the handshake and the prompt's echo are done, `onPrompt()` and
 * `onAnswer(id, response)` are the test's; `out(m)` writes a line, `result(text)` the result.
 */
const PRELUDE = `#!/usr/bin/env node
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const S = '00000000-0000-0000-0000-000000000001'
const ask = (id) => out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't-' + id, input: { command: 'ls' } } })
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: S, num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
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
            out({ type: 'system', subtype: 'init', session_id: S, model: 'fake', tools: ['Bash'], mcp_servers: [] })
            out({ ...m, session_id: S, parent_tool_use_id: null, isReplay: true })
            onPrompt()
        }
        if (m.type === 'control_response') onAnswer(m.response.request_id, m.response.response)
    }
})
`

describe('runClaude against a scripted CLI', () => {
    const dirs: string[] = []
    afterEach(() => {
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    const start = (script: string, timeoutMs = 0) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cli-'))
        dirs.push(dir)
        fs.writeFileSync(path.join(dir, 'claude'), PRELUDE + script, { mode: 0o755 })
        const events: RunnerEvent[] = []
        const handle = runClaude({
            prompt: 'go',
            cwd: dir,
            maxTurns: 5,
            permissionMode: 'default',
            timeoutMs,
            env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` },
            onEvent: (event) => events.push(event)
        })
        const asks = () => events.flatMap((e) => (e.type === 'ask' ? [e.requestId] : []))
        return { handle, events, asks }
    }
    const until = async (test: () => boolean) => {
        const at = Date.now()
        while (!test()) {
            if (Date.now() - at > 10_000) throw new Error('timed out')
            await new Promise((r) => setTimeout(r, 20))
        }
    }
    const allow = { behavior: 'allow' as const, updatedInput: {} }

    it('keeps the reply when the limit ends a CLI that lingers after its result', async () => {
        // Background sub-agents keep the CLI alive after the result; the limit stops it, the reply stands.
        const { handle } = start(
            `function onPrompt() { result('the reply'); setInterval(() => {}, 1000) }
function onAnswer() {}
`,
            2000
        )
        const result = await handle.result
        expect(result.text).toBe('the reply')
    }, 20_000)

    it('keeps two requests open at once and takes an answer to each', async () => {
        const { handle, asks } = start(`const answered = new Set()
function onPrompt() { ask('r1'); ask('r2') }
function onAnswer(id) { answered.add(id); if (answered.size === 2) result('both: ' + [...answered].sort().join(',')) }
`)
        await until(() => asks().length === 2)
        expect(handle.answer('r2', allow)).toBe(true)
        expect(handle.answer('r1', allow)).toBe(true)
        expect(handle.answer('r1', allow)).toBe(false)
        expect((await handle.result).text).toBe('both: r1,r2')
    })

    it('refuses a request still open at the result and shows none that come after it', async () => {
        const { handle, events, asks } = start(`function onPrompt() { ask('r1'); ask('r2') }
function onAnswer(id, response) {
    if (id === 'r1') { result('done'); setTimeout(() => ask('r3'), 50) }
    if (id === 'r2') process.stderr.write('r2 ' + response.behavior + '\\n')
}
process.stdin.on('end', () => setTimeout(() => process.exit(0), 200))
`)
        await until(() => asks().length === 2)
        expect(handle.answer('r1', allow)).toBe(true)
        const result = await handle.result
        expect(result.text).toBe('done')
        expect(events.some((e) => e.type === 'ask_cancelled' && e.requestId === 'r2')).toBe(true)
        expect(asks()).toEqual(['r1', 'r2'])
        expect(handle.answer('r2', allow)).toBe(false)
        expect(handle.answer('r3', allow)).toBe(false)
    })

    it('takes no answer once the CLI has gone', async () => {
        const { handle, asks } = start(`function onPrompt() { ask('r1'); setTimeout(() => process.exit(3), 100) }
function onAnswer() {}
`)
        await until(() => asks().length === 1)
        await expect(handle.result).rejects.toThrow(/exited with code 3/)
        expect(handle.answer('r1', allow)).toBe(false)
    })

    it('pauses the limit while a request waits and goes on with what was left', async () => {
        // 2 s of work, a pause, 3 s more: past a 4 s limit, though each stretch alone is under it.
        const { handle, asks } = start(
            `function onPrompt() { setTimeout(() => ask('r1'), 2000) }
function onAnswer() { setTimeout(() => result('late'), 3000) }
`,
            4000
        )
        const settled = handle.result.catch((error: unknown) => error)
        await until(() => asks().length === 1)
        await new Promise((r) => setTimeout(r, 500))
        expect(handle.answer('r1', allow)).toBe(true)
        expect(await settled).toBeInstanceOf(RunTimeout)
    }, 20_000)

    it('keeps only the end of a long stderr', async () => {
        const { handle } =
            start(`function onPrompt() { process.stderr.write('x'.repeat(100_000) + 'THE END'); setTimeout(() => process.exit(1), 50) }
function onAnswer() {}
`)
        const error = await handle.result.then(
            () => null,
            (e: unknown) => e as Error
        )
        expect(error?.message).toMatch(/THE END$/)
        expect(error!.message.length).toBeLessThan(17 * 1024)
    })
})
