import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config } from '../config.js'
import { openDatabase } from '../store/db.js'
import { Store } from '../store/index.js'
import { testConfig } from '../test/app.js'
import { SandboxManager, sandboxName, type SandboxRefs } from './manager.js'
import { Sbx, type SbxRunner } from './sbx.js'

interface FakeSbx {
    runner: SbxRunner
    calls: string[][]
    /** Sandboxes `ls` reports; `create` adds one. */
    sandboxes: Array<{ name: string; status: string; last_used_at?: string; workspaces?: string[] }>
    approvals: string
}

function fakeSbx(): FakeSbx {
    const state: FakeSbx = { runner: null as unknown as SbxRunner, calls: [], sandboxes: [], approvals: '' }
    let rule = 0
    state.runner = (args) => {
        state.calls.push(args)
        const [cmd, sub] = args
        const out = (stdout: string) => Promise.resolve({ stdout, stderr: '' })
        if (cmd === 'ls') return out(JSON.stringify(state.sandboxes))
        if (cmd === 'create') {
            state.sandboxes.push({ name: args[2], status: 'running' })
            return out('Created')
        }
        if (cmd === 'policy' && sub === 'allow') return out(`Added rule 0000000${++rule}-aaaa to policy local`)
        if (cmd === 'policy' && sub === 'approval' && args[2] === 'ls') return out(state.approvals)
        if (cmd === 'version') return out('sbx version v0.48.0 abc')
        if (cmd === 'secret') return out('{"secrets":[{"name":"anthropic"}]}')
        if (cmd === 'diagnose') return out('{"checks":[{"name":"Authentication","status":"pass","message":"ok"}]}')
        return out('')
    }
    return state
}

