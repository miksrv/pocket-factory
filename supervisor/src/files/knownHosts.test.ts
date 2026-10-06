import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BadName } from './catalog.js'
import { hostSpec, KnownHosts } from './knownHosts.js'

// A syntactically valid ed25519 public key blob: the type string and 32 random bytes.
function keyBlob(): string {
    const type = Buffer.from('ssh-ed25519')
    const key = crypto.randomBytes(32)
    const len = (n: number) => {
        const b = Buffer.alloc(4)
        b.writeUInt32BE(n)
        return b
    }
    return Buffer.concat([len(type.length), type, len(key.length), key]).toString('base64')
}

describe('hostSpec', () => {
    it.each([
        ['Example.COM', undefined, 'example.com'],
        ['example.com', '22', 'example.com'],
        ['example.com', '2222', '[example.com]:2222'],
        ['10.0.0.1', '', '10.0.0.1']
    ])('%s port %j → %s', (host, port, spec) => {
        expect(hostSpec(host, port)).toBe(spec)
    })
})

describe('KnownHosts', () => {
    let dir: string
    let file: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-known-'))
        file = path.join(dir, 'config', 'known_hosts')
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('copies a legacy file once, never over an existing one', () => {
        const legacy = path.join(dir, 'legacy')
        fs.writeFileSync(legacy, 'old\n')
        new KnownHosts(file, legacy)
        expect(fs.readFileSync(file, 'utf8')).toBe('old\n')
        fs.writeFileSync(legacy, 'newer\n')
        new KnownHosts(file, legacy)
        expect(fs.readFileSync(file, 'utf8')).toBe('old\n')
    })

    it('starts empty without a legacy file', async () => {
        const known = new KnownHosts(file, path.join(dir, 'missing'))
        expect(fs.existsSync(file)).toBe(false)
        expect(await known.has('example.com')).toBe(false)
    })

    it('trusts confirmed keys once, finds them and forgets them', async () => {
        const known = new KnownHosts(file)
        const key = keyBlob()
        await known.trust('Server.example.com', '2222', [`  [server.example.com]:2222 ssh-ed25519 ${key}  `], false)
        expect(fs.readFileSync(file, 'utf8')).toBe(`[server.example.com]:2222 ssh-ed25519 ${key}\n`)
        await known.trust('server.example.com', '2222', [`[server.example.com]:2222 ssh-ed25519 ${key}`], false)
        expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)

        expect(await known.has('server.example.com', '2222')).toBe(true)
        expect(await known.has('server.example.com')).toBe(false)

        await known.forget('server.example.com', '2222')
        expect(await known.has('server.example.com', '2222')).toBe(false)
        expect(fs.existsSync(`${file}.old`)).toBe(false)
        await expect(known.forget('server.example.com', '2222')).resolves.toBeUndefined()
    })

    it('replaces the keys of a reinstalled server', async () => {
        const known = new KnownHosts(file)
        const [oldKey, newKey, otherKey] = [keyBlob(), keyBlob(), keyBlob()]
        await known.trust('a.example.com', undefined, [`a.example.com ssh-ed25519 ${oldKey}`], false)
        await known.trust('b.example.com', undefined, [`b.example.com ssh-ed25519 ${otherKey}`], false)
        await known.trust('a.example.com', undefined, [`a.example.com ssh-ed25519 ${newKey}`], true)
        const text = fs.readFileSync(file, 'utf8')
        expect(text).not.toContain(oldKey)
        expect(text).toContain(newKey)
        expect(text).toContain(otherKey)
    })

    it('appends after a file that does not end with a newline', async () => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'other.example.com ssh-ed25519 AAAA')
        const key = keyBlob()
        await new KnownHosts(file).trust('a.example.com', undefined, [`a.example.com ssh-ed25519 ${key}`], false)
        expect(fs.readFileSync(file, 'utf8')).toBe(
            `other.example.com ssh-ed25519 AAAA\na.example.com ssh-ed25519 ${key}\n`
        )
    })

    it.each([
        ['another host', 'b.example.com ssh-ed25519 AAAA'],
        ['an unknown key type', 'a.example.com ssh-foo AAAA'],
        ['a bad key', 'a.example.com ssh-ed25519 not*base64'],
        ['a marker line', '@revoked a.example.com ssh-ed25519 AAAA'],
        ['too few fields', 'a.example.com ssh-ed25519'],
        ['the default port spelled out', '[a.example.com]:22 ssh-ed25519 AAAA']
    ])('refuses a line for %s', async (_, line) => {
        await expect(new KnownHosts(file).trust('a.example.com', undefined, [line], false)).rejects.toThrow(BadName)
        expect(fs.existsSync(file)).toBe(false)
    })

    it('refuses an empty list', async () => {
        await expect(new KnownHosts(file).trust('a.example.com', undefined, [], false)).rejects.toThrow(
            'no host keys to trust'
        )
    })
})
