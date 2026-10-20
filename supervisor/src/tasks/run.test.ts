import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'
import { TaskService, type Workspace } from './service.js'

/**
 * A `claude` for the run's edges: `--resume gone` is a session the CLI has no transcript for,
 * `--resume flaky` a run that starts and then dies, `--resume silent` one that dies before a word; a prompt with "two" asks two questions
 * at once and answers once both are settled; anything else is done at once.
 */
const CLAUDE = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('0.0.0 (Claude Code, fake)'); process.exit(0) }
const resume = process.argv.indexOf('--resume')
const id = resume >= 0 ? process.argv[resume + 1] : null
if (id === 'gone') { process.stderr.write('No conversation found with session ID: gone\\n'); process.exit(1) }
if (id === 'silent') { process.stderr.write('exec: connection reset\\n'); process.exit(1) }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const S = '00000000-0000-0000-0000-000000000002'
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: S, num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
const question = (rid, q) => out({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 't-' + rid, input: { questions: [{ question: q, options: [{ label: 'yes' }, { label: 'no' }] }] } } })
const answers = {}
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
            if (id === 'flaky') { out({ type: 'assistant', session_id: S, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Looking…' }] } }); process.stderr.write('sbx: the daemon did not answer\\n'); setTimeout(() => process.exit(1), 100); return }
            const prompt = m.message.content.map((p) => p.text).join('')
            if (/two/.test(prompt)) { question('r1', 'First?'); question('r2', 'Second?') }
            else result('Done')
        }
        if (m.type === 'control_response') {
            Object.assign(answers, m.response.response.updatedInput?.answers ?? {})
            if (Object.keys(answers).length === 2) result('Got ' + JSON.stringify(answers))
        }
    }
})
process.stdin.on('end', () => process.exit(0))
`

const until = async (test: () => boolean, timeoutMs = 10_000) => {
    const start = Date.now()
    while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 20))
    }
}

describe('a task run', () => {
    let t: TestApp
    afterEach(async () => {
        vi.restoreAllMocks()
        await t.cleanup()
    })

    const ended = (id: string) => () => ['done', 'failed', 'cancelled'].includes(t.ctx.store.getTask(id)!.status)

    it('fails the task when its setup throws, instead of taking the process down', async () => {
        t = createTestApp({ claude: CLAUDE })
        const { tasks, store } = t.ctx
        vi.spyOn(tasks, 'agentEnv').mockImplementation(() => {
            throw new Error('secrets.json is not JSON')
        })
        const id = tasks.submit(tasks.newConversation('web', null).id, 'web', 'hello').id
        await until(ended(id))
        expect(store.getTask(id)).toMatchObject({ status: 'failed', error: 'secrets.json is not JSON' })
        expect(tasks.runningTaskIds()).toEqual([])
    })

    it('shows a second request once the first is answered', async () => {
        t = createTestApp({ claude: CLAUDE })
        const { tasks, store } = t.ctx
        const id = tasks.submit(tasks.newConversation('web', null).id, 'web', 'two questions').id
        await until(() => store.getTask(id)?.ask?.request_id === 'r1')
        // The second request is not lost behind the first: it comes up once the first is settled.
        await new Promise((r) => setTimeout(r, 100))
        expect(store.getTask(id)!.ask!.request_id).toBe('r1')
        expect(tasks.answer(id, { answers: { 'First?': 'yes' } }).ask?.request_id).toBe('r2')
        expect(tasks.answer(id, { answers: { 'Second?': 'no' } }).ask).toBeNull()
        await until(ended(id))
        expect(store.getTask(id)).toMatchObject({ status: 'done', result: 'Got {"First?":"yes","Second?":"no"}' })
    })

    it('starts afresh only when the CLI says the session is gone', async () => {
        t = createTestApp({ claude: CLAUDE })
        const { tasks, store } = t.ctx
        const conversation = tasks.newConversation('web', null)
        store.updateConversation(conversation.id, { session_id: 'gone' })
        const id = tasks.submit(conversation.id, 'web', 'hello').id
        await until(ended(id))
        expect(store.getTask(id)).toMatchObject({ status: 'done', result: 'Done' })
    })

    it('starts afresh when a resumed run dies before its first event, whatever it printed', async () => {
        t = createTestApp({ claude: CLAUDE })
        const { tasks, store } = t.ctx
        const conversation = tasks.newConversation('web', null)
        store.updateConversation(conversation.id, { session_id: 'silent' })
        const id = tasks.submit(conversation.id, 'web', 'hello').id
        await until(ended(id))
        expect(store.getTask(id)).toMatchObject({ status: 'done', result: 'Done' })
    })

    it('keeps the session when a resumed run fails after it started', async () => {
        t = createTestApp({ claude: CLAUDE })
        const { tasks, store } = t.ctx
        const conversation = tasks.newConversation('web', null)
        store.updateConversation(conversation.id, { session_id: 'flaky' })
        const id = tasks.submit(conversation.id, 'web', 'hello').id
        await until(ended(id))
        expect(store.getTask(id)!.status).toBe('failed')
        expect(store.getTask(id)!.error).toMatch(/daemon did not answer/)
        // Not forgotten: the conversation keeps the session the run reported.
        expect(store.getConversation(conversation.id)!.session_id).not.toBeNull()
        expect(store.listEvents(id).some((e) => /could not be resumed/.test(JSON.stringify(e.payload)))).toBe(false)
    })

    it('says a stop came too late while the end is being written', async () => {
        t = createTestApp({ claude: CLAUDE })
        const { tasks, store } = t.ctx
        let measuring = false
        const service = tasks as unknown as { recordChanges: () => Promise<void> }
        vi.spyOn(service, 'recordChanges').mockImplementation(async () => {
            measuring = true
            await new Promise((r) => setTimeout(r, 300))
        })
        const id = tasks.submit(tasks.newConversation('web', null).id, 'web', 'hello').id
        await until(() => measuring)
        expect(tasks.stop(id)).toBe(false)
        await until(ended(id))
        expect(store.getTask(id)!.status).toBe('done')
    })

    it('lets any number of listeners follow it', () => {
        t = createTestApp({ claude: CLAUDE })
        expect(t.ctx.tasks.getMaxListeners()).toBe(0)
    })

    it('does not run a delegated role whose parent failed at the restart', async () => {
        t = createTestApp({ claude: CLAUDE, config: (c) => (c.maxConcurrentSessions = 0) })
        const { store, config, providers } = t.ctx
        const parentChat = store.createConversation('web', null)
        const parent = store.createTask(parentChat.id, 'web', 'orchestrate')
        // Over the restart limit: the recovery fails it.
        store.updateTask(parent.id, { status: 'running', restarts: 5 })
        const roleChat = store.createConversation('delegate', null)
        const child = store.createTask(
            roleChat.id,
            'delegate',
            'research',
            null,
            null,
            null,
            null,
            'gpu',
            null,
            parent.id
        )
        store.updateTask(child.id, { status: 'running' })
        const service = new TaskService(store, config, {} as Workspace, providers)
        try {
            expect(store.getTask(parent.id)!.status).toBe('failed')
            expect(store.getTask(child.id)!.status).toBe('cancelled')
        } finally {
            await service.shutdown()
        }
    })
})
