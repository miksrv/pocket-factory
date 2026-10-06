import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Attachment, attachmentNote, Inbox, isPreviewable, MAX_ATTACHMENT_BYTES, typeOf } from './inbox.js'

describe('typeOf', () => {
    it.each([
        ['shot.PNG', undefined, 'image/png'],
        ['a.jpeg', null, 'image/jpeg'],
        ['report.pdf', 'application/octet-stream', 'application/pdf'],
        ['notes.txt', 'text/x-custom', 'text/x-custom'],
        ['blob', undefined, 'application/octet-stream'],
        ['archive.unknownext', 'application/octet-stream', 'application/octet-stream'],
        ['data.yml', '', 'application/yaml']
    ])('%s (%j) → %s', (name, given, type) => {
        expect(typeOf(name, given)).toBe(type)
    })
})

describe('isPreviewable', () => {
    it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('shows %s inline', (type) => {
        expect(isPreviewable(type)).toBe(true)
    })

    it.each(['image/svg+xml', 'image/heic', 'text/html', 'application/pdf', 'image/png; x', 'ximage/png'])(
        'does not show %s inline',
        (type) => {
            expect(isPreviewable(type)).toBe(false)
        }
    )
})

describe('attachmentNote', () => {
    const file = (over: Partial<Attachment>): Attachment => ({
        name: 'n',
        path: '/data/inbox/c/n',
        type: 'image/png',
        size: 1,
        ...over
    })

    it('is empty without attachments', () => {
        expect(attachmentNote([])).toBe('')
    })

    it('names one file with its path, type and size', () => {
        const note = attachmentNote([file({ path: '/data/inbox/c/a.png', size: 300 })])
        expect(note.startsWith('\n\n[Attached by the owner: one file,')).toBe(true)
        expect(note.endsWith('\n- /data/inbox/c/a.png (image/png, 1 KB)')).toBe(true)
    })

    it('counts several files and prints megabytes', () => {
        const note = attachmentNote([
            file({ path: '/a', size: 5 * 1024 }),
            file({ path: '/b', type: 'application/pdf', size: 3.5 * 1024 * 1024 })
        ])
        expect(note).toContain('2 files')
        expect(note).toContain('- /a (image/png, 5 KB)\n- /b (application/pdf, 3.5 MB)')
    })
})

