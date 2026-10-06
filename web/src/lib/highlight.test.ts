import { describe, expect, it } from 'vitest'

import { diffOf, escape, highlight, languageOf } from './highlight'

describe('languageOf', () => {
    it.each([
        ['src/index.ts', 'ts'],
        ['web/App.tsx', 'tsx'],
        ['config/app.YML', 'yml'],
        ['main.go', 'go'],
        ['docker/Dockerfile', 'dockerfile'],
        ['README.md', 'plaintext'],
        ['notes.txt', 'plaintext']
    ])('%s → %s', (path, language) => {
        expect(languageOf(path)).toBe(language)
    })

    it('is undefined for an extension it does not know', () => {
        expect(languageOf('image.xyz')).toBeUndefined()
        expect(languageOf('Makefile')).toBeUndefined()
    })
})

describe('escape', () => {
    it('escapes the characters that would open markup', () => {
        expect(escape('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;')
    })
})

describe('highlight', () => {
    it('highlights in the language asked for', () => {
        const { html, language } = highlight('const x = 1', 'typescript')
        expect(language).toBe('typescript')
        expect(html).toContain('hljs-keyword')
    })

    it('highlights under an alias, keeping the name it was given', () => {
        const { html, language } = highlight('echo "hi"', 'sh')
        expect(language).toBe('sh')
        expect(html).toContain('hljs-')
    })

    it('keeps plaintext plain and escaped', () => {
        expect(highlight('<b>**x**</b>', 'plaintext')).toEqual({
            html: '&lt;b&gt;**x**&lt;/b&gt;',
            language: 'plaintext'
        })
        expect(highlight('a < b', 'text').language).toBe('plaintext')
    })

    it('detects a language it was not told', () => {
        const code = '{\n  "name": "pocket-factory",\n  "version": "1.1.0",\n  "private": true\n}'
        expect(highlight(code).language).toBe('json')
    })

    it('falls back to escaped text when nothing matches', () => {
        expect(highlight('just a few words', 'nosuchlang')).toEqual({ html: 'just a few words', language: 'plaintext' })
        expect(highlight('<x>').html).toBe('&lt;x&gt;')
    })

    it('does not auto-detect very long text', () => {
        const long = 'const x = 1;\n'.repeat(2000)
        expect(highlight(long).language).toBe('plaintext')
    })
})

describe('diffOf', () => {
    it('marks the old lines removed and the new ones added', () => {
        const root = document.createElement('div')
        root.innerHTML = diffOf('old line\nsecond', 'new line')
        expect([...root.querySelectorAll('.hljs-deletion')].map((n) => n.textContent)).toEqual([
            '- old line',
            '- second'
        ])
        expect(root.querySelector('.hljs-addition')).toHaveTextContent('+ new line')
    })

    it('escapes markup inside the edit', () => {
        const root = document.createElement('div')
        root.innerHTML = diffOf('<b>', '<i>')
        expect(root.querySelector('b, i')).toBeNull()
        expect(root).toHaveTextContent('- <b> + <i>')
    })
})
