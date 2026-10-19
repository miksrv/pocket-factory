import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config } from '../config.js'
import { openDatabase } from '../store/db.js'
import { Store } from '../store/index.js'
import { testConfig } from '../test/app.js'
import { SandboxManager } from './manager.js'
import { Previews } from './previews.js'
import { Sbx, SbxError, type SbxRunner } from './sbx.js'

describe('Previews in sandboxes', () => {
    let dir: string
    let config: Config
    let store: Store
    let calls: string[][]
    let busy: Set<number>
    let sandboxes: string[]
    let previews: Previews
    const close: Array<() => void> = []

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-prev-'))
        config = testConfig(dir)
        config.sandbox.mode = 'sbx'
        config.preview = {
            ports: [18100, 18102],
            bind: '172.17.0.1',
            upstreamHost: 'host.docker.internal',
            ttlMs: 3_600_000
        }
        config.web.publicUrl = 'https://mikserver'
        const db = openDatabase(config.paths.dbFile)
        close.push(() => db.close())
        store = new Store(db)
        calls = []
        busy = new Set([18100])
        sandboxes = ['pf-shop']
        const runner: SbxRunner = (args) => {
            calls.push(args)
            if (args[0] === 'ports' && args[2] === '--publish') {
                const port = Number(args[3].split(':')[1])
                if (busy.has(port)) return Promise.reject(new SbxError(`sbx ports: address already in use`))
            }
            if (args[0] === 'ls')
                return Promise.resolve({ stdout: JSON.stringify(sandboxes.map((name) => ({ name }))), stderr: '' })
            return Promise.resolve({ stdout: '', stderr: '' })
        }
        const sbx = new Sbx({ runner })
        const manager = new SandboxManager(sbx, store, config, {
            projectPath: () => dir,
            projects: () => ['shop'],
            network: () => [],
            pinned: (name) => previews.pinned(name),
            allowNetwork: () => undefined
        })
        previews = new Previews(store, config, sbx, manager)
    })

    afterEach(() => {
        for (const fn of close.splice(0)) fn()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('publishes on the first free host port of the range and replaces the earlier preview', async () => {
        const first = await previews.open('shop', 5173, { taskId: 't1' })
        expect(first).toMatchObject({
            sandbox: 'pf-shop',
            port: 5173,
            host_port: 18101,
            url: 'https://mikserver/preview/shop/'
        })
        expect(first.base).toMatch(/^\/preview\/shop\/[0-9a-f]{32}\/$/)
        expect(previews.upstream('shop')).toMatchObject({ host: 'host.docker.internal', port: 18101 })
        expect(previews.pinned('pf-shop')).toBe(true)
        await previews.open('shop', 3000)
        expect(calls.filter((c) => c[0] === 'ports').map((c) => c.slice(2).join(' '))).toEqual([
            '--publish 172.17.0.1:18100:5173',
            '--publish 172.17.0.1:18101:5173',
            '--unpublish 172.17.0.1:18101:5173',
            '--publish 172.17.0.1:18100:3000',
            '--publish 172.17.0.1:18101:3000'
        ])
        expect(previews.list()).toHaveLength(1)
    })

    it('ends a preview after its time and drops one whose sandbox is gone', async () => {
        const closed: string[] = []
        previews.on('closed', (p, reason) => closed.push(`${p.project}: ${reason}`))
        await previews.open('shop', 5173)
        await previews.expire(Date.now() + 2 * 3_600_000)
        expect(previews.get('shop')).toBeNull()
        await previews.open('shop', 5173)
        sandboxes = []
        await previews.reconcile()
        expect(previews.get('shop')).toBeNull()
        expect(closed).toEqual(['shop: open for 1 h', 'shop: its sandbox is gone'])
    })

    it('keeps the key until a reset rotates it', () => {
        const key = previews.key('shop')
        expect(previews.key('shop')).toBe(key)
        previews.rotate('shop')
        expect(previews.key('shop')).not.toBe(key)
    })
})
