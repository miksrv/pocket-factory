import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Conversation, Task } from '../../store/index.js'
import { createTestApp, json, type TestApp } from '../../test/app.js'

/** The provider routes, the gateway's door and what a conversation and a task record about their provider. */
describe('providers', () => {
    let t: TestApp

    beforeEach(() => {
        t = createTestApp()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await t.cleanup()
    })

    const put = (name: string, body: unknown, create = false) =>
        t.request(`/api/providers/${name}${create ? '?create=1' : ''}`, json(body, { method: 'PUT' }))

    it('lists the subscription alone, then a saved provider with its key status', async () => {
        const empty = (await (await t.request('/api/providers')).json()) as { providers: unknown[]; builtin: string }
        expect(empty).toMatchObject({ providers: [], builtin: 'claude' })

        vi.stubEnv('LOOK_TOKEN', '')
        const saved = await put(
            'gpu-box',
            { url: 'http://10.77.0.1:11434', models: ['gemma4:12b'], token: 'LOOK_TOKEN', concurrency: 1 },
            true
        )
        expect(saved.status).toBe(200)
        const list = (await (await t.request('/api/providers')).json()) as {
            providers: Array<{ name: string; token_set: boolean; running: number; used_by: string[]; light: boolean }>
        }
        expect(list.providers).toEqual([
            expect.objectContaining({ name: 'gpu-box', token_set: false, running: 0, used_by: [], light: true })
        ])
        // A second create under the same name is refused; an edit is not.
        expect((await put('gpu-box', { url: 'http://x', models: ['m'] }, true)).status).toBe(409)
        expect((await put('gpu-box', { url: 'http://x', models: ['m'] })).status).toBe(200)
        // The status route carries the provider for the Overview.
        const status = (await (await t.request('/api/status')).json()) as { providers: Array<{ name: string }> }
        expect(status.providers.map((p) => p.name)).toEqual(['gpu-box'])
    })

    it('refuses bad input with 400 and a reason', async () => {
        const res = await put('p', { url: 'http://x', models: ['m'], token: 'sk-123' })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toMatch(/NAME of the key secret/)
        expect((await put('p', {})).status).toBe(400)
        // A draft may not read the factory's own secrets through the test or model-list probes.
        for (const path of ['/api/providers/test', '/api/providers/models']) {
            const leak = await t.request(
                path,
                json({ url: 'http://evil.test', models: ['m'], token: 'TELEGRAM_BOT_TOKEN' }, { method: 'POST' })
            )
            expect(leak.status).toBe(400)
            expect(((await leak.json()) as { error: string }).error).toMatch(/belongs to the factory/)
        }
    })

    it('refuses to delete a provider a routine names, unless forced', async () => {
        await put('look', { url: 'http://x', models: ['m'] })
        const file = await t.request(
            '/api/routines/nightly',
            json({ frontmatter: { cron: '0 3 * * *', provider: 'look' }, body: 'Write.' }, { method: 'PUT' })
        )
        expect(file.status).toBe(201)
        const list = (await (await t.request('/api/providers')).json()) as { providers: Array<{ used_by: string[] }> }
        expect(list.providers[0].used_by).toEqual(['⏱ nightly'])
        const refused = await t.request('/api/providers/look', { method: 'DELETE' })
        expect(refused.status).toBe(409)
        expect((await t.request('/api/providers/look?force=1', { method: 'DELETE' })).status).toBe(204)
        expect((await t.request('/api/providers/look', { method: 'DELETE' })).status).toBe(404)
        // The routine now points at a provider that is gone: invalid until fixed.
        const view = (await (await t.request('/api/routines/nightly/status')).json()) as { errors: string[] }
        expect(view.errors.join(' ')).toMatch(/provider "look"/)
    })

    it('sets a conversation on a provider and records it on the task', async () => {
        await put('look', { url: 'http://x', models: ['gemma4:12b', 'qwen3.5:9b'], default: 'gemma4:12b' })
        const created = await t.request('/api/conversations', json({ title: 'x' }, { method: 'POST' }))
        const conversation = (await created.json()) as Conversation
        const unknown = await t.request(
            `/api/conversations/${conversation.id}/model`,
            json({ provider: 'nope', model: null }, { method: 'PUT' })
        )
        expect(unknown.status).toBe(400)
        const set = await t.request(
            `/api/conversations/${conversation.id}/model`,
            json({ provider: 'look', model: 'qwen3.5:9b' }, { method: 'PUT' })
        )
        expect(set.status).toBe(200)
        expect((await set.json()) as Conversation).toMatchObject({ provider: 'look', model: 'qwen3.5:9b' })
        const { tasks } = t.ctx
        const task = tasks.submit(conversation.id, 'web', 'hello')
        expect(task).toMatchObject({ provider: 'look', model: 'qwen3.5:9b', agent: null })
        // Not while the task is queued or running; the fake CLI finishes it in a moment.
        expect(() => tasks.setConversationModel(conversation.id, null, 'opus')).toThrow(/running or queued/)
        await new Promise<void>((resolve) => {
            tasks.on('task', (updated) => {
                if (updated.id === task.id && updated.status !== 'queued' && updated.status !== 'running') resolve()
            })
        })
        // Back to the subscription with an alias; a bad alias is refused.
        expect(() => tasks.setConversationModel(conversation.id, null, 'gpt-9')).toThrow(/Unknown model/)
        const back = tasks.setConversationModel(conversation.id, null, 'opus')
        expect(back).toMatchObject({ provider: null, model: 'opus' })
        const again = tasks.submit(conversation.id, 'web', 'again')
        expect(again).toMatchObject({ provider: null, model: 'opus' })
    })

    it('builds the CLI environment for a provider without the subscription token', async () => {
        await put('look', { url: 'http://x', models: ['m'], small: 's', token: 'LOOK_KEY' })
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-secret')
        vi.stubEnv('LOOK_KEY', 'provider-secret')
        const { tasks, providers } = t.ctx
        const env = tasks.providerEnv(providers.get('look')!, 'm')
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
        expect(env.LOOK_KEY).toBeUndefined()
        expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8080/gateway/look')
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(tasks.gatewayToken('look'))
        expect(env).toMatchObject({
            ANTHROPIC_MODEL: 'm',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 's',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'm',
            CLAUDE_CODE_SUBAGENT_MODEL: 'm',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            // Output per call bounded for every provider; the window only when the file names one.
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000'
        })
        expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined()
        // The ordinary environment loses the provider's key too: the gateway adds it.
        expect(tasks.agentEnv().LOOK_KEY).toBeUndefined()
    })

    it("passes a provider's output and context limits to the CLI, and refuses ones out of range", async () => {
        const ok = await put('small', { url: 'http://x', models: ['m'], max_output: 4000, context: 65536 })
        expect(ok.status).toBe(200)
        const { tasks, providers } = t.ctx
        const env = tasks.providerEnv(providers.get('small')!, 'm')
        expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4000')
        expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('65536')
        const tooMuch = await put('small', { url: 'http://x', models: ['m'], max_output: 64_000 })
        expect(tooMuch.status).toBe(400)
        expect(((await tooMuch.json()) as { error: string }).error).toContain('max_output')
        const tiny = await put('small', { url: 'http://x', models: ['m'], context: 100 })
        expect(tiny.status).toBe(400)
    })

    it('refuses an MCP server named like a server of another layer', async () => {
        t.ctx.store.setMeta('claude.mcp.registry', {
            trac: { name: 'trac', status: 'connected', source: 'factory', seen_at: null },
            search: { name: 'search', status: 'connected', source: 'provider:box', seen_at: null }
        })
        const clash = await put('box', {
            url: 'http://box.test',
            models: ['m'],
            mcp: [{ name: 'trac', url: 'https://x/mcp' }]
        })
        expect(clash.status).toBe(400)
        expect(((await clash.json()) as { error: string }).error).toContain('already the factory server trac')
        // Its own server, seen in an earlier session, is no clash.
        const own = await put('box', {
            url: 'http://box.test',
            models: ['m'],
            mcp: [{ name: 'search', url: 'https://x/mcp' }]
        })
        expect(own.status).toBe(200)
    })

    it('guards the gateway with the per-start bearer and translates an OpenAI reply', async () => {
        await put('cloud', { kind: 'openai', url: 'http://cloud.test/v1', models: ['m'], token: 'CLOUD_KEY' })
        t.ctx.vault.set('CLOUD_KEY', { value: 'k', provider: true })
        const body = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }
        const noAuth = await t.request('/gateway/cloud/v1/messages', json(body, { method: 'POST' }))
        expect(noAuth.status).toBe(401)
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json({
                id: 'chatcmpl-1',
                choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 1 }
            })
        )
        const res = await t.request(
            '/gateway/cloud/v1/messages',
            json(body, { method: 'POST', headers: { authorization: `Bearer ${t.ctx.tasks.gatewayToken('cloud')}` } })
        )
        expect(res.status).toBe(200)
        expect((await res.json()) as object).toMatchObject({
            type: 'message',
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 }
        })
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('http://cloud.test/v1/chat/completions')
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
        expect(JSON.parse(init.body as string)).toMatchObject({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }]
        })
        // The count endpoint estimates without a model.
        const count = await t.request(
            '/gateway/cloud/v1/messages/count_tokens',
            json(body, { method: 'POST', headers: { authorization: `Bearer ${t.ctx.tasks.gatewayToken('cloud')}` } })
        )
        expect(((await count.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0)
        // The status knows the last request went through.
        const status = (await (await t.request('/api/status')).json()) as { providers: Array<{ ok: boolean | null }> }
        expect(status.providers[0].ok).toBe(true)
    })

    it('reads its key from a provider key of the vault, never from .env, and adds it in the gateway', async () => {
        vi.stubEnv('UNO_API_KEY', 'from-env')
        const saved = await put(
            'uno',
            {
                url: 'https://api.uno.test',
                models: ['m'],
                token: 'UNO_API_KEY',
                mcp: [{ name: 'unosearch', url: 'https://api.uno.test/mcp', token: 'UNO_SEARCH_TOKEN' }]
            },
            true
        )
        expect(saved.status).toBe(200)
        const missing = (await (await t.request('/api/providers')).json()) as {
            providers: Array<{ token_set: boolean }>
        }
        expect(missing.providers[0].token_set).toBe(false)

        // Settings → Secrets, access "model providers only".
        const key = await t.request(
            '/api/secrets/UNO_API_KEY?create=1',
            json({ value: 'sk-uno-1', provider: true }, { method: 'PUT' })
        )
        expect(key.status).toBe(200)
        const { providers, tasks } = t.ctx
        const list = (await (await t.request('/api/providers')).json()) as {
            providers: Array<{ token_set: boolean; mcp: Array<{ token_set: boolean }> }>
        }
        expect(list.providers[0]).toMatchObject({ token_set: true, mcp: [{ token_set: false }] })
        // No run gets it: not the agent's environment, not a provider task's.
        expect(tasks.agentEnv().UNO_API_KEY).toBeUndefined()
        expect(tasks.providerEnv(providers.get('uno')!, 'm').UNO_API_KEY).toBeUndefined()

        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }))
        await t.request(
            '/gateway/uno/v1/messages',
            json(
                { model: 'm', max_tokens: 5, messages: [] },
                { method: 'POST', headers: { authorization: `Bearer ${tasks.gatewayToken('uno')}` } }
            )
        )
        expect((fetch.mock.calls[0][1]!.headers as Record<string, string>)['x-api-key']).toBe('sk-uno-1')

        // The secrets list names the provider that reads it.
        const secrets = (await (await t.request('/api/secrets')).json()) as {
            entries: Array<{ name: string; provider?: true; used_by: Array<{ kind: string; name: string }> }>
        }
        expect(secrets.entries.find((e) => e.name === 'UNO_API_KEY')).toMatchObject({
            provider: true,
            used_by: [{ kind: 'provider', name: 'uno' }]
        })
    })

    it('names a provider once in the secrets list when its MCP servers share a token', async () => {
        t.ctx.vault.set('BOX_MCP_TOKEN', { value: 'mcp-token-1', provider: true })
        await put('box', {
            url: 'https://box.test',
            models: ['m'],
            mcp: [
                { name: 'search', url: 'https://box.test/mcp', token: 'BOX_MCP_TOKEN' },
                { name: 'reader', url: 'https://box.test/reader/mcp', token: 'BOX_MCP_TOKEN' }
            ]
        })
        const secrets = (await (await t.request('/api/secrets')).json()) as {
            entries: Array<{ name: string; used_by: Array<{ kind: string; name: string }> }>
        }
        expect(secrets.entries.find((e) => e.name === 'BOX_MCP_TOKEN')?.used_by).toEqual([
            { kind: 'provider', name: 'box' }
        ])
    })

    it("refuses a run's secret as a provider's key", async () => {
        t.ctx.vault.set('GSC_API_KEY', { value: 'run-secret-1', secret: true })
        const res = await put('gsc', { url: 'http://x', models: ['m'], token: 'GSC_API_KEY' })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toMatch(/not a provider key/)
        expect(t.ctx.providers.get('gsc')).toBeUndefined()
    })

    it('passes a Messages provider through with its key and reports an upstream failure', async () => {
        await put('box', { url: 'http://box.test', models: ['m'] })
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no such model', { status: 404 }))
        const res = await t.request(
            '/gateway/box/v1/messages',
            json(
                { model: 'm', max_tokens: 5, messages: [] },
                { method: 'POST', headers: { authorization: `Bearer ${t.ctx.tasks.gatewayToken('box')}` } }
            )
        )
        expect(res.status).toBe(404)
        const error = (await res.json()) as { type: string; error: { message: string } }
        expect(error.type).toBe('error')
        expect(error.error.message).toMatch(/no such model/)
        expect(t.ctx.tasks.providerStatus()[0].health).toMatchObject({ ok: false, requests: 1 })
    })

    it('gives each provider its own gateway bearer', async () => {
        await put('box', { url: 'http://box.test', models: ['m'] })
        await put('cloud', { url: 'http://cloud.test', models: ['m'], token: 'CLOUD_KEY' })
        const { tasks } = t.ctx
        expect(tasks.gatewayToken('box')).not.toBe(tasks.gatewayToken('cloud'))
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // A task on the free box cannot spend the cloud provider's key with its own bearer.
        const res = await t.request(
            '/gateway/cloud/v1/messages',
            json(
                { model: 'm', max_tokens: 5, messages: [] },
                { method: 'POST', headers: { authorization: `Bearer ${tasks.gatewayToken('box')}` } }
            )
        )
        expect(res.status).toBe(401)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('offers a provider its MCP servers through the gateway with their own key', async () => {
        await put('box', {
            url: 'http://box.test',
            models: ['m'],
            mcp: [{ name: 'search', url: 'https://box.test/mcp', token: 'BOX_MCP_TOKEN_TOKEN' }]
        })
        t.ctx.vault.set('BOX_MCP_TOKEN_TOKEN', { value: 'mcp-secret', provider: true })
        const { tasks, providers } = t.ctx
        const box = providers.get('box')!
        expect(providers.tokenVars()).toContain('BOX_MCP_TOKEN_TOKEN')
        expect(tasks.agentEnv().BOX_MCP_TOKEN_TOKEN).toBeUndefined()
        const config = JSON.parse(tasks.providerMcpConfig(box)!) as {
            mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
        }
        expect(config.mcpServers.search).toEqual({
            type: 'http',
            url: 'http://127.0.0.1:8080/gateway/box/mcp/search',
            headers: { Authorization: `Bearer ${tasks.gatewayToken('box')}` }
        })
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('event: message\ndata: {}\n\n', {
                headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1', 'x-other': 'no' }
            })
        )
        const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
        const noAuth = await t.request('/gateway/box/mcp/search', json(init, { method: 'POST' }))
        expect(noAuth.status).toBe(401)
        const res = await t.request(
            '/gateway/box/mcp/search',
            json(init, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${tasks.gatewayToken('box')}`,
                    accept: 'application/json, text/event-stream',
                    'mcp-protocol-version': '2025-06-18'
                }
            })
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('mcp-session-id')).toBe('sess-1')
        expect(res.headers.get('x-other')).toBeNull()
        expect(await res.text()).toContain('event: message')
        const [url, sent] = fetchSpy.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://box.test/mcp')
        const headers = sent.headers as Record<string, string>
        expect(headers.authorization).toBe('Bearer mcp-secret')
        expect(headers['mcp-protocol-version']).toBe('2025-06-18')
        expect(JSON.parse(new TextDecoder().decode(sent.body as ArrayBuffer))).toEqual(init)
        // A server the provider does not list is not proxied.
        const other = await t.request('/gateway/box/mcp/other', {
            method: 'GET',
            headers: { authorization: `Bearer ${tasks.gatewayToken('box')}` }
        })
        expect(other.status).toBe(404)
    })

    it('refuses an MCP server entry without a name or an http URL', async () => {
        const bad = await put('box', { url: 'http://box.test', models: ['m'], mcp: [{ name: 'a b', url: 'x' }] })
        expect(bad.status).toBe(400)
        const noUrl = await put('box', {
            url: 'http://box.test',
            models: ['m'],
            mcp: [{ name: 'search', url: 'ftp://x' }]
        })
        expect(noUrl.status).toBe(400)
        const secret = await put('box', {
            url: 'http://box.test',
            models: ['m'],
            mcp: [{ name: 'search', url: 'https://x/mcp', token: 'TELEGRAM_BOT_TOKEN' }]
        })
        expect(secret.status).toBe(400)
    })

    it('tests a provider with a tool-calling probe', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json({
                content: [{ type: 'tool_use', id: 'x', name: 'ping', input: { ok: true } }],
                stop_reason: 'tool_use'
            })
        )
        const res = await t.request(
            '/api/providers/test',
            json({ url: 'http://box.test', models: ['m'] }, { method: 'POST' })
        )
        expect((await res.json()) as object).toMatchObject({ ok: true, model: 'm', tool_calling: true })
        const missing = await t.request(
            '/api/providers/test',
            json({ url: 'http://box.test', models: ['m'], token: 'NOPE_KEY' }, { method: 'POST' })
        )
        const notSet = (await missing.json()) as { ok: boolean; error: string }
        expect(notSet.ok).toBe(false)
        expect(notSet.error).toMatch(/NOPE_KEY/)
    })

    it('fails a task whose provider is gone, before spawning anything', async () => {
        await put('look', { url: 'http://x', models: ['m'] })
        const { tasks, providers } = t.ctx
        const conversation = tasks.newConversation('web', null)
        tasks.setConversationModel(conversation.id, 'look', null)
        providers.remove('look')
        const task = tasks.submit(conversation.id, 'web', 'hello')
        const failed = await new Promise<Task>((resolve) => {
            tasks.on('task', (updated) => {
                if (updated.id === task.id && updated.status === 'failed') resolve(updated)
            })
        })
        expect(failed.error).toMatch(/not in providers.yaml/)
    })
})
