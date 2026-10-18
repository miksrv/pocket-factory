import { describe, expect, it } from 'vitest'

import { parseCsv, parseItems, repoSlug, SourceError } from './sources.js'

describe('parseItems', () => {
    it('keeps the first of a repeated key in a JSON array, as in the line form', () => {
        expect(parseItems('[{"id":"1","title":"one"},{"id":"1","title":"again"},"2"]')).toEqual([
            { key: '1', title: 'one', text: undefined, url: undefined },
            { key: '2', title: '2' }
        ])
    })

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
        expect(() => parseItems(output)).toThrow(SourceError)
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
