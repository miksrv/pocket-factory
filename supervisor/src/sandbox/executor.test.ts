import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../store/db.js'
import { Store } from '../store/index.js'
import { testConfig } from '../test/app.js'
import { collect, killByMark, LaunchError, LocalExecutor, sandboxEnvNames, SbxExecutor } from './executor.js'
import { SandboxManager } from './manager.js'
import { Sbx, type SbxRunner } from './sbx.js'

/** `sbx exec [-i] [-t] [-u u] [-w dir] [-e NAME]… <sandbox> cmd…` run here: what the VM would run, in the same place. */
const FAKE_SBX = `#!/bin/sh
[ "$1" = exec ] || exit 2
shift
cwd=.
while [ $# -gt 0 ]; do
    case "$1" in
        -i|-t) shift ;;
        -u) shift 2 ;;
        -w) cwd=$2; shift 2 ;;
        -e) shift 2 ;;
        *) break ;;
    esac
done
shift
cd "$cwd" && exec "$@"
`

describe('executors', () => {
    let dir: string
    const close: Array<() => void> = []
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-exec-'))
    })
    afterEach(() => {
        for (const fn of close.splice(0)) fn()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("passes the work's variables into a sandbox and keeps the supervisor's own out", () => {
        const names = sandboxEnvNames({
            PATH: '/usr/bin',
            HOME: '/home/node',
            GH_TOKEN: 't',
            GH_TOKEN_ACME: 'a',
            CLAUDE_CONFIG_DIR: '/d/claude',
            ANTHROPIC_BASE_URL: 'http://x',
            PREVIEW_BASE: '/preview/shop/k/',
            PREVIEW_PORTS: '18100-18199',
            WEB_AUTH_PASSWORD: 'p',
            TELEGRAM_BOT_TOKEN: 'b',
            HTTPS_PROXY: 'http://proxy',
            LC_ALL: 'C',
            npm_config_cache: '/x',
            'BAD-NAME': 'x',
            UNSET: undefined
        })
        expect(names.sort()).toEqual([
            'ANTHROPIC_BASE_URL',
            'CLAUDE_CONFIG_DIR',
            'GH_TOKEN',
            'GH_TOKEN_ACME',
            'PREVIEW_BASE'
        ])
    })

    it('marks a stop by the exact run, or any run', () => {
        expect(killByMark('abc', 'SIGTERM')).toContain(`grep -qzE '^PF_RUN=abc$'`)
        expect(killByMark('abc', 'SIGTERM')).toContain('kill -TERM')
        expect(killByMark('*', 'SIGKILL')).toContain(`'^PF_RUN='`)
    })

    it('turns a program that is not there into a rejection, not a crash', async () => {
        await expect(
            collect(
                new LocalExecutor(),
                { argv: ['pf-no-such-program'], cwd: dir, env: process.env, project: null },
                10_000
            )
        ).rejects.toThrow(/ENOENT/)
        expect(killByMark('*', 'SIGKILL', true)).toContain('/comm" 2>/dev/null)" = claude ]')
    })

    it('runs locally in the cwd with the given environment', async () => {
        const run = await collect(
            new LocalExecutor(),
            { argv: ['sh', '-c', 'pwd; echo "$FOO"'], cwd: dir, env: { ...process.env, FOO: 'bar' }, project: null },
            10_000
        )
        expect(run.code).toBe(0)
        expect(run.stdout.trim().split('\n')).toEqual([fs.realpathSync(dir), 'bar'])
    })

    describe('in a sandbox', () => {
        let manager: SandboxManager
        let sbx: Sbx
        let created: string[]
        beforeEach(() => {
            const bin = path.join(dir, 'sbx')
            fs.writeFileSync(bin, FAKE_SBX, { mode: 0o755 })
            const config = testConfig(dir)
            config.sandbox.mode = 'sbx'
            fs.mkdirSync(config.paths.workspacesRoot, { recursive: true })
            const db = openDatabase(config.paths.dbFile)
            close.push(() => db.close())
            created = []
            const runner: SbxRunner = (args) => {
                if (args[0] === 'ls') return Promise.resolve({ stdout: '[]', stderr: '' })
                if (args[0] === 'create') created.push(args[2])
                if (args[0] === 'create' && args[2] === 'pf-broken')
                    return Promise.reject(new Error('sbx create: not signed in to Docker'))
                return Promise.resolve({ stdout: '', stderr: '' })
            }
            sbx = new Sbx({ bin, runner })
            manager = new SandboxManager(sbx, new Store(db), config, {
                projectPath: (slug) => (slug === 'broken' ? config.paths.workspacesRoot : null),
                projects: () => ['broken'],
                network: () => [],
                pinned: () => false,
                allowNetwork: () => undefined
            })
        })

        it('runs through `sbx exec` with the values in its environment, never on the command line', async () => {
            const executor = new SbxExecutor(sbx, manager)
            const run = await collect(
                executor,
                {
                    argv: ['sh', '-c', 'echo "$GH_TOKEN|$WEB_AUTH_PASSWORD|${PF_RUN:+marked}"; pwd'],
                    cwd: dir,
                    env: { GH_TOKEN: 'token-1', WEB_AUTH_PASSWORD: 'secret' },
                    project: null
                },
                10_000
            )
            const [vars, cwd] = run.stdout.trim().split('\n')
            expect(vars).toBe('token-1||marked')
            expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(dir))
            expect(created).toEqual(['pf-factory'])
            // The run is over: the sandbox counts nothing in flight.
            expect(manager.activeRuns('pf-factory')).toBe(0)
        })

        it('fails to launch with the reason when the sandbox cannot be made', async () => {
            const executor = new SbxExecutor(sbx, manager)
            await expect(
                executor.launch({ argv: ['true'], cwd: dir, env: {}, project: 'broken', stdin: 'ignore' })
            ).rejects.toThrow(LaunchError)
        })
    })
})
