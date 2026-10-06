import { describe, expect, it } from 'vitest'

import { parseMarkdown, serializeMarkdown } from './markdown.js'

describe('parseMarkdown', () => {
    it('splits frontmatter and body', () => {
        expect(parseMarkdown('---\nname: a\ntools: [Read, Bash]\n---\n\n# Body\n')).toEqual({
            frontmatter: { name: 'a', tools: ['Read', 'Bash'] },
            body: '\n# Body\n'
        })
    })

    it('reads CRLF files', () => {
        expect(parseMarkdown('---\r\nname: a\r\n---\r\nbody')).toEqual({ frontmatter: { name: 'a' }, body: 'body' })
    })

    it('returns the whole text as body without frontmatter', () => {
        expect(parseMarkdown('# Title\n---\nx: 1\n---\n')).toEqual({
            frontmatter: {},
            body: '# Title\n---\nx: 1\n---\n'
        })
    })

    it('treats an empty block as no keys', () => {
        expect(parseMarkdown('---\n\n---\nbody')).toEqual({ frontmatter: {}, body: 'body' })
    })

    it('reports invalid YAML and keeps the body', () => {
        const doc = parseMarkdown('---\nname: [unclosed\n---\nbody')
        expect(doc.frontmatter).toEqual({})
        expect(doc.body).toBe('body')
        expect(doc.frontmatter_error).toEqual(expect.any(String))
        expect(doc.frontmatter_error).not.toContain('\n')
    })

    it.each(['- a\n- b', 'just a string', '42'])('reports a frontmatter that is not a mapping (%j)', (yaml) => {
        const doc = parseMarkdown(`---\n${yaml}\n---\nbody`)
        expect(doc.frontmatter).toEqual({})
        expect(doc.frontmatter_error).toBe('frontmatter is not a mapping')
    })
})

describe('serializeMarkdown', () => {
    it('writes frontmatter, a blank line and the body without leading newlines', () => {
        expect(serializeMarkdown({ frontmatter: { name: 'a', n: 1 }, body: '\n\nBody\n' })).toBe(
            '---\nname: a\nn: 1\n---\n\nBody\n'
        )
    })

    it('writes the body alone without keys', () => {
        expect(serializeMarkdown({ frontmatter: {}, body: 'Body' })).toBe('Body')
        expect(serializeMarkdown({ frontmatter: null, body: '\nBody' })).toBe('Body')
    })

    it('never wraps long values', () => {
        const description = 'word '.repeat(60).trim()
        const text = serializeMarkdown({ frontmatter: { description }, body: '' })
        expect(text.split('\n')[1]).toBe(`description: ${description}`)
    })

    it.each([
        { frontmatter: { name: 'x', tools: ['Read', 'Grep'], nested: { a: 1, b: [true, null] } }, body: 'Hello\n' },
        { frontmatter: { description: 'colon: inside, # hash and "quotes"' }, body: '# Head\n\ntext\n' },
        { frontmatter: { multi: 'line one\nline two\n' }, body: 'x' }
    ])('round-trips %j', (doc) => {
        const parsed = parseMarkdown(serializeMarkdown(doc))
        expect(parsed.frontmatter).toEqual(doc.frontmatter)
        expect(parsed.body.replace(/^\n/, '')).toBe(doc.body)
        expect(parsed.frontmatter_error).toBeUndefined()
    })
})
