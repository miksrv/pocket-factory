import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp, json, type TestApp } from '../../test/app.js'

/** A routine as a folder (ROUTINE.md + scripts + data), its steps' scripts and the vault, through the API. */
describe('routine folders and secrets', () => {
    let t: TestApp
    let routines: string

    beforeEach(() => {
        t = createTestApp()
        routines = path.join(t.dataRoot, 'config', 'routines')
        fs.mkdirSync(routines, { recursive: true })
    })
    afterEach(() => t.cleanup())

    const put = (url: string, body: unknown) => t.request(url, json(body, { method: 'PUT' }))
    const flat = (name: string, steps: string) =>
        fs.writeFileSync(path.join(routines, `${name}.md`), `---\nenabled: false\nsteps:\n${steps}\n---\n\nDo it.\n`)

    it('moves a flat routine into its folder with its first file, and keeps it working', async () => {
        flat('geo', '  - run: echo hi')
        expect(await (await t.request('/api/routines/geo/files')).json()).toEqual([])
        const saved = await put('/api/routines/geo/files/scripts/stats.sh', { text: '#!/usr/bin/env bash\necho 42\n' })
        expect(saved.status).toBe(200)
        expect(await saved.json()).toMatchObject({ path: 'scripts/stats.sh', exec: true, text: true })
        expect(fs.existsSync(path.join(routines, 'geo.md'))).toBe(false)
        expect(fs.readFileSync(path.join(routines, 'geo', 'ROUTINE.md'), 'utf8')).toContain('Do it.')
        const entry = (await (await t.request('/api/routines/geo')).json()) as { path: string; body: string }
        expect(entry.path).toBe(path.join(routines, 'geo', 'ROUTINE.md'))
        const list = (await (await t.request('/api/routines/status')).json()) as Array<{
            name: string
            errors: string[]
        }>
        expect(list).toEqual([expect.objectContaining({ name: 'geo', errors: [] })])
        // ROUTINE.md is the form's, never a file of the folder.
        expect((await put('/api/routines/geo/files/ROUTINE.md', { text: 'x' })).status).toBe(400)
        expect((await put('/api/routines/geo/files/..%2Fescape.sh', { text: 'x' })).status).toBe(400)
    })

    it('refuses a save over a file a run changed since it was opened, renames and deletes', async () => {
        flat('geo', '  - run: echo hi')
        await put('/api/routines/geo/files/data/queue.csv', { text: 'id,name\n1,a\n' })
        const opened = (await (await t.request('/api/routines/geo/files/data/queue.csv')).json()) as {
            text: string
            updated_at: string
        }
        expect(opened.text).toBe('id,name\n1,a\n')
        const later = new Date(Date.now() + 5000)
        fs.utimesSync(path.join(routines, 'geo', 'data', 'queue.csv'), later, later)
        const stale = await put('/api/routines/geo/files/data/queue.csv', { text: 'x', updated_at: opened.updated_at })
        expect(stale.status).toBe(409)
        const moved = await t.request(
            '/api/routines/geo/rename',
            json({ from: 'data/queue.csv', to: 'data/places.csv' })
        )
        expect(await moved.json()).toMatchObject({ path: 'data/places.csv' })
        const raw = await t.request('/api/routines/geo/files/data/places.csv?raw=1')
        expect(raw.headers.get('content-disposition')).toBe('attachment; filename="places.csv"')
        expect(raw.headers.get('content-security-policy')).toContain('sandbox')
        expect((await t.request('/api/routines/geo/files/data/places.csv', { method: 'DELETE' })).status).toBe(204)
        expect(fs.existsSync(path.join(routines, 'geo', 'data'))).toBe(false)
    })

    it('describes a step by its script header and says which of its variables a run gets', async () => {
        flat(
            'geo',
            '  - name: GSC\n    run: \'"${ROUTINE_DIR}/scripts/gsc.sh"\'\n  - trac:\n      url: https://trac.example/query?status=new'
        )
        await put('/api/routines/geo/files/scripts/gsc.sh', {
            text: '#!/usr/bin/env bash\n# Search Console for the page.\n# secrets: GSC_TOKEN\necho "$GSC_TOKEN $OTHER"\n'
        })
        await put('/api/secrets/GSC_TOKEN', {
            value: 'tok-123456',
            secret: true,
            scope: { all: false, routines: ['other'], projects: [] }
        })
        await put('/api/secrets/TRAC_USER', { value: 'me', secret: false })
        const view = (await (await t.request('/api/routines/geo/status')).json()) as {
            dir: string
            steps: Array<{ script?: { description: string; path: string; exists: boolean }; needs: unknown[] }>
        }
        expect(view.dir).toBe(path.join(routines, 'geo'))
        expect(view.steps[0].script).toMatchObject({
            scope: 'routine',
            path: 'scripts/gsc.sh',
            exists: true,
            description: 'Search Console for the page.'
        })
        expect(view.steps[0].needs).toEqual([{ name: 'GSC_TOKEN', from: null, out_of_scope: true, kind: 'secret' }])
        expect(view.steps[1].needs).toEqual([
            { name: 'TRAC_USER', from: 'variable', kind: 'variable' },
            { name: 'TRAC_PASSWORD', from: null, kind: 'secret' }
        ])
    })

    it('runs one step with the routine scoped secrets, masked in what comes back and in the run log', async () => {
        flat('geo', '  - name: hello\n    run: \'"${ROUTINE_DIR}/scripts/hi.sh"\'')
        await put('/api/routines/geo/files/scripts/hi.sh', {
            text: '#!/usr/bin/env bash\necho "token=$GEO_TOKEN dir=$ROUTINE_DIR"\n'
        })
        await put('/api/secrets/GEO_TOKEN', {
            value: 'geo-secret-42',
            secret: true,
            scope: { all: false, routines: ['geo'], projects: [] }
        })
        const res = await t.request('/api/routines/geo/steps/0/run', { method: 'POST' })
        const run = (await res.json()) as { ok: boolean; code: number; stdout: string }
        expect(run).toMatchObject({ ok: true, code: 0 })
        expect(run.stdout).toBe(`token=•••• dir=${path.join(routines, 'geo')}\n`)
        expect((await t.request('/api/routines/geo/steps/5/run', { method: 'POST' })).status).toBe(422)
        // A whole run keeps each step, masked.
        await t.request('/api/routines/geo/run', { method: 'POST' })
        const runs = (await (await t.request('/api/routines/geo/runs?all=1')).json()) as Array<{
            status: string
            note: string
            steps: Array<{ name: string; ok: boolean; log: string }>
        }>
        expect(runs[0].status).toBe('done')
        expect(runs[0].steps).toHaveLength(1)
        expect(runs[0].steps[0]).toMatchObject({ name: 'hello', ok: true })
        expect(runs[0].steps[0].log).toContain('token=••••')
        expect(JSON.stringify(runs)).not.toContain('geo-secret-42')
    })

    it('keeps a failed step and the ones before it in the run', async () => {
        flat(
            'geo',
            '  - name: one\n    run: echo first\n  - name: two\n    run: echo broke >&2; exit 4\n  - name: three\n    run: echo never'
        )
        await t.request('/api/routines/geo/run', { method: 'POST' })
        const [run] = (await (await t.request('/api/routines/geo/runs')).json()) as Array<{
            status: string
            steps: Array<{ name: string; ok: boolean; log: string }>
        }>
        expect(run.status).toBe('error')
        expect(run.steps.map((s) => [s.name, s.ok])).toEqual([
            ['one', true],
            ['two', false]
        ])
        expect(run.steps[1].log).toBe('broke')
    })

    it("shows what a skill's scripts read, on its page and on the agent step that applies it", async () => {
        const skill = path.join(t.dataRoot, 'claude', 'skills', 'publisher')
        fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true })
        fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: publisher\ndescription: x\n---\nDo.\n')
        fs.writeFileSync(
            path.join(skill, 'scripts', 'publish.sh'),
            '#!/usr/bin/env bash\n# Publish.\n# secrets: AUTHOR_PASSWORD\n# vars: AUTHOR_EMAIL\necho "$AUTHOR_EMAIL $HOME"\n'
        )
        flat('pub', '  - run: echo hi\n  - agent: orchestrator\n    skill: publisher')
        await put('/api/secrets/AUTHOR_EMAIL', {
            value: 'a@b.c',
            secret: false,
            scope: { all: false, routines: ['pub'], projects: [] }
        })
        const body = (await (await t.request('/api/secrets/skills/publisher')).json()) as {
            needs: Array<{ name: string; kind: string; files: string[]; reaches: string[]; entry: unknown }>
            routines: string[]
        }
        expect(body.routines).toEqual(['pub'])
        expect(body.needs).toEqual([
            expect.objectContaining({
                name: 'AUTHOR_EMAIL',
                kind: 'variable',
                files: ['scripts/publish.sh'],
                reaches: ['pub']
            }),
            expect.objectContaining({ name: 'AUTHOR_PASSWORD', kind: 'secret', entry: null, reaches: [] })
        ])
        const view = (await (await t.request('/api/routines/pub/status')).json()) as {
            steps: Array<{ needs: unknown[] }>
        }
        expect(view.steps[1].needs).toEqual([
            { name: 'AUTHOR_EMAIL', from: 'variable', kind: 'variable' },
            { name: 'AUTHOR_PASSWORD', from: null, kind: 'secret' }
        ])
        expect((await t.request('/api/secrets/skills/nope')).status).toBe(404)
    })

    describe('/api/secrets', () => {
        it('adds, lists without the value, refuses a duplicate and a reserved name, deletes', async () => {
            expect(
                (await put('/api/secrets/TRAC_PASSWORD?create=1', { value: 'pw-123456', secret: true })).status
            ).toBe(200)
            expect((await put('/api/secrets/TRAC_PASSWORD?create=1', { value: 'again', secret: true })).status).toBe(
                409
            )
            const bad = await put('/api/secrets/WEB_AUTH_PASSWORD', { value: 'x', secret: true })
            expect(bad.status).toBe(400)
            expect(((await bad.json()) as { error: string }).error).toMatch(/reserved/)
            expect((await put('/api/secrets/X', { value: 'x', scope: { all: 'yes' } })).status).toBe(400)
            const body = (await (await t.request('/api/secrets')).json()) as {
                entries: Array<Record<string, unknown>>
                routines: string[]
            }
            expect(body.entries).toEqual([
                expect.objectContaining({ name: 'TRAC_PASSWORD', secret: true, used_by: [] })
            ])
            expect(JSON.stringify(body)).not.toContain('pw-123456')
            expect((await t.request('/api/secrets/TRAC_PASSWORD', { method: 'DELETE' })).status).toBe(204)
            expect((await t.request('/api/secrets/TRAC_PASSWORD', { method: 'DELETE' })).status).toBe(404)
        })

        it('says which routine steps use a name', async () => {
            flat('tickets', '  - name: Trac\n    trac:\n      url: https://trac.example/query?status=new')
            await put('/api/secrets/TRAC_PASSWORD', { value: 'pw-123456', secret: true })
            const body = (await (await t.request('/api/secrets')).json()) as { entries: Array<{ used_by: unknown[] }> }
            expect(body.entries[0].used_by).toEqual([{ kind: 'routine', name: 'tickets', step: 'Trac' }])
        })
    })

    it('hands the vault values in scope to a chat task, masked in what is stored', async () => {
        await put('/api/secrets/SHARED_TOKEN', { value: 'shared-secret-1', secret: true })
        expect(t.ctx.tasks.agentEnv().SHARED_TOKEN).toBe('shared-secret-1')
        const conversation = t.ctx.store.createConversation('web', 'x', 'x')
        const task = t.ctx.store.createTask(conversation.id, 'web', 'my token is shared-secret-1')
        expect(t.ctx.store.getTask(task.id)?.prompt).toBe('my token is ••••')
    })
})
