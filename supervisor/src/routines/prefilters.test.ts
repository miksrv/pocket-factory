import os from 'node:os'

import { describe, expect, it } from 'vitest'

import { parseCsv, parseItems, PrefilterError, repoSlug, runPrefilter } from './prefilters.js'

describe('parseItems', () => {
    it.each(['', '   \n\n  '])('finds nothing in %j', (output) => {
        expect(parseItems(output)).toEqual([])
    })

    it('reads one item per line, key and title split at a tab', () => {
        expect(parseItems('a\n  b\tThe B  \n\nc\t\n')).toEqual([
            { key: 'a', title: 'a' },
            { key: 'b', title: 'The B' },
            { key: 'c', title: 'c' }
        ])
    })

    it('drops repeated keys, keeping the first', () => {
        expect(parseItems('x\tfirst\nx\tsecond\ny')).toEqual([
            { key: 'x', title: 'first' },
            { key: 'y', title: 'y' }
        ])
    })

    it('reads a JSON array of strings and objects', () => {
        const output = JSON.stringify([
            ' one ',
            '',
            { key: 'k', title: 'T', text: 'body', url: 'https://x' },
            { id: 42 },
            { title: 'only a title', text: 7 }
        ])
        expect(parseItems(output)).toEqual([
            { key: 'one', title: 'one' },
            { key: 'k', title: 'T', text: 'body', url: 'https://x' },
            { key: '42', title: '42', text: undefined, url: undefined },
            { key: 'only a title', title: 'only a title', text: undefined, url: undefined }
        ])
    })

    it.each([
        ['[not json', /not a JSON array/],
        ['[1]', /item 0 is neither a string nor an object/],
        ['["a", null]', /item 1 is neither/],
        ['[{"text": "no key"}]', /item 0 has no key/]
    ])('rejects %j', (output, message) => {
        expect(() => parseItems(output)).toThrow(PrefilterError)
        expect(() => parseItems(output)).toThrow(message)
    })
})

describe('parseCsv', () => {
    it('splits rows and fields', () => {
        expect(parseCsv('id,summary\n1,first\n2,second')).toEqual([
            ['id', 'summary'],
            ['1', 'first'],
            ['2', 'second']
        ])
    })

    it('handles quotes, escaped quotes, commas and newlines inside a field', () => {
        expect(parseCsv('id,summary\r\n1,"a, ""quoted""\r\nline"\r\n')).toEqual([
            ['id', 'summary'],
            ['1', 'a, "quoted"\r\nline']
        ])
    })

    it('drops a byte order mark and blank lines', () => {
        expect(parseCsv('﻿id,x\n\n1,y\n\n')).toEqual([
            ['id', 'x'],
            ['1', 'y']
        ])
    })

    it('keeps empty fields', () => {
        expect(parseCsv('a,,c\n,,')).toEqual([
            ['a', '', 'c'],
            ['', '', '']
        ])
    })

    it('returns no rows for empty input', () => {
        expect(parseCsv('')).toEqual([])
    })
})

describe('repoSlug', () => {
    it.each([
        ['https://github.com/miksrv/pocket-factory', 'miksrv/pocket-factory'],
        ['https://github.com/miksrv/pocket-factory.git', 'miksrv/pocket-factory'],
        ['https://github.com/miksrv/pocket-factory/', 'miksrv/pocket-factory'],
        ['git@github.com:Org.Name/repo.js.git', 'Org.Name/repo.js'],
        ['  ssh://git@github.com/a/b  ', 'a/b']
    ])('reads %s as %s', (url, slug) => {
        expect(repoSlug(url)).toBe(slug)
    })

    it.each([null, undefined, '', 'https://gitlab.com/a/b', 'https://github.com/only-owner'])(
        'returns null for %j',
        (url) => {
            expect(repoSlug(url)).toBeNull()
        }
    )
})

describe('runPrefilter (command)', () => {
    const ctx = { cwd: os.tmpdir(), env: { PATH: process.env.PATH }, project: null }

    it('runs the command with bash and parses its output', async () => {
        const items = await runPrefilter({ kind: 'command', run: "printf 'a\\tA\\nb\\n'", timeout_s: 10 }, ctx)
        expect(items).toEqual([
            { key: 'a', title: 'A' },
            { key: 'b', title: 'b' }
        ])
    })

    it('runs in the given working directory with the given environment', async () => {
        const items = await runPrefilter(
            { kind: 'command', run: 'echo "$PWD_NAME:$(basename "$PWD")"', cwd: '/', timeout_s: 10 },
            { ...ctx, env: { ...ctx.env, PWD_NAME: 'root' } }
        )
        expect(items).toEqual([{ key: 'root:/', title: 'root:/' }])
    })

    it('turns a failing command into a PrefilterError with the tail of its output', async () => {
        const run = runPrefilter({ kind: 'command', run: 'echo boom >&2; exit 3', timeout_s: 10 }, ctx)
        await expect(run).rejects.toThrow(PrefilterError)
        await expect(
            runPrefilter({ kind: 'command', run: 'echo boom >&2; exit 3', timeout_s: 10 }, ctx)
        ).rejects.toThrow('bash exited with 3: boom')
    })

    it('stops a command that outlives its timeout', async () => {
        await expect(runPrefilter({ kind: 'command', run: 'sleep 5', timeout_s: 0.2 }, ctx)).rejects.toThrow(
            'timed out after 0.2 s'
        )
    })
})
