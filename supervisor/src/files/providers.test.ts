import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'

import { BadName, NotFound } from './catalog.js'
import { modelRef, parseModelRef, Providers } from './providers.js'

describe('parseModelRef', () => {
    it.each([
        ['', null, null],
        ['sonnet', null, 'sonnet'],
        ['claude-opus-5-5', null, 'claude-opus-5-5'],
        ['claude:opus', null, 'opus'],
        ['claude', null, null],
        ['lookatstars', null, 'lookatstars'],
        ['lookatstars:gemma4:12b', 'lookatstars', 'gemma4:12b'],
        [' gemini : gemini-2.5-pro ', 'gemini', 'gemini-2.5-pro']
    ])('%j → provider %j, model %j', (ref, provider, model) => {
        expect(parseModelRef(ref)).toEqual({ provider, model })
    })

    it('round-trips through modelRef', () => {
        expect(modelRef('lookatstars', 'gemma4:12b')).toBe('lookatstars:gemma4:12b')
        expect(modelRef('lookatstars', null)).toBe('lookatstars')
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
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('starts empty and saves a provider with defaults filled in', () => {
        expect(providers.all()).toEqual([])
        const saved = providers.save('lookatstars', {
            url: 'http://10.77.0.1:11434/',
            models: ['gemma4:12b', 'qwen3.5:9b'],
            concurrency: 1
        })
        expect(saved).toEqual({
            name: 'lookatstars',
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
        expect(providers.get('lookatstars')?.models).toEqual(['gemma4:12b', 'qwen3.5:9b'])
    })

    it('keeps the key out of the file and reads it from the environment', () => {
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
        expect(providers.key(p, {})).toBeNull()
        expect(providers.key(p, { GEMINI_API_KEY: 'secret' })).toBe('secret')
        expect(providers.tokenVars()).toEqual(['GEMINI_API_KEY'])
        const view = providers.list(() => 2, { GEMINI_API_KEY: 'secret' })
        expect(view.providers[0]).toMatchObject({ token_set: true, running: 2 })
        expect(providers.list(() => 0, {}).providers[0].token_set).toBe(false)
    })

    it.each([
        ['claude', { url: 'http://x', models: ['m'] }, /subscription/],
        ['bad name!', { url: 'http://x', models: ['m'] }, /Invalid provider name/],
        ['p', { url: 'ftp://x', models: ['m'] }, /http/],
        ['p', { url: 'http://x', models: [] }, /at least one model/],
        ['p', { url: 'http://x', models: ['a b'] }, /spaces/],
        ['p', { url: 'http://x', models: ['m'], token: 'sk-live-123' }, /NAME of an environment variable/],
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
})