describe('Inbox', () => {
    let root: string
    let inbox: Inbox

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-inbox-'))
        inbox = new Inbox(root)
    })

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('saves a file under a safe, unique name in the conversation directory', () => {
        const a = inbox.save('conv-1', '../../Screen Shot 2026-10-06 at 9.41.PNG', Buffer.from('png'))
        expect(a.name).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}-Screen_Shot_2026-10-06_at_9.41\.PNG$/)
        expect(a.path).toBe(path.join(root, 'conv-1', a.name))
        expect(a.type).toBe('image/png')
        expect(a.size).toBe(3)
        expect(fs.readFileSync(a.path, 'utf8')).toBe('png')
        const b = inbox.save('conv-1', '../../Screen Shot 2026-10-06 at 9.41.PNG', Buffer.from('png'))
        expect(b.name).not.toBe(a.name)
    })

    it.each([
        ['', /-file$/],
        ['...', /-file\.$/],
        ['отчёт.pdf', /-file\.pdf$/],
        ['a b?c*.tar.gz', /-a_b_c_\.tar\.gz$/],
        ['x.this-is-a-long-ext', /-x\.thisisalo$/]
    ])('cleans the name %j', (name, pattern) => {
        expect(inbox.save('c', name, Buffer.from('x')).name).toMatch(pattern)
    })

    it('keeps the type the channel gave', () => {
        expect(inbox.save('c', 'voice', Buffer.from('x'), 'audio/ogg').type).toBe('audio/ogg')
    })

    it('refuses empty and oversized files and bad conversation ids', () => {
        expect(() => inbox.save('c', 'a.txt', Buffer.alloc(0))).toThrow('empty')
        expect(() => inbox.save('c', 'a.txt', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).toThrow('larger than 20 MB')
        expect(() => inbox.save('../etc', 'a.txt', Buffer.from('x'))).toThrow('bad conversation id')
        expect(() => inbox.dir('a/b')).toThrow('bad conversation id')
    })

    it('gets a saved file back and refuses names that leave the directory', () => {
        const a = inbox.save('c', 'log.txt', Buffer.from('hello'))
        expect(inbox.get('c', a.name)).toEqual({ name: a.name, path: a.path, type: 'text/plain', size: 5 })
        expect(inbox.get('c', 'missing.txt')).toBeNull()
        expect(inbox.get('c', '../c/' + a.name)).toBeNull()
        expect(inbox.get('c', '.hidden')).toBeNull()
        fs.mkdirSync(path.join(root, 'c', 'subdir'))
        expect(inbox.get('c', 'subdir')).toBeNull()
    })

    it('adopts a file from another conversation by moving it', () => {
        const a = inbox.save('from', 'a.txt', Buffer.from('x'))
        const moved = inbox.adopt('to', a)
        expect(moved.path).toBe(path.join(root, 'to', a.name))
        expect(fs.existsSync(moved.path)).toBe(true)
        expect(fs.existsSync(a.path)).toBe(false)
        expect(inbox.adopt('to', moved)).toBe(moved)
    })

    it('leaves a file outside the inbox or a missing one where it is', () => {
        const outside = path.join(os.tmpdir(), 'pf-not-inbox.txt')
        const foreign: Attachment = { name: 'x', path: outside, type: 'text/plain', size: 1 }
        expect(inbox.adopt('to', foreign)).toBe(foreign)
        const prefix: Attachment = { name: 'x', path: `${root}-evil/x`, type: 'text/plain', size: 1 }
        expect(inbox.adopt('to', prefix)).toBe(prefix)
        const gone: Attachment = { name: 'x', path: path.join(root, 'from', 'x'), type: 'text/plain', size: 1 }
        expect(inbox.adopt('to', gone)).toBe(gone)
        expect(fs.existsSync(path.join(root, 'to'))).toBe(false)
    })

    it('removes a conversation directory and counts its files', () => {
        inbox.save('c', 'a.txt', Buffer.from('x'))
        inbox.save('c', 'b.txt', Buffer.from('x'))
        expect(inbox.remove('c')).toBe(2)
        expect(fs.existsSync(path.join(root, 'c'))).toBe(false)
        expect(inbox.remove('c')).toBe(0)
    })

    it('sweeps the directories of conversations that are gone', () => {
        inbox.save('live', 'a.txt', Buffer.from('x'))
        inbox.save('dead', 'a.txt', Buffer.from('x'))
        fs.writeFileSync(path.join(root, 'stray.txt'), 'x')
        inbox.sweep((id) => id === 'live')
        expect(fs.readdirSync(root).sort()).toEqual(['live', 'stray.txt'])
    })

    it('does nothing when the root does not exist', () => {
        const missing = new Inbox(path.join(root, 'nope'))
        expect(() => missing.sweep(() => false)).not.toThrow()
        expect(() => missing.prune(1)).not.toThrow()
    })

    it('prunes old files, then empty directories', () => {
        const old = inbox.save('old', 'a.txt', Buffer.from('x'))
        const mixedOld = inbox.save('mixed', 'a.txt', Buffer.from('x'))
        const mixedNew = inbox.save('mixed', 'b.txt', Buffer.from('x'))
        const past = new Date(Date.now() - 40 * 86_400_000)
        fs.utimesSync(old.path, past, past)
        fs.utimesSync(mixedOld.path, past, past)
        inbox.prune(0)
        expect(fs.existsSync(old.path)).toBe(true)
        inbox.prune(30)
        expect(fs.existsSync(path.join(root, 'old'))).toBe(false)
        expect(fs.existsSync(mixedOld.path)).toBe(false)
        expect(fs.existsSync(mixedNew.path)).toBe(true)
    })
})
