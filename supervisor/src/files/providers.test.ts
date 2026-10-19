import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'

import { BadName, NotFound } from './catalog.js'
import { modelRef, parseCa, parseModelRef, Providers } from './providers.js'

const fixture = (name: string) => fs.readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8')

describe('parseModelRef', () => {
    it.each([
        ['', null, null],
        ['sonnet', null, 'sonnet'],
        ['claude-opus-5-5', null, 'claude-opus-5-5'],
        ['claude:opus', null, 'opus'],
        ['claude', null, null],
        ['gpu-box', null, 'gpu-box'],
        ['gpu-box:gemma4:12b', 'gpu-box', 'gemma4:12b'],
        [' gemini : gemini-2.5-pro ', 'gemini', 'gemini-2.5-pro']
    ])('%j → provider %j, model %j', (ref, provider, model) => {
        expect(parseModelRef(ref)).toEqual({ provider, model })
    })

    it('round-trips through modelRef', () => {
        expect(modelRef('gpu-box', 'gemma4:12b')).toBe('gpu-box:gemma4:12b')
        expect(modelRef('gpu-box', null)).toBe('gpu-box')
        expect(modelRef(null, 'opus')).toBe('opus')
        expect(modelRef(null, null)).toBeNull()
    })
})

describe('Providers', () => {
    let dir: string
    let providers: Providers

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-providers-'))
        providers = new Providers(path.join(dir, 'config', 'providers.yaml'))
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('starts empty and saves a provider with defaults filled in', () => {
        expect(providers.all()).toEqual([])
        const saved = providers.save('gpu-box', {
            url: 'http://10.77.0.1:11434/',
            models: ['gemma4:12b', 'qwen3.5:9b'],
            concurrency: 1
        })
        expect(saved).toEqual({
            name: 'gpu-box',
            kind: 'anthropic',
            url: 'http://10.77.0.1:11434',
            models: ['gemma4:12b', 'qwen3.5:9b'],
            concurrency: 1,
            light: true
        })
        const onDisk = YAML.parse(fs.readFileSync(path.join(dir, 'config', 'providers.yaml'), 'utf8')) as {
            providers: unknown[]
        }
        expect(onDisk.providers).toHaveLength(1)
        expect(providers.get('gpu-box')?.models).toEqual(['gemma4:12b', 'qwen3.5:9b'])
    })

    it('keeps the key out of the file and reads it from the vault alone', () => {
        providers.save('gemini', {
            kind: 'openai',
            url: 'https://generativelanguage.googleapis.com/v1beta/openai',
            token: 'GEMINI_API_KEY',
            models: 'gemini-2.5-pro, gemini-2.5-flash' as unknown as string[],
            default: 'gemini-2.5-flash',
            concurrency: 0,
            light: false
        })
        const p = providers.get('gemini')!
        expect(p).toMatchObject({ kind: 'openai', token: 'GEMINI_API_KEY', default: 'gemini-2.5-flash', light: false })
        expect(p.models).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
        expect(fs.readFileSync(path.join(dir, 'config', 'providers.yaml'), 'utf8')).not.toContain('secret')
        // Keys come from the vault alone: .env is not read.
        vi.stubEnv('GEMINI_API_KEY', 'from-env')
        expect(providers.key(p)).toBeNull()
        expect(providers.list(() => 0).providers[0].token_set).toBe(false)
        const keys: Record<string, string> = { GEMINI_API_KEY: 'secret' }
        providers.useKeys((name) => keys[name] ?? null)
        expect(providers.key(p)).toBe('secret')
        expect(providers.tokenVars()).toEqual(['GEMINI_API_KEY'])
        expect(providers.list(() => 2).providers[0]).toMatchObject({ token_set: true, running: 2 })
    })

    it.each([
        ['claude', { url: 'http://x', models: ['m'] }, /subscription/],
        ['bad name!', { url: 'http://x', models: ['m'] }, /Invalid provider name/],
        ['p', { url: 'ftp://x', models: ['m'] }, /http/],
        ['p', { url: 'http://x', models: [] }, /at least one model/],
        ['p', { url: 'http://x', models: ['a b'] }, /spaces/],
        ['p', { url: 'http://x', models: ['m'], token: 'sk-live-123' }, /NAME of the key secret/],
        ['p', { url: 'http://x', models: ['m'], token: 'TELEGRAM_BOT_TOKEN' }, /belongs to the factory/],
        ['p', { url: 'http://x', models: ['m'], token: 'WEB_AUTH_PASSWORD' }, /belongs to the factory/],
        ['p', { url: 'http://x', models: ['m'], token: 'HOME' }, /ends with/],
        ['p', { url: 'http://x', models: ['m'], kind: 'grpc' as never }, /kind must be/],
        ['p', { url: 'http://x', models: ['m'], concurrency: -1 }, /concurrency/]
    ])('refuses %s %j', (name, input, message) => {
        expect(() => providers.save(name, input)).toThrow(BadName)
        expect(() => providers.save(name, input)).toThrow(message)
    })

    it('renames, refuses a taken name and removes', () => {
        providers.save('a', { url: 'http://a', models: ['m'] })
        providers.save('b', { url: 'http://b', models: ['m'] })
        expect(() => providers.save('a', { name: 'b', url: 'http://a', models: ['m'] })).toThrow(/already exists/)
        providers.save('a', { name: 'c', url: 'http://a', models: ['m'] })
        expect(providers.all().map((p) => p.name)).toEqual(['b', 'c'])
        providers.remove('b')
        expect(providers.all().map((p) => p.name)).toEqual(['c'])
        expect(() => providers.remove('b')).toThrow(NotFound)
    })

    it('reports an unreadable file and refuses to write over it', () => {
        fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'config', 'providers.yaml'), 'providers: [')
        expect(providers.list().error).toBeTruthy()
        expect(providers.all()).toEqual([])
        expect(() => providers.save('p', { url: 'http://x', models: ['m'] })).toThrow(/not valid YAML/)
    })

    it("trusts a provider's own CA, follows a rename and forgets it with the provider", () => {
        const ca = fixture('test-ca.pem')
        const trusted = () => tls.getCACertificates('default').some((c) => c.includes(ca.split('\n')[1]))
        providers.save('box', { url: 'https://203.0.113.10:8443', models: ['m'], ca: `junk before\n${ca}` })
        expect(providers.list().providers[0].ca).toMatchObject({ subject: 'CN=Test Box Root' })
        expect(fs.existsSync(path.join(dir, 'config', 'certs', 'box.pem'))).toBe(true)
        expect(trusted()).toBe(true)
        // Saved without `ca`: kept, and a rename takes it along.
        providers.save('box', { name: 'box2', url: 'https://203.0.113.10:8443', models: ['m'] })
        expect(providers.ca('box')).toBeNull()
        expect(providers.ca('box2')?.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
        // `ca: null` removes it; so does deleting the provider.
        providers.save('box2', { url: 'https://203.0.113.10:8443', models: ['m'], ca: null })
        expect(providers.ca('box2')).toBeNull()
        expect(trusted()).toBe(false)
        providers.save('box2', { url: 'https://203.0.113.10:8443', models: ['m'], ca })
        providers.remove('box2')
        expect(trusted()).toBe(false)
    })

    it('refuses a private key, a server certificate and garbage as a CA', () => {
        expect(() => parseCa('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toThrow(/private key/)
        expect(() => parseCa(fixture('test-leaf.pem'))).toThrow(/server's own certificate/)
        expect(() => parseCa('hello')).toThrow(BadName)
        expect(() => providers.save('box', { url: 'https://x', models: ['m'], ca: 'hello' })).toThrow(BadName)
        expect(providers.all()).toEqual([])
    })

    it('tolerates odd fields in a hand-written file', () => {
        fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
        fs.writeFileSync(
            path.join(dir, 'config', 'providers.yaml'),
            YAML.stringify({
                providers: [
                    { name: 'x', url: 'http://x/', models: 'one,two', concurrency: 'many', light: 'yes' },
                    { name: 'no-url' },
                    'junk'
                ]
            })
        )
        expect(providers.all()).toEqual([
            { name: 'x', kind: 'anthropic', url: 'http://x', models: ['one', 'two'], concurrency: 1, light: true }
        ])
    })

    it('keeps max_output and context within their bounds: saved as whole numbers, out of range refused or dropped', () => {
        const saved = providers.save('box', {
            url: 'http://x',
            models: ['m'],
            max_output: 4000.7,
            context: '65536' as never
        })
        expect(saved).toMatchObject({ max_output: 4000, context: 65536 })
        expect(() => providers.save('box', { url: 'http://x', models: ['m'], max_output: 0 })).toThrow(BadName)
        expect(() => providers.save('box', { url: 'http://x', models: ['m'], context: 4096 })).toThrow(BadName)
        // Hand-written nonsense is dropped on read, not fatal.
        fs.writeFileSync(
            path.join(dir, 'config', 'providers.yaml'),
            YAML.stringify({
                providers: [{ name: 'x', url: 'http://x', models: ['m'], max_output: 'lots', context: 10 }]
            })
        )
        expect(providers.all()[0]).toEqual({
            name: 'x',
            kind: 'anthropic',
            url: 'http://x',
            models: ['m'],
            concurrency: 1,
            light: true
        })
    })
})
