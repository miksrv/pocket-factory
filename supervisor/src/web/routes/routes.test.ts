import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CatalogEntry } from '../../files/catalog.js'
import type { Conversation } from '../../store/index.js'
import { createTestApp, json, type TestApp } from '../../test/app.js'

/** Smoke tests of the read and file routes in open mode, through the whole middleware stack. */
describe('API routes (open mode)', () => {
    let t: TestApp

    beforeEach(() => {
        t = createTestApp()
    })

    afterEach(async () => {
        vi.useRealTimers()
        await t.cleanup()
    })

    const put = (url: string, body: unknown) => t.request(url, json(body, { method: 'PUT' }))

    describe('toolchains', () => {
        it('reports mise, the image and Docker, off or missing here', async () => {
            const res = await t.request('/api/toolchains')
            expect(res.status).toBe(200)
            const body = (await res.json()) as {
                mise: { tools: unknown[] }
                image: object
                docker: { enabled: boolean }
            }
            expect(Array.isArray(body.mise.tools)).toBe(true)
            expect(body.image).toHaveProperty('php')
            expect(body.docker).toHaveProperty('enabled')
            const status = (await (await t.request('/api/status')).json()) as { toolchains: object; mcp: object }
            expect(status.toolchains).toHaveProperty('docker')
            expect(status.mcp).toMatchObject({ total: 0, connected: 0, needs_auth: [], failed: [] })
        })

        it('refuses a spec that is not tool@version and an unknown project', async () => {
            const bad = await t.request('/api/toolchains/install', json({ spec: 'go@1; rm -rf /' }, { method: 'POST' }))
            expect(bad.status).toBe(400)
            expect(((await bad.json()) as { error: string }).error).toMatch(/not a tool spec/)
            expect((await t.request('/api/toolchains/projects/nope')).status).toBe(404)
        })
    })

    describe('GET /api/status', () => {
        it('reports the version, the stats and the environment', async () => {
            const res = await t.request('/api/status')
            expect(res.status).toBe(200)
            const body = (await res.json()) as Record<string, unknown>
            expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
            expect(body.stats).toMatchObject({
                queued: 0,
                running: 0,
                chat_unread: 0,
                chat_needs_reply: 0,
                chat_active: 0,
                schedules: { total: 0, on: 0, invalid: 0, failing: [], missed: [], next: null }
            })
            expect(body).toMatchObject({
                running: [],
                limits: null,
                claude: { version: '0.0.0 (Claude Code, fake)', model: 'sonnet', login: 'none', logged_in: false },
                telegram: { enabled: false, allowed_user_ids: [] },
                paths: { data: t.dataRoot },
                workspaces: []
            })
        })

        it('counts schedule files and names the next firing', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'))
            t.ctx.catalog.save('schedules', 'nightly', {
                frontmatter: { cron: '0 9 * * *', enabled: true, action: 'report' },
                body: 'Look around.'
            })
            const body = (await (await t.request('/api/status')).json()) as {
                stats: { schedules: { total: number; next: { name: string; at: string } | null } }
            }
            expect(body.stats.schedules.total).toBe(1)
            expect(body.stats.schedules.next).toEqual({ name: 'nightly', at: '2026-10-07T09:00:00.000Z' })
        })

        it('lists the workspaces with their git state', async () => {
            fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'repo', '.git'), { recursive: true })
            fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'plain'))
            fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, '.hidden'))
            const body = (await (await t.request('/api/status')).json()) as { workspaces: unknown[] }
            expect(body.workspaces).toEqual(
                expect.arrayContaining([
                    { name: 'repo', git: true },
                    { name: 'plain', git: false }
                ])
            )
            expect(body.workspaces).toHaveLength(2)
        })
    })

    describe('conversations', () => {
        const create = async (body: unknown = {}) => {
            const res = await t.request('/api/conversations', json(body))
            expect(res.status).toBe(201)
            return (await res.json()) as Conversation
        }

        it('creates, lists, reads and deletes a conversation', async () => {
            const created = await create({ title: 'First' })
            expect(created).toMatchObject({ channel: 'web', title: 'First', project: null, unread: false })

            const list = (await (await t.request('/api/conversations')).json()) as Conversation[]
            expect(list.map((c) => c.id)).toEqual([created.id])

            const read = await t.request(`/api/conversations/${created.id}`)
            expect(await read.json()).toMatchObject({ id: created.id, tasks: [], events: [], has_more: false })

            const del = await t.request(`/api/conversations/${created.id}`, { method: 'DELETE' })
            expect(del.status).toBe(204)
            expect((await t.request(`/api/conversations/${created.id}`)).status).toBe(404)
            expect(await (await t.request('/api/conversations')).json()).toEqual([])
        })

        it('binds a new conversation to a project whose checkout exists', async () => {
            fs.mkdirSync(path.join(t.ctx.config.paths.workspacesRoot, 'demo'))
            t.ctx.catalog.save('projects', 'demo', { frontmatter: {}, body: '' })
            expect(await create({ project: 'demo' })).toMatchObject({ project: 'demo' })
        })

        it.each([
            [{ project: 'nowhere' }, /unknown project/],
            [{ title: 5 }, /must be strings/]
        ])('refuses %j with 400', async (body, error) => {
            const res = await t.request('/api/conversations', json(body))
            expect(res.status).toBe(400)
            expect(((await res.json()) as { error: string }).error).toMatch(error)
        })

        it('refuses to delete a conversation with a queued task', async () => {
            const created = await create()
            t.ctx.store.createTask(created.id, 'web', 'pending')
            const res = await t.request(`/api/conversations/${created.id}`, { method: 'DELETE' })
            expect(res.status).toBe(409)
        })

        it('pages the list with before + before_id', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'))
            const ids = [await create(), await create(), await create()]
                .map((c) => c.id)
                .sort()
                .reverse()
            const first = (await (await t.request('/api/conversations?limit=2')).json()) as Conversation[]
            const last = first[first.length - 1]
            const second = (await (
                await t.request(
                    `/api/conversations?limit=2&before=${encodeURIComponent(last.updated_at)}&before_id=${last.id}`
                )
            ).json()) as Conversation[]
            expect([...first, ...second].map((c) => c.id)).toEqual(ids)
        })

        it('marks a conversation read', async () => {
            const created = await create()
            const task = t.ctx.store.createTask(created.id, 'web', 'x')
            t.ctx.store.updateTask(task.id, { status: 'done', finished_at: new Date(Date.now() - 1000).toISOString() })
            expect(t.ctx.store.getConversation(created.id)?.unread).toBe(true)
            const res = await t.request(`/api/conversations/${created.id}/read`, { method: 'POST' })
            expect(res.status).toBe(204)
            expect(t.ctx.store.getConversation(created.id)?.unread).toBe(false)
        })
    })

    describe('agent files', () => {
        it('creates, reads and lists an agent file', async () => {
            const res = await put('/api/agents/reviewer?create=1', {
                frontmatter: { description: 'Reviews code', model: 'sonnet' },
                body: 'You review.\n'
            })
            expect(res.status).toBe(201)
            const entry = (await res.json()) as CatalogEntry
            expect(entry).toMatchObject({
                kind: 'agents',
                name: 'reviewer',
                frontmatter: { description: 'Reviews code', model: 'sonnet', name: 'reviewer' }
            })
            // The file keeps a blank line after the frontmatter, which comes back at the start of the body.
            expect(entry.body.trim()).toBe('You review.')
            expect(fs.readFileSync(entry.path, 'utf8')).toMatch(/^---\n/)

            const read = (await (await t.request('/api/agents/reviewer')).json()) as CatalogEntry
            expect(read).toMatchObject({ name: 'reviewer', updated_at: entry.updated_at })
            const list = (await (await t.request('/api/agents')).json()) as CatalogEntry[]
            expect(list.map((e) => e.name)).toEqual(['reviewer'])
        })

        it('updates with the version it opened, and refuses a stale one with 409', async () => {
            const entry = (await (
                await put('/api/agents/reviewer', { frontmatter: {}, body: 'v1' })
            ).json()) as CatalogEntry
            const ok = await put('/api/agents/reviewer', { frontmatter: {}, body: 'v2', updated_at: entry.updated_at })
            expect(ok.status).toBe(200)

            // The agent edits the file on disk meanwhile.
            fs.utimesSync(entry.path, new Date(), new Date(Date.now() + 5000))
            const stale = await put('/api/agents/reviewer', {
                frontmatter: {},
                body: 'v3',
                updated_at: entry.updated_at
            })
            expect(stale.status).toBe(409)
            expect(await stale.json()).toMatchObject({ changed: true })
            expect(t.ctx.catalog.get('agents', 'reviewer').body.trim()).toBe('v2')
        })

        it('refuses ?create=1 for a file that exists', async () => {
            await put('/api/agents/reviewer', { frontmatter: {}, body: '' })
            const res = await put('/api/agents/reviewer?create=1', { frontmatter: {}, body: 'other' })
            expect(res.status).toBe(409)
        })

        it('refuses to save over invalid frontmatter on disk', async () => {
            const file = t.ctx.catalog.fileFor('agents', 'broken')
            fs.mkdirSync(path.dirname(file), { recursive: true })
            const original = '---\nname: [unclosed\n---\nBody\n'
            fs.writeFileSync(file, original)
            const read = (await (await t.request('/api/agents/broken')).json()) as CatalogEntry
            expect(read.frontmatter_error).toBeTruthy()
            const res = await put('/api/agents/broken', { frontmatter: { description: 'x' }, body: 'Body' })
            expect(res.status).toBe(409)
            expect(((await res.json()) as { error: string }).error).toMatch(/invalid YAML frontmatter/)
            expect(fs.readFileSync(file, 'utf8')).toBe(original)
        })

        it.each([
            [{ frontmatter: [] }, /frontmatter must be an object/],
            [{ frontmatter: 'x' }, /frontmatter must be an object/],
            [{ body: 5 }, /body must be a string/]
        ])('refuses the body %j with 400', async (body, error) => {
            const res = await put('/api/agents/reviewer', body)
            expect(res.status).toBe(400)
            expect(((await res.json()) as { error: string }).error).toMatch(error)
        })

        it.each(['%2E%2E%2Fsecrets', '..%2F..%2Fetc%2Fpasswd', '.hidden', 'a%20b', '-dash'])(
            'refuses the name %s with 400',
            async (name) => {
                const res = await put(`/api/agents/${name}`, { frontmatter: {}, body: 'x' })
                expect(res.status).toBe(400)
                expect(((await res.json()) as { error: string }).error).toMatch(/Invalid agents name/)
                expect((await t.request(`/api/agents/${name}`)).status).toBe(400)
            }
        )

        it('answers 404 for a missing file, and deletes one that exists', async () => {
            expect((await t.request('/api/agents/ghost')).status).toBe(404)
            expect((await t.request('/api/agents/ghost', { method: 'DELETE' })).status).toBe(404)
            await put('/api/agents/reviewer', { frontmatter: {}, body: '' })
            expect((await t.request('/api/agents/reviewer', { method: 'DELETE' })).status).toBe(204)
            expect(t.ctx.catalog.exists('agents', 'reviewer')).toBe(false)
        })
    })

    describe('GET /api/schedules/cron', () => {
        it('reads a valid expression back with the next firing', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'))
            const res = await t.request(`/api/schedules/cron?expr=${encodeURIComponent('*/15 * * * *')}`)
            expect(await res.json()).toEqual({
                ok: true,
                text: expect.stringContaining('every 15 min') as string,
                next: '2026-10-06T10:15:00.000Z',
                tz: 'UTC'
            })
        })

        it('reads the next firing in the given zone', async () => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'))
            const res = await t.request(
                `/api/schedules/cron?expr=${encodeURIComponent('0 9 * * *')}&tz=${encodeURIComponent('Europe/Warsaw')}`
            )
            // 09:00 in Warsaw (UTC+2 in October) has passed at 12:00 local: tomorrow 07:00 UTC.
            expect(await res.json()).toMatchObject({ ok: true, next: '2026-10-07T07:00:00.000Z', tz: 'Europe/Warsaw' })
        })

        it.each([
            ['', { ok: false, error: 'empty' }],
            ['61 * * * *', { ok: false }],
            ['not cron', { ok: false }]
        ])('reports %j as not ok', async (expr, expected) => {
            const res = await t.request(`/api/schedules/cron?expr=${encodeURIComponent(expr)}`)
            expect(res.status).toBe(200)
            expect(await res.json()).toMatchObject(expected)
        })

        it('reports an unknown time zone', async () => {
            const res = await t.request('/api/schedules/cron?expr=*+*+*+*+*&tz=Mars/Olympus')
            expect(await res.json()).toMatchObject({ ok: false, error: 'unknown time zone "Mars/Olympus"' })
        })

        it('is not taken for a schedule file name', async () => {
            const res = await t.request('/api/schedules/status')
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual([])
        })
    })
})
