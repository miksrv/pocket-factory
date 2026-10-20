import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    /** Resources whose `policy allow` fails, or answers without an id. */
    allowFails: Set<string>
    allowNoId: Set<string>
    rmFails: boolean
    createFails: boolean
    policyLs: string
    /** A `stop` waits for this when set. */
    stopGate: Promise<void> | null
}

function fakeSbx(): FakeSbx {
    const state: FakeSbx = {
        runner: null as unknown as SbxRunner,
        calls: [],
        sandboxes: [],
        approvals: '',
        allowFails: new Set(),
        allowNoId: new Set(),
        rmFails: false,
        createFails: false,
        policyLs: '{"rules":[]}',
        stopGate: null
    }
    let rule = 0
    state.runner = (args) => {
        state.calls.push(args)
        const [cmd, sub] = args
        const out = (stdout: string) => Promise.resolve({ stdout, stderr: '' })
        if (cmd === 'ls') return out(JSON.stringify(state.sandboxes))
        if (cmd === 'create') {
            if (state.createFails) return Promise.reject(new Error('no KVM'))
            state.sandboxes.push({ name: args[2], status: 'running' })
            return out('Created')
        }
        if (cmd === 'stop' && state.stopGate) return state.stopGate.then(() => ({ stdout: '', stderr: '' }))
        if (cmd === 'policy' && sub === 'allow') {
            const resource = args.at(-1) ?? ''
            if (state.allowFails.has(resource)) return Promise.reject(new Error(`cannot allow ${resource}`))
            if (state.allowNoId.has(resource)) return out('ok')
            return out(`Added rule 0000000${++rule}-aaaa to policy local`)
        }
        if (cmd === 'policy' && sub === 'rm' && state.rmFails) return Promise.reject(new Error('daemon busy'))
        if (cmd === 'policy' && sub === 'ls') return out(state.policyLs)
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
        // A name that collides with nothing keeps the sandbox it always had.
        expect(sandboxName('Shop_API v2')).toBe('pf-shop-api-v2')
        expect(sandboxName('UserManagement', ['UserManagement', 'shop'])).toBe('pf-usermanagement')
        expect(sandboxName('factory')).toBe('pf-factory-project')
        expect(sandboxName('my-app.v2')).toBe('pf-my-app.v2')
        expect(manager.projectOf('pf-shop')).toBe('shop')
        expect(manager.projectOf('pf-factory')).toBeNull()
    })

    it('never gives two project names one sandbox', () => {
        const names = ['my-app', 'my_app', 'My-App', 'factory', 'factory-project', 'a'.repeat(64), 'a'.repeat(63)]
        const sandboxes = names.map((n) => sandboxName(n, names))
        expect(new Set(sandboxes).size).toBe(names.length)
        // The name that is its own slug keeps it; the others get a hash of themselves.
        expect(sandboxName('my-app', names)).toBe('pf-my-app')
        expect(sandboxName('my_app', names)).toMatch(/^pf-my-app-[0-9a-f]{8}$/)
        expect(sandboxName('my_app', names)).toBe(sandboxName('my_app', [...names].reverse()))
        for (const s of sandboxes) expect(s).toMatch(/^pf-[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/)
        for (const s of sandboxes) expect(s.length).toBeLessThanOrEqual(63)
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
                `${config.paths.configRoot}:ro`,
                path.join(config.paths.configRoot, 'routines'),
                path.join(dataRoot, 'inbox')
            ])
        )
        // The supervisor trusts data/config (a project's path, a provider's URL): never writable inside.
        expect(create).not.toContain(config.paths.configRoot)
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

    it('refuses a project whose checkout is outside the workspaces, with nothing made', async () => {
        // The "checkout" is a link out of the workspaces to the data directory (the vault, the database).
        const shop = path.join(config.paths.workspacesRoot, 'shop')
        fs.rmSync(shop, { recursive: true })
        fs.symlinkSync(dataRoot, shop)
        await expect(manager.ensure('shop')).rejects.toThrow(/outside the workspaces/)
        expect(calls('create')).toHaveLength(0)
    })

    it('makes again a sandbox that still mounts data/config read-write, unless it is in use', async () => {
        const checkout = path.join(config.paths.workspacesRoot, 'shop')
        const old = { name: 'pf-shop', status: 'running', workspaces: [checkout, config.paths.configRoot] }
        sbx.sandboxes.push(old)
        const recreated: string[] = []
        manager.on('recreated', (name) => recreated.push(name))
        const end = manager.hold('pf-shop')
        await manager.ensure('shop')
        expect(calls('rm')).toHaveLength(0)
        end()
        // Past the listing's few seconds of trust.
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 10_000)
        await manager.ensure('shop')
        vi.useRealTimers()
        expect(calls('rm')).toHaveLength(1)
        expect(calls('create')).toHaveLength(1)
        expect(calls('create')[0]).toContain(`${config.paths.configRoot}:ro`)
        expect(recreated).toEqual(['pf-shop'])
    })

    it('gives a project one sandbox however a chat spells its name', () => {
        expect(manager.nameFor('Shop')).toBe('pf-shop')
        expect(manager.nameFor('shop')).toBe('pf-shop')
    })

    it('never makes again a sandbox of the new layout, however sbx spells its read-only mount', async () => {
        const checkout = path.join(config.paths.workspacesRoot, 'shop')
        const routines = path.join(config.paths.configRoot, 'routines')
        sbx.sandboxes.push({
            name: 'pf-shop',
            status: 'running',
            workspaces: [checkout, config.paths.configRoot, routines]
        })
        await manager.ensure('shop')
        expect(calls('rm')).toHaveLength(0)
        expect(calls('create')).toHaveLength(0)
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

    it('keeps the ids of rules added before a failure, and retries a removal that failed', async () => {
        sbx.allowFails.add('trac.example.com:443')
        await manager.ensure('shop')
        expect(store.getMeta('sandbox.rules.pf-shop')).toEqual({ 'localhost:8081': '00000001-aaaa' })
        sbx.allowFails.clear()
        network.shop = ['db.example.com:5432']
        await manager.ensure('shop')
        expect(store.getMeta('sandbox.rules.pf-shop')).toEqual({
            'localhost:8081': '00000001-aaaa',
            'db.example.com:5432': '00000002-aaaa'
        })
        sbx.rmFails = true
        network.shop = []
        await manager.ensure('shop')
        expect(store.getMeta('sandbox.rules.pf-shop')).toEqual({
            'localhost:8081': '00000001-aaaa',
            'db.example.com:5432': '00000002-aaaa'
        })
        sbx.rmFails = false
        await manager.ensure('shop')
        expect(store.getMeta('sandbox.rules.pf-shop')).toEqual({ 'localhost:8081': '00000001-aaaa' })
    })

    it('finds the id of a rule sbx added without naming it, and never adds such a rule twice', async () => {
        sbx.allowNoId.add('trac.example.com:443')
        network.shop = ['trac.example.com:443', 'db.example.com:5432']
        sbx.allowNoId.add('db.example.com:5432')
        sbx.policyLs = JSON.stringify({
            rules: [{ id: 'rule-trac', scope: 'sandbox', decision: 'allow', resources: ['trac.example.com:443'] }]
        })
        await manager.ensure('shop')
        expect(store.getMeta('sandbox.rules.pf-shop')).toEqual({
            'localhost:8081': '00000001-aaaa',
            'trac.example.com:443': 'rule-trac',
            'db.example.com:5432': '?'
        })
        await manager.ensure('shop')
        expect(calls('policy').filter((c) => c[1] === 'allow')).toHaveLength(3)
    })

    it('forgets the setup before a create, so a half-made sandbox is set up on the next run', async () => {
        store.setMeta('sandbox.setup.pf-shop', 1)
        store.setMeta('sandbox.rules.pf-shop', { 'localhost:8081': 'old' })
        sbx.createFails = true
        await expect(manager.ensure('shop')).rejects.toThrow(/could not create pf-shop: no KVM/)
        expect(store.getMeta('sandbox.setup.pf-shop')).toBeNull()
        expect(store.getMeta('sandbox.rules.pf-shop')).toEqual({})
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

    it("dismisses the CLI's telemetry and an address's cidr twin without asking the owner", async () => {
        // As sbx printed them for an `ssh -p 8692` to an address and a refused port of it.
        sbx.approvals = `APPROVAL       SANDBOX   TITLE                                     DETAIL                                                                    OPTIONS
network:dd     pf-shop   http-intake.logs.us5.datadoghq.com:443    Protocol: TCP Resource type: domain no matching allow rule (default deny)  allow (Allow), dismiss (Dismiss)
network:ip     pf-shop   95.105.109.25                             Protocol: TCP Resource type: cidr no matching allow rule (default deny)    allow (Allow), dismiss (Dismiss)
network:port   pf-shop   95.105.109.25:8443                        Protocol: TCP Resource type: domain no matching allow rule (default deny)  allow (Allow), dismiss (Dismiss)
`
        const seen: string[] = []
        manager.on('approval', (a) => seen.push(a.resource))
        const release = manager.hold('pf-shop')
        await manager.pollApprovals()
        release()
        expect(seen).toEqual(['95.105.109.25:8443'])
        expect(manager.approvals().map((a) => a.id)).toEqual(['network:port'])
        const dismissed = calls('policy')
            .map((c) => c.join(' '))
            .filter((c) => c.startsWith('policy approval respond'))
        expect(dismissed).toEqual([
            'policy approval respond network:dd --option dismiss',
            'policy approval respond network:ip --option dismiss'
        ])
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

    it('runs one idle pass at a time, and an ensure waits for a stop in flight', async () => {
        sbx.sandboxes.push({
            name: 'pf-shop',
            status: 'running',
            last_used_at: new Date(Date.now() - 3_600_000).toISOString()
        })
        let open = () => undefined as void
        sbx.stopGate = new Promise<void>((resolve) => (open = resolve))
        const first = manager.idleStop()
        await new Promise((resolve) => setTimeout(resolve, 10))
        await manager.idleStop()
        expect(calls('stop')).toHaveLength(1)
        let ensured = false
        const ensure = manager.ensure('shop').then(() => (ensured = true))
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(ensured).toBe(false)
        open()
        await first
        await ensure
        expect(calls('stop')).toHaveLength(1)
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
