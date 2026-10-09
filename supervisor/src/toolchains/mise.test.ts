import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isMiseSpec, Mise } from './mise.js'

const LS = {
    go: [
        {
            version: '1.25.1',
            requested_version: '1.25.1',
            install_path: '/data/tools/mise/installs/go/1.25.1',
            installed: true,
            active: true,
            source: { type: 'idiomatic-version-file', path: '/data/workspaces/x/go.mod' }
        }
    ],
    node: [
        { version: '22.23.3', install_path: '/data/tools/mise/installs/node/22.23.3', installed: true, active: false },
        { version: '20.11.0', install_path: '/data/tools/mise/installs/node/20.11.0', installed: false, active: false }
    ]
}

const FAKE = `#!/bin/sh
case "$*" in
  "--version") echo "2026.10.6 linux-x64 (2026-10-09)" ;;
  "ls --installed --json"|"ls --current --json") cat "$(dirname "$0")/ls.json" ;;
  "install "*) echo "mise installed $2" ;;
  "uninstall "*) echo "mise removed $2" ;;
  "prune") echo "mise pruned 1 version" ;;
  *) echo "fake mise: $*" >&2; exit 1 ;;
esac
`

describe('Mise', () => {
    let dir: string
    let mise: Mise
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mise-'))
        fs.writeFileSync(path.join(dir, 'mise'), FAKE, { mode: 0o755 })
        fs.writeFileSync(path.join(dir, 'ls.json'), JSON.stringify(LS))
        mise = new Mise(path.join(dir, 'mise'))
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('answers null for a missing binary', async () => {
        expect(await new Mise(path.join(dir, 'nope')).version()).toBeNull()
    })

    it('lists the installed versions, newest first per tool, without the ones only requested', async () => {
        expect(await mise.version()).toBe('2026.10.6 linux-x64 (2026-10-09)')
        expect(await mise.installed()).toEqual([
            {
                tool: 'go',
                version: '1.25.1',
                install_path: '/data/tools/mise/installs/go/1.25.1',
                source: '/data/workspaces/x/go.mod',
                active: true
            },
            {
                tool: 'node',
                version: '22.23.3',
                install_path: '/data/tools/mise/installs/node/22.23.3',
                source: null,
                active: false
            }
        ])
    })

    it('reports what a checkout resolves to, installed or not', async () => {
        const current = await mise.current(dir)
        expect(current).toEqual([
            {
                tool: 'go',
                version: '1.25.1',
                requested: '1.25.1',
                installed: true,
                source: '/data/workspaces/x/go.mod'
            },
            { tool: 'node', version: '22.23.3', requested: '22.23.3', installed: true, source: null },
            { tool: 'node', version: '20.11.0', requested: '20.11.0', installed: false, source: null }
        ])
    })

    it('installs, removes and prunes through the CLI', async () => {
        expect(await mise.install('go@1.25.1')).toContain('installed go@1.25.1')
        expect(await mise.uninstall('go@1.25.1')).toContain('removed go@1.25.1')
        expect(await mise.prune()).toContain('pruned')
    })

    it('accepts tool and tool@version only', () => {
        expect(isMiseSpec('go')).toBe(true)
        expect(isMiseSpec('go@1.25.1')).toBe(true)
        expect(isMiseSpec('node@lts')).toBe(true)
        expect(isMiseSpec('go@1.25; rm -rf /')).toBe(false)
        expect(isMiseSpec('')).toBe(false)
        expect(isMiseSpec('Go')).toBe(false)
    })
})
