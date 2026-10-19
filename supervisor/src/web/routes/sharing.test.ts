import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readZip, writeZip } from '../../sharing/zip.js'
import { createTestApp, json, type TestApp } from '../../test/app.js'

interface Preview {
    title: string | null
    items: Array<{
        kind: string
        name: string
        exists: boolean
        files: string[]
        needs: Array<{ name: string; secret: boolean; set: boolean }>
        errors: string[]
        notes: string[]
    }>
    ignored: string[]
    ignored_count: number
}

/** Export and import through the API: a ZIP in the preset layout, secrets never in it, routines arrive off. */
describe('sharing', () => {
    let t: TestApp
    let claude: string
    let config: string

    const write = (file: string, text: string, mode = 0o644) => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, text, { mode })
    }

    beforeEach(() => {
        t = createTestApp()
        claude = path.join(t.dataRoot, 'claude')
        config = path.join(t.dataRoot, 'config')
        write(
            path.join(claude, 'agents', 'reviewer.md'),
            '---\nname: reviewer\ndescription: Reviews.\n---\n\nYou review.\n'
        )
        write(
            path.join(claude, 'skills', 'triage', 'SKILL.md'),
            '---\nname: triage\ndescription: Triage.\n---\n\nSort.\n'
        )
        write(
            path.join(claude, 'skills', 'triage', 'scripts', 'fetch.sh'),
            '#!/bin/sh\n# Fetch tickets.\n# secrets: TRIAGE_TOKEN\n# vars: TRIAGE_URL\ncurl -H "token: tok-very-secret-1" "$TRIAGE_URL"\n',
            0o755
        )
        write(
            path.join(config, 'routines', 'nightly', 'ROUTINE.md'),
            '---\nname: nightly\nenabled: true\ntriggers:\n  - schedule: "0 9 * * *"\nsteps:\n  - run: "${ROUTINE_DIR}/scripts/count.sh"\n  - agent: reviewer\n    skill: triage\n---\n\nLook and report.\n'
        )
        write(path.join(config, 'routines', 'nightly', 'scripts', 'count.sh'), '#!/bin/sh\necho 1\n', 0o755)
        write(path.join(config, 'routines', 'nightly', 'data', 'notes.md'), 'private notes\n')
    })
    afterEach(() => t.cleanup())

    const exportZip = async (body: unknown) => {
        const res = await t.request('/api/share/export', json(body))
        expect(res.status).toBe(200)
        return { res, entries: readZip(Buffer.from(await res.arrayBuffer())) }
    }
    const importFile = (bytes: Buffer, query: string) =>
        t.request(`/api/share/import?${query}`, { method: 'POST', body: new Uint8Array(bytes) })

    it('exports a routine with its agent and skill, scripts executable, without data/, secrets masked', async () => {
        await t.request(
            '/api/secrets/TRIAGE_TOKEN',
            json({ value: 'tok-very-secret-1', secret: true, scope: { all: true } }, { method: 'PUT' })
        )
        const { res, entries } = await exportZip({ routines: ['nightly'] })
        expect(res.headers.get('content-disposition')).toContain('pocket-factory-export.zip')
        expect(res.headers.get('x-masked-files')).toBe('1')
        expect(entries.map((e) => e.path)).toEqual([
            'preset.json',
            'README.md',
            'agents/reviewer.md',
            'skills/triage/SKILL.md',
            'skills/triage/scripts/fetch.sh',
            'routines/nightly/ROUTINE.md',
            'routines/nightly/scripts/count.sh'
        ])
        const byPath = Object.fromEntries(entries.map((e) => [e.path, e]))
        expect(byPath['skills/triage/scripts/fetch.sh'].exec).toBe(true)
        expect(byPath['skills/triage/scripts/fetch.sh'].bytes.toString()).toContain('token: ••••')
        expect(byPath['skills/triage/scripts/fetch.sh'].bytes.toString()).not.toContain('tok-very-secret-1')
        const readme = byPath['README.md'].bytes.toString()
        expect(readme).toContain('`TRIAGE_TOKEN` (secret)')
        expect(readme).toContain('`TRIAGE_URL` (variable)')
        expect(JSON.parse(byPath['preset.json'].bytes.toString())).toMatchObject({ title: 'Pocket Factory export' })

        const alone = await exportZip({ routines: ['nightly'], with_deps: false, with_data: true })
        expect(alone.entries.map((e) => e.path)).toEqual([
            'preset.json',
            'README.md',
            'routines/nightly/ROUTINE.md',
            'routines/nightly/data/notes.md',
            'routines/nightly/scripts/count.sh'
        ])
        expect(alone.res.headers.get('content-disposition')).toContain('nightly.zip')
    })

    it('refuses an empty export and a name that does not exist', async () => {
        expect((await t.request('/api/share/export', json({}))).status).toBe(400)
        expect((await t.request('/api/share/export', json({ skills: ['nope'] }))).status).toBe(404)
    })

    it('previews and installs an export on another factory: chosen items only, the routine switched off', async () => {
        const { entries } = await exportZip({ routines: ['nightly'] })
        const zip = writeZip(entries)
        // The other factory: an empty volume.
        const other = createTestApp()
        try {
            const preview = (await (
                await other.request('/api/share/import?file=kit.zip', { method: 'POST', body: new Uint8Array(zip) })
            ).json()) as Preview
            expect(preview.items.map((i) => [`${i.kind}/${i.name}`, i.exists, i.errors])).toEqual([
                ['agents/reviewer', false, []],
                ['skills/triage', false, []],
                ['routines/nightly', false, []]
            ])
            expect(preview.items[1].needs).toEqual([
                { name: 'TRIAGE_TOKEN', secret: true, set: false },
                { name: 'TRIAGE_URL', secret: false, set: false }
            ])
            expect(preview.items[2].notes).toEqual(['arrives switched off'])

            const res = await other.request('/api/share/import?file=kit.zip&install=skills/triage,routines/nightly', {
                method: 'POST',
                body: new Uint8Array(zip)
            })
            expect(await res.json()).toEqual({
                installed: [
                    { kind: 'skills', name: 'triage' },
                    { kind: 'routines', name: 'nightly' }
                ]
            })
            const otherClaude = path.join(other.dataRoot, 'claude')
            const otherConfig = path.join(other.dataRoot, 'config')
            expect(fs.existsSync(path.join(otherClaude, 'agents', 'reviewer.md'))).toBe(false)
            const script = path.join(otherClaude, 'skills', 'triage', 'scripts', 'fetch.sh')
            expect(fs.statSync(script).mode & 0o111).not.toBe(0)
            const routine = fs.readFileSync(path.join(otherConfig, 'routines', 'nightly', 'ROUTINE.md'), 'utf8')
            expect(routine).toContain('enabled: false')
            expect(routine).toContain('Look and report.')
            // Without the agent, the preview of the same file now says so.
            const again = (await (
                await other.request('/api/share/import?file=kit.zip', {
                    method: 'POST',
                    body: new Uint8Array(writeZip(entries.filter((e) => !e.path.startsWith('agents/'))))
                })
            ).json()) as Preview
            expect(again.items.find((i) => i.kind === 'routines')).toMatchObject({
                exists: true,
                notes: ['arrives switched off', 'agent “reviewer” is not here: pick one after the import']
            })
        } finally {
            await other.cleanup()
        }
    })

    it('replaces an existing item it was asked to, keeping the files the bundle does not bring', async () => {
        const zip = writeZip([
            {
                path: 'routines/nightly/ROUTINE.md',
                bytes: Buffer.from('---\nsteps:\n  - run: echo 2\n---\n\nNew.\n'),
                exec: false
            },
            { path: 'routines/nightly/scripts/count.sh', bytes: Buffer.from('#!/bin/sh\necho 2\n'), exec: true }
        ])
        const preview = (await (await importFile(zip, 'file=x.zip')).json()) as Preview
        expect(preview.items).toMatchObject([{ kind: 'routines', name: 'nightly', exists: true }])
        expect((await importFile(zip, 'file=x.zip&install=routines/nightly')).status).toBe(200)
        const dir = path.join(config, 'routines', 'nightly')
        expect(fs.readFileSync(path.join(dir, 'ROUTINE.md'), 'utf8')).toContain('New.')
        expect(fs.readFileSync(path.join(dir, 'scripts', 'count.sh'), 'utf8')).toContain('echo 2')
        expect(fs.readFileSync(path.join(dir, 'data', 'notes.md'), 'utf8')).toBe('private notes\n')
        expect((await importFile(zip, 'file=x.zip&install=skills/nope')).status).toBe(400)
    })

    it('imports one Markdown file as a skill folder, or as an agent', async () => {
        const md = Buffer.from('---\nname: writer\ndescription: Writes things.\n---\n\nWrite.\n')
        const preview = (await (await importFile(md, 'file=writer.md')).json()) as Preview
        expect(preview.items).toMatchObject([{ kind: 'skills', name: 'writer', exists: false, errors: [] }])
        expect((await importFile(md, 'file=writer.md&install=skills/writer')).status).toBe(200)
        expect(fs.readFileSync(path.join(claude, 'skills', 'writer', 'SKILL.md'), 'utf8')).toContain('Write.')
        expect((await importFile(md, 'file=writer.md&as=agents&install=agents/writer')).status).toBe(200)
        expect(fs.existsSync(path.join(claude, 'agents', 'writer.md'))).toBe(true)
    })

    it('refuses an archive with an unsafe path, and one with nothing to import', async () => {
        const traversal = writeZip([{ path: 'a/../../etc', bytes: Buffer.from('x'), exec: false }])
        const res = await importFile(traversal, 'file=evil.zip')
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toContain('unsafe path')
        const empty = await importFile(
            writeZip([{ path: 'readme.txt', bytes: Buffer.from('hi'), exec: false }]),
            'file=e.zip'
        )
        expect(empty.status).toBe(400)
        expect((await importFile(Buffer.alloc(0), 'file=e.zip')).status).toBe(400)
    })

    it('installs a preset with a routine switched off', async () => {
        const preset = path.join(t.dataRoot, 'presets', 'kit')
        write(path.join(preset, 'preset.json'), '{"title":"Kit","description":"A kit"}')
        write(path.join(preset, 'routines', 'weekly', 'ROUTINE.md'), '---\nsteps:\n  - run: echo\n---\n\nGo.\n')
        write(path.join(preset, 'skills', 'helper', 'SKILL.md'), '---\ndescription: Helps.\n---\n\nHelp.\n')
        write(path.join(preset, 'skills', 'helper', 'bin', 'tool.sh'), '#!/bin/sh\n', 0o755)
        const list = (await (await t.request('/api/presets')).json()) as Array<{ name: string; files: unknown[] }>
        expect(list.find((p) => p.name === 'kit')?.files).toEqual([
            { kind: 'skills', name: 'helper', description: 'Helps.', installed: false },
            { kind: 'routines', name: 'weekly', description: null, installed: false }
        ])
        const res = await t.request('/api/presets/kit/install', json({}))
        expect(((await res.json()) as { installed: unknown[] }).installed).toHaveLength(2)
        expect(fs.readFileSync(path.join(config, 'routines', 'weekly', 'ROUTINE.md'), 'utf8')).toContain(
            'enabled: false'
        )
        expect(fs.statSync(path.join(claude, 'skills', 'helper', 'bin', 'tool.sh')).mode & 0o111).not.toBe(0)
    })
})
