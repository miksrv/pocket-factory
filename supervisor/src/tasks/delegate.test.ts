import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'

/**
 * A `claude` for delegation: it appends its arguments, cwd and endpoint to `$CALLS` (one JSON line
 * per run) and answers by the prompt. "hold" waits for `$RELEASE` to exist (an orchestrator in the
 * middle of a `delegate` call); "boom" on a provider fails the way the gateway reports a dead box;
 * anything else saves `note.md` in its cwd and reports it.
 */
const DELEGATE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('0.0.0 (Claude Code, fake)'); process.exit(0) }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const S = '00000000-0000-0000-0000-00000000000' + (process.pid % 10)
const onProvider = Boolean(process.env.ANTHROPIC_BASE_URL)
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
        fs.appendFileSync(process.env.CALLS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), onProvider, prompt }) + '\\n')
        out({ type: 'system', subtype: 'init', session_id: S, model: 'fake', tools: ['Read', 'Write'], agents: ['Explore', 'Plan', 'writer'], mcp_servers: [] })
        out({ ...m, session_id: S, parent_tool_use_id: null, isReplay: true })
        const end = (result, isError = false) => {
            out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result, session_id: S, num_turns: 1, duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
            process.exit(0)
        }
        if (prompt.includes('hold')) {
            const wait = setInterval(() => { if (fs.existsSync(process.env.RELEASE)) { clearInterval(wait); end('Parent done') } }, 30)
        } else if (prompt.includes('boom') && onProvider) {
            end('API Error: 502 provider gpu unreachable: fetch failed', true)
        } else {
            fs.writeFileSync('note.md', '# Note\\n')
            end(onProvider ? 'note.md written on the provider' : 'note.md written on the subscription')
        }
    }
})
`

interface Call {
    argv: string[]
    cwd: string
    onProvider: boolean
    prompt: string
}

const until = async (test: () => boolean, timeoutMs = 10_000) => {
    const start = Date.now()
    while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 30))
    }
}

/** A provider box that answers its models route: reachable. */
let liveUrl = ''
beforeAll(async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[]}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    liveUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    server.unref()
    return () => server.close()
})

describe('delegate', () => {
    let t: TestApp
    let calls: string
    let release: string
    // The held orchestrator is not released: a run that ends while the app shuts down would write to a closed store; SIGTERM ends the fake.
    afterEach(() => t.cleanup())

    /** An app with the role `writer` on provider `gpu`, and a running orchestrator task. */
    async function setup(
        options: { url?: string; fallback?: string; project?: string; maxSessions?: number; maxTurns?: number } = {}
    ) {
        t = createTestApp({
            claude: DELEGATE_CLAUDE,
            config: (c) => (c.maxConcurrentSessions = options.maxSessions ?? 2)
        })
        calls = path.join(t.dataRoot, 'calls.jsonl')
        release = path.join(t.dataRoot, 'release')
        process.env.CALLS = calls
        process.env.RELEASE = release
        const { tasks, providers, catalog, store } = t.ctx
        providers.save('gpu', { url: options.url ?? liveUrl, models: ['small'], default: 'small', light: true })
        catalog.save('agents', 'writer', {
            frontmatter: {
                description: 'Writes notes',
                provider: 'gpu',
                provider_model: 'small',
                ...(options.fallback ? { fallback: options.fallback } : {}),
                ...(options.maxTurns ? { maxTurns: options.maxTurns } : {})
            },
            body: 'You write notes.'
        })
        let project: string | null = null
        if (options.project) {
            fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'work'), { recursive: true })
            catalog.save('projects', 'work', {
                frontmatter: options.project === 'allows' ? { providers: ['gpu'] } : {},
                body: ''
            })
            project = 'work'
        }
        const conversation = tasks.newConversation('web', null, null, project)
        const parent = tasks.submit(conversation.id, 'web', 'hold until released')
        await until(() => store.getTask(parent.id)?.status === 'running')
        return parent
    }

    const runs = (): Call[] =>
        fs.existsSync(calls)
            ? fs
                  .readFileSync(calls, 'utf8')
                  .trim()
                  .split('\n')
                  .map((l) => JSON.parse(l) as Call)
            : []

    it('runs the role on its provider in a work directory and reports its files', async () => {
        const parent = await setup()
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.ok).toBe(true)
        const child = outcome.task!
        expect(child).toMatchObject({ parent_id: parent.id, provider: 'gpu', model: 'small', agent: 'writer' })
        expect(t.ctx.store.getConversation(child.conversation_id)?.channel).toBe('delegate')
        const dir = t.ctx.tasks.delegateDir(child)
        expect(dir.startsWith(path.join(t.dataRoot, 'inbox', parent.conversation_id, 'delegate'))).toBe(true)
        expect(fs.existsSync(path.join(dir, 'note.md'))).toBe(true)
        expect(outcome.text).toContain('finished on gpu · small')
        expect(outcome.text).toContain('Files: note.md')
        expect(outcome.text).toContain('note.md written on the provider')
        const run = runs().find((r) => r.prompt.startsWith('Write a note'))!
        expect(run.onProvider).toBe(true)
        expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(dir))
        expect(run.prompt).toContain(`[Work directory: ${dir}.`)
        // The parent's thread records the hand-over.
        const note = t.ctx.store
            .listEvents(parent.id)
            .find((e) => e.type === 'status' && (e.payload as { delegate?: unknown }).delegate)
        expect(note?.payload).toMatchObject({ delegate: { task_id: child.id, agent: 'writer', provider: 'gpu' } })
    })

    it('remembers the sub-agent types the CLI lists at a session start', async () => {
        await setup()
        await until(() => t.ctx.tasks.agents().length > 0)
        expect(t.ctx.tasks.agents()).toEqual(['Explore', 'Plan', 'writer'])
        const list = (await (await t.request('/api/tools')).json()) as { agents: string[] }
        expect(list.agents).toEqual(['Explore', 'Plan', 'writer'])
    })

    it('hides the role from the Chat list and its counters', async () => {
        const parent = await setup()
        await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        const listed = t.ctx.store.listConversations()
        expect(listed.map((c) => c.channel)).not.toContain('delegate')
        expect(listed).toHaveLength(1)
    })

    it("falls back to the orchestrator's model when the provider does not answer", async () => {
        const parent = await setup({ url: 'http://127.0.0.1:1' })
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.ok).toBe(true)
        expect(outcome.task).toMatchObject({ provider: null, model: 'sonnet', agent: 'writer' })
        expect(outcome.text).toContain('Not on gpu: gpu unreachable')
        const run = runs().find((r) => r.prompt.startsWith('Write a note'))!
        expect(run.onProvider).toBe(false)
        // The role's file rides on the CLI's own prompt, with the tools it has instead of the box's search.
        const append = run.argv[run.argv.indexOf('--append-system-prompt') + 1]
        expect(append).toContain('# Your role: writer')
        expect(append).toContain('WebSearch')
    })

    it('runs the role once more on the subscription when the provider fails mid-run', async () => {
        const parent = await setup()
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'boom: write a note' })
        expect(outcome.ok).toBe(true)
        const children = t.ctx.store.childTasks(parent.id)
        expect(children.map((c) => [c.provider, c.status])).toEqual([
            ['gpu', 'failed'],
            [null, 'done']
        ])
        expect(outcome.text).toContain('gpu failed mid-run')
    })

    it('reports instead of falling back when the file says fallback: none', async () => {
        const parent = await setup({ url: 'http://127.0.0.1:1', fallback: 'none' })
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.ok).toBe(false)
        expect(outcome.text).toContain('did not run')
        expect(t.ctx.store.childTasks(parent.id)).toHaveLength(0)
    })

    it('uses the alias a file names as its fallback', async () => {
        const parent = await setup({ url: 'http://127.0.0.1:1', fallback: 'haiku' })
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.task).toMatchObject({ provider: null, model: 'haiku' })
    })

    it("keeps a project's work off a provider the project does not allow, and says so with the reply", async () => {
        const parent = await setup({ project: 'silent' })
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.task?.provider).toBeNull()
        expect(outcome.text).toContain('project work does not allow provider gpu')
        // What the Telegram footer and the chat show: the role, where it ran and why not on its provider.
        expect(t.ctx.tasks.delegationsOf(parent.id)).toEqual([
            {
                task_id: outcome.task!.id,
                agent: 'writer',
                provider: null,
                model: 'sonnet',
                fallback: expect.stringContaining('project work does not allow provider gpu') as unknown
            }
        ])
    })

    it("runs a delegated role with its file's maxTurns, on the provider and on the fallback alike", async () => {
        const parent = await setup({ maxTurns: 20 })
        await until(() => runs().some((r) => r.prompt.startsWith('hold until released')))
        await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        const onProvider = runs().find((r) => r.prompt.startsWith('Write a note'))!
        expect(onProvider.onProvider).toBe(true)
        expect(onProvider.argv[onProvider.argv.indexOf('--max-turns') + 1]).toBe('20')
        // The orchestrator itself keeps the factory's limit.
        const orchestrator = runs().find((r) => r.prompt.startsWith('hold until released'))!
        expect(orchestrator.argv[orchestrator.argv.indexOf('--max-turns') + 1]).toBe('50')
    })

    it('sends a project to a provider its file allows', async () => {
        const parent = await setup({ project: 'allows' })
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.task?.provider).toBe('gpu')
    })

    it('joins the role already done when the same brief comes again (a resumed parent)', async () => {
        const parent = await setup()
        const first = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        const again = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(again.task?.id).toBe(first.task?.id)
        expect(t.ctx.store.childTasks(parent.id)).toHaveLength(1)
    })

    it('passes the files the orchestrator names in the brief', async () => {
        const parent = await setup()
        const outcome = await t.ctx.tasks.delegate(parent.id, {
            agent: 'writer',
            prompt: 'Write a note',
            files: ['/data/metrics.json']
        })
        expect(outcome.task?.prompt).toContain('- /data/metrics.json')
    })

    it('refuses an unknown role and names the known ones', async () => {
        const parent = await setup()
        await expect(t.ctx.tasks.delegate(parent.id, { agent: 'nobody', prompt: 'x' })).rejects.toThrow(
            /the roles are: writer/
        )
    })

    it('lends the waiting parent its slot', async () => {
        const parent = await setup({ maxSessions: 1 })
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.ok).toBe(true)
        expect(t.ctx.store.getTask(parent.id)?.status).toBe('running')
    })

    it('lends the slot even when another task waits ahead of the role in the queue', async () => {
        const parent = await setup({ maxSessions: 1 })
        const other = t.ctx.tasks.newConversation('web', null, null, null)
        const waiting = t.ctx.tasks.submit(other.id, 'web', 'Write another note')
        const outcome = await t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'Write a note' })
        expect(outcome.ok).toBe(true)
        expect(t.ctx.store.getTask(waiting.id)?.status).toBe('queued')
    })

    it('stops the roles with their parent', async () => {
        const parent = await setup({ url: liveUrl })
        // A role that waits: its parent's stop must take it down.
        const pending = t.ctx.tasks.delegate(parent.id, { agent: 'writer', prompt: 'hold as a role' })
        await until(() => t.ctx.store.childTasks(parent.id)[0]?.status === 'running')
        t.ctx.tasks.stop(parent.id)
        const outcome = await pending
        expect(outcome.task?.status).toBe('cancelled')
    })

    it('offers the orchestrator the factory server and keeps the role from its Agent tool', async () => {
        await setup()
        await until(() => runs().some((r) => r.prompt.startsWith('hold until released')))
        const run = runs().find((r) => r.prompt.startsWith('hold until released'))!
        const config = run.argv.find((a) => a.includes('"factory"'))!
        const server = (JSON.parse(config) as { mcpServers: Record<string, { url: string; timeout: number }> })
            .mcpServers.factory
        expect(server.url).toMatch(/\/factory\/[0-9a-f-]+\/mcp$/)
        expect(server.timeout).toBeGreaterThanOrEqual(60 * 60_000)
        const settings = JSON.parse(run.argv[run.argv.indexOf('--settings') + 1]) as {
            permissions: { allow: string[]; deny: string[] }
        }
        expect(settings.permissions.allow).toContain('mcp__factory')
        expect(settings.permissions.deny).toContain('Agent(writer)')
        expect(run.argv[run.argv.indexOf('--append-system-prompt') + 1]).toContain('mcp__factory__delegate')
    })
})
