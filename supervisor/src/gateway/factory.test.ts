import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'

describe('factory MCP server', () => {
    let t: TestApp
    let taskId: string
    beforeEach(() => {
        t = createTestApp()
        t.ctx.catalog.save('agents', 'writer', {
            frontmatter: { description: 'Writes notes', provider: 'gpu', provider_model: 'small' },
            body: 'You write notes.'
        })
        const conversation = t.ctx.tasks.newConversation('web', null, null, null)
        // Finished at once: the worker must not pick it up; a call in its name then has nobody to delegate for.
        taskId = t.ctx.store.createTask(conversation.id, 'web', 'orchestrate').id
        t.ctx.store.updateTask(taskId, { status: 'done' })
    })
    afterEach(() => t.cleanup())

    const rpc = (body: unknown, token = t.ctx.tasks.factoryToken(taskId), task = taskId) =>
        t.request(`/factory/${task}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${token}`
            },
            body: JSON.stringify(body)
        })

    it("refuses a bearer that is not the task's own", async () => {
        expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'nope')).status).toBe(401)
        // Another task's bearer opens that task's endpoint only.
        const other = t.ctx.tasks.factoryToken('another-task')
        expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, other)).status).toBe(401)
    })

    it('initializes with the protocol version the client asks for', async () => {
        const res = await rpc({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18' }
        })
        expect(await res.json()).toMatchObject({
            id: 1,
            result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'pocket-factory' }
            }
        })
    })

    it('accepts notifications without an answer', async () => {
        expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    })

    it('lists delegate with the roles as its choices', async () => {
        const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        const body = (await res.json()) as {
            result: {
                tools: Array<{
                    name: string
                    description: string
                    inputSchema: { properties: { agent: { enum: string[] } } }
                }>
            }
        }
        const [tool] = body.result.tools
        expect(tool.name).toBe('delegate')
        expect(tool.inputSchema.properties.agent.enum).toEqual(['writer'])
        expect(tool.description).toContain('- writer (gpu · small): Writes notes')
    })

    it('answers a call as an SSE stream, with the error when the task is not running', async () => {
        const res = await rpc({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'delegate', arguments: { agent: 'writer', prompt: 'Write a note' } }
        })
        expect(res.headers.get('content-type')).toBe('text/event-stream')
        const frame = (await res.text()).split('\n').find((l) => l.startsWith('data: '))!
        expect(JSON.parse(frame.slice(6))).toMatchObject({
            id: 3,
            result: {
                isError: true,
                content: [{ type: 'text', text: 'delegate failed: the delegating task is not running' }]
            }
        })
    })

    it('refuses an unknown method and tool', async () => {
        expect(await (await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).json()).toMatchObject({
            error: { code: -32601 }
        })
        expect(
            await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'other' } })).json()
        ).toMatchObject({ error: { code: -32602 } })
    })
})

describe('factory MCP server: preview', () => {
    let t: TestApp
    let dump: string
    beforeEach(() => {
        dump = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dump-'))
        // A CLI that records how it was started and then works until it is stopped.
        t = createTestApp({
            claude: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.0.0 (fake)"; exit 0; fi\nprintf '%s\\n' "$@" > ${dump}/args\nenv > ${dump}/env\nexec sleep 30\n`
        })
        t.ctx.catalog.save('projects', 'shop', { frontmatter: {}, body: '' })
        fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'shop'))
    })
    afterEach(async () => {
        await t.cleanup()
        fs.rmSync(dump, { recursive: true, force: true })
    })

    const rpc = (taskId: string, body: unknown) =>
        t.request(`/factory/${taskId}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${t.ctx.tasks.factoryToken(taskId)}`
            },
            body: JSON.stringify(body)
        })

    it("offers a project's task the preview tools, publishes the port and tells where the app is", async () => {
        const conversation = t.ctx.tasks.newConversation('web', null, null, 'shop')
        const task = t.ctx.tasks.submit(conversation.id, 'web', 'show the UI')
        await vi.waitFor(() => expect(t.ctx.tasks.factoryTools(task.id).preview).toBe(true), { timeout: 10_000 })
        // The fake CLI writes its env file while we may already read it: wait for the line itself.
        await vi.waitFor(
            () =>
                expect(
                    fs.existsSync(path.join(dump, 'env')) && fs.readFileSync(path.join(dump, 'env'), 'utf8')
                ).toContain(`PREVIEW_BASE=${t.ctx.previews.base('shop')}`),
            { timeout: 10_000 }
        )
        expect(fs.readFileSync(path.join(dump, 'args'), 'utf8')).toContain(`/factory/${task.id}/mcp`)

        const list = (await (await rpc(task.id, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
            result: { tools: Array<{ name: string }> }
        }
        expect(list.result.tools.map((tool) => tool.name)).toEqual(['preview', 'preview_stop'])
        const call = (await (
            await rpc(task.id, {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'preview', arguments: { port: 5173 } }
            })
        ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } }
        expect(call.result.isError).toBe(false)
        expect(call.result.content[0].text).toContain('/preview/shop/')
        expect(t.ctx.previews.get('shop')).toMatchObject({ port: 5173, task_id: task.id, strip: false })
        // A port that is not one is refused, and stop ends it.
        const bad = (await (
            await rpc(task.id, {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'preview', arguments: { port: 'x' } }
            })
        ).json()) as { result: { isError: boolean } }
        expect(bad.result.isError).toBe(true)
        await rpc(task.id, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'preview_stop' } })
        expect(t.ctx.previews.get('shop')).toBeNull()
        t.ctx.tasks.stop(task.id)
    })

    it('offers nothing to preview without a project, and refuses the call', async () => {
        const conversation = t.ctx.tasks.newConversation('web', null, null, null)
        const task = t.ctx.tasks.submit(conversation.id, 'web', 'hello')
        await vi.waitFor(() => expect(t.ctx.tasks.task(task.id)?.status).toBe('running'), { timeout: 10_000 })
        await vi.waitFor(() => expect(fs.existsSync(path.join(dump, 'args'))).toBe(true), { timeout: 10_000 })
        expect(t.ctx.tasks.factoryTools(task.id)).toEqual({ delegate: false, preview: false, handoff: false })
        const call = (await (
            await rpc(task.id, {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'preview', arguments: { port: 3000 } }
            })
        ).json()) as { error?: { code: number } }
        expect(call.error?.code).toBe(-32602)
        t.ctx.tasks.stop(task.id)
    })
})
