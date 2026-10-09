import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectNeeds, lowestVersion, miseSpec, miseTomlVersion, versionSatisfies } from './detect.js'

describe('detectNeeds', () => {
    let root: string
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-detect-'))
    })
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

    const write = (rel: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
        fs.writeFileSync(path.join(root, rel), text)
    }

    it('reads a Go service with a Node client and a compose file, the way the owner lays repositories out', () => {
        write('server/go.mod', 'module x\n\ngo 1.24\n\ntoolchain go1.25.1\n')
        write('client/.nvmrc', 'v20.11.0\n')
        write('client/package.json', '{"engines":{"node":">=20"}}')
        write('docker-compose.yml', 'services:\n  db:\n    image: mysql:8\n  redis:\n    image: redis\n')
        write('config/docker-compose.yml', 'services:\n  app: {}\n')
        expect(detectNeeds(root)).toEqual({
            tools: [
                { tool: 'go', version: '1.25.1', source: 'server/go.mod' },
                { tool: 'node', version: '20.11.0', source: 'client/.nvmrc' }
            ],
            services: [
                { file: 'docker-compose.yml', services: ['db', 'redis'] },
                { file: 'config/docker-compose.yml', services: ['app'] }
            ]
        })
    })

    it('takes the go directive when there is no toolchain line, and composer.json for PHP', () => {
        write('go.mod', 'module x\n\ngo 1.25\n')
        write('server/composer.json', '{"require":{"php":"^8.2"}}')
        write('pyproject.toml', '[project]\nrequires-python = ">=3.11"\n')
        const { tools } = detectNeeds(root)
        expect(tools).toEqual([
            { tool: 'go', version: '1.25', source: 'go.mod' },
            { tool: 'python', version: '>=3.11', source: 'pyproject.toml' },
            { tool: 'php', version: '^8.2', source: 'server/composer.json' }
        ])
    })

    it('prefers mise.toml and .tool-versions, and the root over a subdirectory', () => {
        write('mise.toml', '[tools]\nnode = "22"\n')
        write('.tool-versions', 'golang 1.23.0\n')
        write('client/.nvmrc', '18\n')
        expect(detectNeeds(root).tools).toEqual([
            { tool: 'node', version: '22', source: 'mise.toml' },
            { tool: 'go', version: '1.23.0', source: '.tool-versions' }
        ])
    })

    it('reads the table and array forms of mise.toml and names the file it read', () => {
        write(
            '.mise.toml',
            '[tools]\npython = { version = "3.12", virtualenv = ".venv" }\nnode = ["20", "18"]\ngo = 1.25\n'
        )
        expect(detectNeeds(root).tools).toEqual([
            { tool: 'python', version: '3.12', source: '.mise.toml' },
            { tool: 'node', version: '20', source: '.mise.toml' },
            { tool: 'go', version: null, source: '.mise.toml' }
        ])
    })

    it('is empty for a missing or bare directory, and tolerates a broken compose file', () => {
        expect(detectNeeds(path.join(root, 'nope'))).toEqual({ tools: [], services: [] })
        write('compose.yaml', 'services: [not: a: map\n')
        expect(detectNeeds(root)).toEqual({ tools: [], services: [{ file: 'compose.yaml', services: [] }] })
    })
})

describe('versions', () => {
    it('lowestVersion takes the first version a range names', () => {
        expect(lowestVersion('^8.2')).toBe('8.2')
        expect(lowestVersion('>=20 <23')).toBe('20')
        expect(lowestVersion('~3.11.4')).toBe('3.11.4')
        expect(lowestVersion('lts')).toBeNull()
    })
    it('miseTomlVersion reads the quoted, array and table forms', () => {
        expect(miseTomlVersion('"22"')).toBe('22')
        expect(miseTomlVersion("['20', '18']")).toBe('20')
        expect(miseTomlVersion('{ version = "3.12", virtualenv = ".venv" }')).toBe('3.12')
        expect(miseTomlVersion('{ virtualenv = ".venv" }')).toBeNull()
        expect(miseTomlVersion('1.25')).toBeNull()
    })
    it('versionSatisfies reads composer / npm ranges against major.minor.patch', () => {
        expect(versionSatisfies('8.2.34', '^8.1')).toBe(true)
        expect(versionSatisfies('8.2.34', '>=8.1')).toBe(true)
        expect(versionSatisfies('8.2.34', '^8.3')).toBe(false)
        expect(versionSatisfies('8.2.34', '~8.1')).toBe(false)
        expect(versionSatisfies('8.2.34', '~8.2.0')).toBe(true)
        expect(versionSatisfies('8.2.34', '8.2.*')).toBe(true)
        expect(versionSatisfies('8.2.34', '8.1 || 8.2')).toBe(true)
        expect(versionSatisfies('8.2.34', '>=8.1 <8.2')).toBe(false)
        expect(versionSatisfies('8.2.34', '>=8.1, <9')).toBe(true)
        expect(versionSatisfies('8.2.34', '*')).toBe(true)
        expect(versionSatisfies('8.2.34', 'latest')).toBe(false)
    })
    it('miseSpec names tool@version, or the tool alone', () => {
        expect(miseSpec({ tool: 'php', version: '^8.2' })).toBe('php@8.2')
        expect(miseSpec({ tool: 'python', version: null })).toBe('python')
        expect(miseSpec({ tool: 'node', version: 'lts' })).toBe('node')
    })
})
