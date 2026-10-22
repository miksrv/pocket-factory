import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'

/**
 * A `claude` for hand-offs: it appends its arguments and cwd to `$CALLS` (one JSON line per run)
 * and answers by the prompt. "hold" waits for `$RELEASE` to exist (a routine's run in the middle of
 * a `hand_off` call); "fail" fails; anything else reports "fixed" with its cwd.
 */
const HANDOFF_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('0.0.0 (Claude Code, fake)'); process.exit(0) }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const S = '00000000-0000-0000-0000-0000000000' + String(process.pid % 100).padStart(2, '0')
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
        fs.appendFileSync(process.env.CALLS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt }) + '\\n')
        out({ type: 'system', subtype: 'init', session_id: S, model: 'fake', tools: ['Read'], mcp_servers: [] })
        out({ ...m, session_id: S, parent_tool_use_id: null, isReplay: true })
        const end = (result, isError = false) => {
            out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result, session_id: S, num_turns: 1, duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
            process.exit(0)
        }
        if (prompt.includes('hold')) {
            const wait = setInterval(() => { if (fs.existsSync(process.env.RELEASE)) { clearInterval(wait); end('Run done') } }, 30)
        } else if (prompt.includes('fail')) end('it broke', true)
        else end('fixed in ' + process.cwd())
    }
})
`

interface Call {
    argv: string[]
    cwd: string
    prompt: string
}

const until = async (test: () => boolean, timeoutMs = 10_000) => {
    const start = Date.now()
    while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 30))
    }
}

describe('hand_off', () => {
    let t: TestApp
    let calls: string
    afterEach(() => t.cleanup())

    /** An app with the project `users` and the agent `fixer`, and a routine's run that holds. */
    async function setup(options: { maxSessions?: number; routine?: boolean; handOff?: string[] } = {}) {
        t = createTestApp({
            claude: HANDOFF_CLAUDE,
            config: (c) => (c.maxConcurrentSessions = options.maxSessions ?? 2)
        })
        calls = path.join(t.dataRoot, 'calls.jsonl')
        process.env.CALLS = calls
        process.env.RELEASE = path.join(t.dataRoot, 'release')
        const { tasks, catalog, store } = t.ctx
        fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'users'), { recursive: true })
        catalog.save('projects', 'users', { frontmatter: {}, body: '' })
        catalog.save('agents', 'fixer', { frontmatter: { description: 'Fixes bugs', model: 'opus' }, body: 'You fix.' })
        catalog.save('agents', 'writer', { frontmatter: { description: 'Writes', provider: 'gpu' }, body: 'x' })
        // Another project with a checkout, which the routine does not list: no hand-off goes there.
        fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'billing'), { recursive: true })
        catalog.save('projects', 'billing', { frontmatter: {}, body: '' })
        catalog.save('routines', 'bugs', {
            frontmatter: {
                enabled: false,
                triggers: [],
                hand_off: options.handOff ?? ['users'],
                steps: [{ agent: 'orchestrator' }]
            },
            body: 'One bug per run.'
        })
        const conversation = tasks.newConversation('web', options.routine === false ? null : 'schedule:bugs')
        const run = tasks.submit(
            conversation.id,
            options.routine === false ? 'web' : 'routine',
            'hold until released',
            options.routine === false ? {} : { schedule: 'bugs' }
        )
        await until(() => store.getTask(run.id)?.status === 'running')
        return run
    }

    const runs = (): Call[] =>
        fs.existsSync(calls)
            ? fs
                  .readFileSync(calls, 'utf8')
                  .trim()
                  .split('\n')
                  .map((l) => JSON.parse(l) as Call)
            : []

    const brief = { project: 'users', agent: 'fixer', prompt: 'Fix ticket #1', title: '#1 Export fails' }

    it("opens a visible chat of the project, runs the agent in its checkout and answers with the chat's report", async () => {
        const run = await setup()
        const outcome = await t.ctx.tasks.handOff(run.id, brief)
        expect(outcome.ok).toBe(true)
        const task = outcome.task!
        expect(task).toMatchObject({ source: 'handoff', handed_by: run.id, project: 'users', agent: 'fixer' })
        expect(task.model).toBe('opus')
        const conversation = t.ctx.store.getConversation(task.conversation_id)!
        expect(conversation).toMatchObject({ channel: 'web', project: 'users', title: '#1 Export fails' })
        expect(t.ctx.store.listConversations().map((c) => c.id)).toContain(conversation.id)
        const call = runs().find((r) => r.prompt.startsWith('Fix ticket #1'))!
        expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(path.join(t.ctx.config.paths.workspacesRoot, 'users')))
        expect(call.argv[call.argv.indexOf('--agent') + 1]).toBe('fixer')
        expect(outcome.text).toContain(`/chat/${conversation.id}`)
        expect(outcome.text).toContain('fixed in')
        // The run's thread records the hand-over with the way into the chat.
        const note = t.ctx.store
            .listEvents(run.id)
            .find((e) => e.type === 'status' && (e.payload as { handoff?: unknown }).handoff)
        expect(note?.payload).toMatchObject({
            handoff: { task_id: task.id, conversation_id: conversation.id, project: 'users', agent: 'fixer' }
        })
    })

    it('lends the waiting run its slot', async () => {
        const run = await setup({ maxSessions: 1 })
        const outcome = await t.ctx.tasks.handOff(run.id, brief)
        expect(outcome.ok).toBe(true)
        expect(t.ctx.store.getTask(run.id)?.status).toBe('running')
    })

    it('joins the chat already made when the same brief comes again (a resumed run)', async () => {
        const run = await setup()
        const first = await t.ctx.tasks.handOff(run.id, brief)
        const again = await t.ctx.tasks.handOff(run.id, brief)
        expect(again.task?.id).toBe(first.task?.id)
        expect(t.ctx.store.handedTasks(run.id)).toHaveLength(1)
    })

    it('asks a failed chat again in the same chat', async () => {
        const run = await setup()
        const failing = { ...brief, prompt: 'fail on ticket #2' }
        const first = await t.ctx.tasks.handOff(run.id, failing)
        expect(first.ok).toBe(false)
        expect(first.text).toContain('Error: ')
        const again = await t.ctx.tasks.handOff(run.id, failing)
        expect(again.task?.id).not.toBe(first.task?.id)
        expect(again.task?.conversation_id).toBe(first.task?.conversation_id)
    })

    it('stops the chat with the run, and the chat stays', async () => {
        const run = await setup()
        const pending = t.ctx.tasks.handOff(run.id, { ...brief, prompt: 'hold as the fixer' })
        await until(() => t.ctx.store.handedTasks(run.id)[0]?.status === 'running')
        t.ctx.tasks.stop(run.id)
        const outcome = await pending
        expect(outcome.task?.status).toBe('cancelled')
        expect(t.ctx.store.getConversation(outcome.task!.conversation_id)?.deleted_at).toBeNull()
    })

    it('refuses what is not a routine run, an unknown project, a provider role or a missing agent', async () => {
        const run = await setup()
        await expect(t.ctx.tasks.handOff(run.id, { ...brief, project: 'nowhere' })).rejects.toThrow(
            /takes no hand-off from this routine; its `hand_off:` lists: users/
        )
        // A project that exists but the routine's file does not list: an injected brief must not reach it.
        await expect(t.ctx.tasks.handOff(run.id, { ...brief, project: 'billing' })).rejects.toThrow(/takes no hand-off/)
        await expect(t.ctx.tasks.handOff(run.id, { ...brief, agent: 'writer' })).rejects.toThrow(/delegate/)
        await expect(t.ctx.tasks.handOff(run.id, { ...brief, agent: 'ghost' })).rejects.toThrow(/no agent file/)
        await t.cleanup()
        const chat = await setup({ routine: false })
        await expect(t.ctx.tasks.handOff(chat.id, brief)).rejects.toThrow(/only a routine's run/)
    })

    it("goes on as the chat's agent when the owner writes there afterwards", async () => {
        const run = await setup()
        const outcome = await t.ctx.tasks.handOff(run.id, brief)
        const next = t.ctx.tasks.submit(outcome.task!.conversation_id, 'web', 'Close the PR instead')
        expect(next).toMatchObject({ agent: 'fixer', source: 'web', handed_by: null })
        await until(() => t.ctx.store.getTask(next.id)?.status === 'done')
        const call = runs().find((r) => r.prompt.startsWith('Close the PR instead'))!
        expect(call.argv[call.argv.indexOf('--agent') + 1]).toBe('fixer')
    })

    it("lists hand_off on the run's factory endpoint and answers a call over SSE", async () => {
        const run = await setup()
        await until(() => runs().length > 0)
        const rpc = (body: unknown) =>
            t.request(`/factory/${run.id}/mcp`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    authorization: `Bearer ${t.ctx.tasks.factoryToken(run.id)}`
                },
                body: JSON.stringify(body)
            })
        const list = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
            result: { tools: Array<{ name: string; inputSchema: { properties: { project: { enum: string[] } } } }> }
        }
        const tool = list.result.tools.find((x) => x.name === 'hand_off')!
        expect(tool.inputSchema.properties.project.enum).toEqual(['users'])
        const res = await rpc({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'hand_off', arguments: brief }
        })
        expect(res.headers.get('content-type')).toContain('text/event-stream')
        const text = await res.text()
        expect(text).toContain('fixed in')
        expect(text).toContain('"isError":false')
    })

    it("offers hand_off to a routine's run whose file lists projects, and to nothing else", async () => {
        const run = await setup()
        await until(() => runs().length > 0)
        expect(t.ctx.tasks.factoryTools(run.id).handoff).toBe(true)
        expect(t.ctx.tasks.handOffTargets(run.id)).toEqual(['users'])
        const config = runs()[0].argv.find((a) => a.includes('"factory"'))
        expect(config).toBeDefined()
        await t.cleanup()
        const chat = await setup({ routine: false })
        expect(t.ctx.tasks.factoryTools(chat.id).handoff).toBe(false)
        await t.cleanup()
        const unlisted = await setup({ handOff: [] })
        await until(() => runs().length > 0)
        expect(t.ctx.tasks.factoryTools(unlisted.id).handoff).toBe(false)
    })
})
