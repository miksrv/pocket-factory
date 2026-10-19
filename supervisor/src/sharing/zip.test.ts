import zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { isZip, readZip, writeZip, ZipError } from './zip.js'

/** A one-entry archive written by hand, to say what a foreign tool might put in one. */
function handmade(name: string, content: Buffer, options: { mode?: number; size?: number; flags?: number } = {}) {
    const zip = writeZip([{ path: 'x', bytes: content, exec: false }])
    const nameBytes = Buffer.from(name)
    const localEnd = 30 + 1 + zip.readUInt32LE(18)
    const local = Buffer.concat([zip.subarray(0, 30), nameBytes, zip.subarray(31, localEnd)])
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.concat([zip.subarray(localEnd, localEnd + 46), nameBytes])
    central.writeUInt16LE(nameBytes.length, 28)
    if (options.mode !== undefined) central.writeUInt32LE((options.mode << 16) >>> 0, 38)
    if (options.size !== undefined) central.writeUInt32LE(options.size, 24)
    if (options.flags !== undefined) central.writeUInt16LE(options.flags, 8)
    const end = Buffer.from(zip.subarray(zip.length - 22))
    end.writeUInt32LE(central.length, 12)
    end.writeUInt32LE(local.length, 16)
    return Buffer.concat([local, central, end])
}

describe('zip', () => {
    it('reads back what it writes: names, bytes, the executable bit, stored and deflated entries', () => {
        const random = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 256))
        const entries = [
            {
                path: 'skills/a/SKILL.md',
                bytes: Buffer.from('---\nname: a\n---\n\n' + 'text '.repeat(200)),
                exec: false
            },
            { path: 'skills/a/scripts/run.sh', bytes: Buffer.from('#!/bin/sh\necho ok\n'), exec: true },
            { path: 'skills/a/data/ünïcode.bin', bytes: random, exec: false },
            { path: 'empty.txt', bytes: Buffer.alloc(0), exec: false }
        ]
        const zip = writeZip(entries)
        expect(isZip(zip)).toBe(true)
        expect(readZip(zip)).toEqual(entries)
    })

    it('reads what another tool wrote with directories and `./` in the paths', () => {
        const zip = handmade('./skill/./SKILL.md', Buffer.from('hello'))
        expect(readZip(zip)).toEqual([{ path: 'skill/SKILL.md', bytes: Buffer.from('hello'), exec: false }])
    })

    it('refuses a path that climbs out, an absolute one and a link', () => {
        expect(() => readZip(handmade('../escape.sh', Buffer.from('x')))).toThrow(ZipError)
        expect(() => readZip(handmade('a/../../escape.sh', Buffer.from('x')))).toThrow(/unsafe path/)
        expect(() => readZip(handmade('/etc/passwd', Buffer.from('x')))).toThrow(/unsafe path/)
        expect(() => readZip(handmade('C:\\evil.txt', Buffer.from('x')))).toThrow(/unsafe path/)
        expect(() => readZip(handmade('link', Buffer.from('/etc/passwd'), { mode: 0o120777 }))).toThrow(/link/)
    })

    it('refuses an encrypted entry, a damaged one and something that is not an archive', () => {
        expect(() => readZip(handmade('a.txt', Buffer.from('x'), { flags: 0x0801 }))).toThrow(/encrypted/)
        const zip = writeZip([{ path: 'a.txt', bytes: Buffer.from('hello hello hello'), exec: false }])
        const broken = Buffer.from(zip)
        broken[36] ^= 0xff // inside the data, past the 30-byte header and the name
        expect(() => readZip(broken)).toThrow(ZipError)
        expect(() => readZip(Buffer.from('just text, not a zip'))).toThrow(/not a ZIP/)
    })

    it('stops at the limits before inflating, and a size that lies cannot balloon', () => {
        const big = Buffer.alloc(100_000, 'a')
        const zip = writeZip([{ path: 'big.txt', bytes: big, exec: false }])
        expect(() => readZip(zip, { entries: 10, file: 50_000, total: 1_000_000 })).toThrow(/larger than/)
        expect(() => readZip(zip, { entries: 10, file: 1_000_000, total: 50_000 })).toThrow(/unpacks to more/)
        const many = writeZip(
            Array.from({ length: 5 }, (_, i) => ({ path: `${i}`, bytes: Buffer.from('x'), exec: false }))
        )
        expect(() => readZip(many, { entries: 4, file: 100, total: 100 })).toThrow(/more than 4 entries/)
        // A bomb whose header claims ten bytes is cut at ten and refused, never inflated whole.
        const centralAt = 31 + zlib.deflateRawSync(Buffer.alloc(1_000_000)).length
        const bomb = writeZip([{ path: 'b', bytes: Buffer.alloc(1_000_000), exec: false }])
        bomb.writeUInt32LE(10, centralAt + 24)
        expect(() => readZip(bomb)).toThrow(/cannot be unpacked/)
    })
})
