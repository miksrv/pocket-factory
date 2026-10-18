import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MASK, referencedNames, Vault, type VaultChange } from './vault.js'

describe('Vault', () => {
    let dir: string
    let vault: Vault
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-vault-'))
        vault = new Vault(path.join(dir, 'vault', 'secrets.json'), () => ['OPENAI_KEY'])
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('never shows a secret, shows a variable, and keeps the file owner-only', () => {
        vault.set('TRAC_PASSWORD', { value: 'hunter2-long', secret: true })
        vault.set('TRAC_URL', { value: 'https://trac.example.com', secret: false })
        expect(vault.list()).toEqual([
            expect.objectContaining({ name: 'TRAC_PASSWORD', secret: true, scope: { all: true } }),
            expect.objectContaining({ name: 'TRAC_URL', secret: false, value: 'https://trac.example.com' })
        ])
        expect(vault.list()[0]).not.toHaveProperty('value')
        expect(fs.statSync(vault.file).mode & 0o777).toBe(0o600)
        expect(fs.statSync(path.dirname(vault.file)).mode & 0o777).toBe(0o700)
    })

    it('keeps a secret value when only the scope changes, and refuses to turn it into a variable', () => {
        vault.set('TOKEN', { value: 'abcdef123', secret: true })
        vault.set('TOKEN', { scope: { all: false, routines: ['geo'], projects: [] } })
        expect(vault.envFor({ routine: 'geo' })).toEqual({ TOKEN: 'abcdef123' })
        expect(() => vault.set('TOKEN', { secret: false })).toThrow(/is a secret/)
        expect(() => vault.set('NEW', {})).toThrow(/value is required/)
    })

    it('refuses the factory own names, the shell start-up ones and a provider key', () => {
        for (const name of [
            'WEB_AUTH_PASSWORD',
            'PATH',
            'LD_PRELOAD',
            'CLAUDE_CONFIG_DIR',
            'ROUTINE_DIR',
            'OPENAI_KEY'
        ])
            expect(vault.refusal(name)).not.toBeNull()
        expect(vault.refusal('lower')).toMatch(/capital letters/)
        expect(vault.refusal('GSC_REFRESH_TOKEN')).toBeNull()
    })

    it('gives a run only what its routine or project may see', () => {
        vault.set('ALL', { value: 'everywhere', secret: false })
        vault.set('GEO', { value: 'geo-secret', secret: true, scope: { all: false, routines: ['geo'], projects: [] } })
        vault.set('WORK', { value: 'work-secret', secret: true, scope: { all: false, routines: [], projects: ['tm'] } })
        expect(vault.envFor()).toEqual({ ALL: 'everywhere' })
        expect(vault.envFor({ routine: 'geo' })).toEqual({ ALL: 'everywhere', GEO: 'geo-secret' })
        expect(vault.envFor({ routine: 'other', project: 'tm' })).toEqual({ ALL: 'everywhere', WORK: 'work-secret' })
        expect(vault.reaches('GEO', { routine: 'other' })).toBe(false)
    })

    it('masks secret values, not variables or short values, and each line of a key', () => {
        vault.set('PASS', { value: 'correct-horse', secret: true })
        vault.set('PIN', { value: '1234', secret: true })
        vault.set('URL', { value: 'https://visible.example', secret: false })
        vault.set('KEY', { value: '-----BEGIN-----\nAAAABBBBCCCC\n-----END-----', secret: true })
        expect(vault.redact('login with correct-horse at https://visible.example, pin 1234, AAAABBBBCCCC')).toBe(
            `login with ${MASK} at https://visible.example, pin 1234, ${MASK}`
        )
        expect(vault.hasSecrets()).toBe(true)
    })

    it('tells every change, never the value', () => {
        const changes: VaultChange[] = []
        vault.on('change', (c) => changes.push(c))
        vault.set('A_TOKEN', { value: 'secret-value', secret: true }, '10.0.0.5')
        vault.set('A_TOKEN', { value: 'other-value' })
        vault.remove('A_TOKEN')
        expect(changes).toEqual([
            { action: 'added', name: 'A_TOKEN', secret: true, from: '10.0.0.5' },
            { action: 'updated', name: 'A_TOKEN', secret: true, from: null },
            { action: 'deleted', name: 'A_TOKEN', secret: true, from: null }
        ])
        expect(JSON.stringify(changes)).not.toContain('value')
    })

    it('reads a change made by another process (the file is the truth)', () => {
        vault.set('X_VAR', { value: 'one', secret: false })
        const other = new Vault(vault.file)
        other.set('X_VAR', { value: 'two' })
        // mtime resolution: make sure the first instance sees a different stamp
        const later = new Date(Date.now() + 2000)
        fs.utimesSync(vault.file, later, later)
        expect(vault.get('X_VAR')?.value).toBe('two')
    })
})

describe('referencedNames', () => {
    it('finds $NAME and ${NAME}, not lowercase locals', () => {
        expect(referencedNames('curl -u "$TRAC_USER:${TRAC_PASSWORD}" $url ${SKILL_DIR}/x').sort()).toEqual([
            'SKILL_DIR',
            'TRAC_PASSWORD',
            'TRAC_USER'
        ])
    })
})