describe('SandboxManager', () => {
    let dataRoot: string
    let config: Config
    let store: Store
    let sbx: FakeSbx
    let manager: SandboxManager
    let network: Record<string, string[]>
    let allowed: Array<[string, string]>
    const close: Array<() => void> = []

    beforeEach(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sbx-'))
        config = testConfig(dataRoot)
        config.sandbox.mode = 'sbx'
        config.sandbox.factoryUrl = 'http://host.docker.internal:8081'
        config.sandbox.idleMs = 60_000
        fs.mkdirSync(path.join(config.paths.workspacesRoot, 'shop'), { recursive: true })
        const db = openDatabase(config.paths.dbFile)
        close.push(() => db.close())
        store = new Store(db)
        sbx = fakeSbx()
        network = { shop: ['trac.example.com:443'] }
        allowed = []
        const refs: SandboxRefs = {
            projectPath: (slug) => (slug === 'shop' ? path.join(config.paths.workspacesRoot, 'shop') : null),
            projects: () => ['shop'],
            network: (project) => network[project ?? ''] ?? [],
            pinned: () => false,
            allowNetwork: (project, resource) => {
                allowed.push([project, resource])
                network[project] = [...(network[project] ?? []), resource]
            }
        }
        manager = new SandboxManager(new Sbx({ runner: sbx.runner }), store, config, refs)
    })

    afterEach(() => {
        manager.stop()
        for (const fn of close.splice(0)) fn()
        fs.rmSync(dataRoot, { recursive: true, force: true })
    })

    const calls = (cmd: string) => sbx.calls.filter((c) => c[0] === cmd)

    it('names sandboxes after projects the way sbx accepts them', () => {
        expect(sandboxName(null)).toBe('pf-factory')
        expect(sandboxName('Shop_API v2')).toBe('pf-shop-api-v2')
        expect(sandboxName('factory')).toBe('pf-factory-project')
        expect(manager.projectOf('pf-shop')).toBe('shop')
        expect(manager.projectOf('pf-factory')).toBeNull()
    })

    it('creates a project sandbox once, with the checkout and the data directories mounted at their paths', async () => {
        const [a, b] = await Promise.all([manager.ensure('shop'), manager.ensure('shop')])
        expect(a).toBe('pf-shop')
        expect(b).toBe('pf-shop')
        expect(calls('create')).toHaveLength(1)
        const create = calls('create')[0]
        expect(create).toEqual(
            expect.arrayContaining([
                path.join(config.paths.workspacesRoot, 'shop'),
                config.claude.configDir,
                config.paths.configRoot,
                path.join(dataRoot, 'inbox')
            ])
        )
        // Set up once: the wrappers' directory, git, the /data links.
        const setup = calls('exec').map((c) => c.join(' '))
        expect(setup.some((c) => c.includes('git config --global credential.https://github.com.helper'))).toBe(true)
        expect(setup.some((c) => c.includes(`sudo ln -sfn '${config.paths.configRoot}' /data/config`))).toBe(true)
        await manager.ensure('shop')
        expect(calls('create')).toHaveLength(1)
        expect(setup).toHaveLength(calls('exec').length)
    })

    it('starts a stopped sandbox itself, and refuses a directory it does not mount', async () => {
        const checkout = path.join(config.paths.workspacesRoot, 'shop')
        sbx.sandboxes.push({ name: 'pf-shop', status: 'stopped', workspaces: [checkout] })
        await manager.ensure('shop', checkout)
        expect(calls('exec').some((c) => c.join(' ') === 'exec pf-shop true')).toBe(true)
        await expect(manager.ensure('shop', '/elsewhere/shop')).rejects.toThrow(/does not mount \/elsewhere\/shop/)
    })

    it('refuses a project whose checkout is gone, with nothing made', async () => {
        await expect(manager.ensure('gone')).rejects.toThrow(/no checkout/)
        expect(calls('create')).toHaveLength(0)
    })

    it("allows the supervisor's port as localhost and the project's hosts, and drops what the file no longer names", async () => {
        await manager.ensure('shop')
        const allowCalls = () =>
            calls('policy')
                .filter((c) => c[1] === 'allow')
                .map((c) => c.at(-1))
        expect(allowCalls()).toEqual(['localhost:8081', 'trac.example.com:443'])
        expect(store.getMeta('sandbox.rules.pf-shop')).toEqual({
            'localhost:8081': '00000001-aaaa',
            'trac.example.com:443': '00000002-aaaa'
        })
        network.shop = []
        await manager.ensure('shop')
        expect(calls('policy').find((c) => c[1] === 'rm')).toEqual([
            'policy',
            'rm',
            'network',
            '--sandbox',
            'pf-shop',
            '--id',
            '00000002-aaaa',
            '--force'
        ])
        expect(allowCalls()).toHaveLength(2)
    })

    it("kills a previous supervisor's runs the first time it uses a running sandbox", async () => {
        sbx.sandboxes.push({ name: 'pf-shop', status: 'running' })
        await manager.ensure('shop')
        const kills = calls('exec').filter((c) => c.join(' ').includes('PF_RUN='))
        expect(kills).toHaveLength(1)
        expect(kills[0].join(' ')).toContain('kill -KILL')
        await manager.ensure('shop')
        expect(calls('exec').filter((c) => c.join(' ').includes('PF_RUN='))).toHaveLength(1)
    })

    it('surfaces a blocked request once, and an allow puts the host into the project file', async () => {
        sbx.approvals = `APPROVAL       SANDBOX   TITLE                  DETAIL        OPTIONS
network:abc    pf-shop   db.example.com:5432    Protocol: TCP allow (Allow), dismiss (Dismiss)
network:own    probe     example.com:443        Protocol: TCP allow (Allow), dismiss (Dismiss)
`
        const seen: string[] = []
        manager.on('approval', (a) => seen.push(`${a.project}:${a.resource}`))
        const release = manager.hold('pf-shop')
        await manager.pollApprovals()
        await manager.pollApprovals()
        release()
        // The owner's own sandboxes are not the factory's business.
        expect(seen).toEqual(['shop:db.example.com:5432'])
        await manager.decide('network:abc', true)
        expect(allowed).toEqual([['shop', 'db.example.com:5432']])
        expect(
            calls('policy').some((c) => c.join(' ') === 'policy allow network --sandbox pf-shop db.example.com:5432')
        ).toBe(true)
        expect(
            calls('policy').some((c) => c.join(' ') === 'policy approval respond network:abc --option dismiss')
        ).toBe(true)
        await expect(manager.decide('network:abc', true)).rejects.toThrow(/no longer pending/)
    })

    it('stops an idle sandbox, never a busy one', async () => {
        sbx.sandboxes.push(
            { name: 'pf-shop', status: 'running', last_used_at: new Date(Date.now() - 3_600_000).toISOString() },
            { name: 'pf-busy', status: 'running', last_used_at: new Date(Date.now() - 3_600_000).toISOString() },
            { name: 'probe', status: 'running', last_used_at: new Date(Date.now() - 3_600_000).toISOString() }
        )
        manager.hold('pf-busy')
        await manager.idleStop()
        expect(calls('stop')).toEqual([['stop', 'pf-shop']])
    })

    it('reports the daemon, the logins and the sandboxes from a background check', async () => {
        sbx.sandboxes.push({ name: 'pf-shop', status: 'stopped' }, { name: 'probe', status: 'running' })
        expect(manager.status().ok).toBeNull()
        await manager.refresh()
        expect(manager.status()).toMatchObject({
            mode: 'sbx',
            ok: true,
            version: 'v0.48.0',
            claude_login: true,
            docker_login: true,
            sandboxes: [{ name: 'pf-shop', project: 'shop', status: 'stopped', active: 0 }]
        })
    })

    it('refuses to reset a sandbox while it runs something', async () => {
        const release = manager.hold('pf-shop')
        await expect(manager.reset('pf-shop')).rejects.toThrow(/running a task/)
        release()
        await expect(manager.reset('probe')).rejects.toThrow(/not one of the factory's/)
        await manager.reset('pf-shop')
        expect(calls('rm')).toEqual([['rm', '--force', 'pf-shop']])
    })
})
