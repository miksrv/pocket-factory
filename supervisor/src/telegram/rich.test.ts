import { describe, expect, it } from 'vitest'

import { richMarkdown } from './rich.js'

describe('richMarkdown', () => {
    it('leaves Markdown Telegram renders itself alone', () => {
        const text = '# Title\n\n- a `code` item\n- **bold** and _it_\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote'
        expect(richMarkdown(text)).toBe(text)
    })

    it('escapes a < that opens no supported tag, and keeps the tags Telegram knows', () => {
        expect(richMarkdown('an Array<string> here')).toBe('an Array&lt;string&gt; here'.replace('&gt;', '>'))
        expect(richMarkdown('<b>bold</b> and <details><summary>s</summary>x</details>')).toBe(
            '<b>bold</b> and <details><summary>s</summary>x</details>'
        )
        expect(richMarkdown('<!-- a comment -->')).toBe('&lt;!-- a comment -->')
    })

    it('turns an autolink into the bare URL', () => {
        expect(richMarkdown('see <https://example.com/a?b=1>')).toBe('see https://example.com/a?b=1')
    })

    it('escapes a bare & and keeps entities', () => {
        expect(richMarkdown('R&D and &amp; and &#169; and &hellip;')).toBe('R&amp;D and &amp; and &#169; and &hellip;')
    })

    it('escapes $ so a price never opens a formula', () => {
        expect(richMarkdown('costs $5, later $10')).toBe('costs \\$5, later \\$10')
    })

    it('touches nothing inside code spans and fenced blocks', () => {
        const text = 'x `a < b && c` y\n```ts\nconst a: Array<string> = []\nif (a && b) $x\n```\nz <q>'
        expect(richMarkdown(text)).toBe(
            'x `a < b && c` y\n```ts\nconst a: Array<string> = []\nif (a && b) $x\n```\nz &lt;q>'
        )
        expect(richMarkdown('~~~\n<raw> & $\n~~~')).toBe('~~~\n<raw> & $\n~~~')
    })
})
