import { describe, expect, it } from 'vitest'

import { markdownToTelegramHtml as html, nested } from './format.js'

describe('markdownToTelegramHtml', () => {
    it('escapes HTML in plain text', () => {
        expect(html('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
        expect(html('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    })

    it.each([
        ['**bold**', '<b>bold</b>'],
        ['__bold__', '<b>bold</b>'],
        ['*italic*', '<i>italic</i>'],
        ['_italic_', '<i>italic</i>'],
        ['~~gone~~', '<s>gone</s>'],
        ['a **b** and *c*.', 'a <b>b</b> and <i>c</i>.'],
        ['(*note*)', '(<i>note</i>)'],
        ['**bold with _italic_ inside**', '<b>bold with <i>italic</i> inside</b>']
    ])('converts emphasis in %j', (md, out) => {
        expect(html(md)).toBe(out)
    })

    it('degrades a star-italic inside star-bold to literal markers, never to broken HTML', () => {
        expect(html('**bold with *italic* inside**')).toBe('**bold with <i>italic</i> inside**')
    })

    it.each(['2*3*4', 'snake_case_name', 'a*b', 'file_name.py'])('leaves intra-word markers in %j alone', (md) => {
        expect(html(md)).toBe(md)
    })

    it('keeps code spans literal and escaped', () => {
        expect(html('run `__init__.py` with `a<b && **c**`')).toBe(
            'run <code>__init__.py</code> with <code>a&lt;b &amp;&amp; **c**</code>'
        )
    })

    it('turns links into anchors without touching underscores in the URL', () => {
        expect(html('see [the_docs](https://x.dev/a_b_c?q=1&r="2")')).toBe(
            'see <a href="https://x.dev/a_b_c?q=1&amp;r=&quot;2&quot;">the_docs</a>'
        )
    })

    it('escapes a link label and leaves a non-http link as text', () => {
        expect(html('[<b>](https://x.dev)')).toBe('<a href="https://x.dev">&lt;b&gt;</a>')
        expect(html('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))')
    })

    it('renders headings bold, bullets with a dot, quotes in italics and rules as a line', () => {
        expect(html('## Title *x*\n- one\n  * two\n+ three\n> quoted **b**\n---\n***')).toBe(
            '<b>Title <i>x</i></b>\n• one\n  • two\n• three\n<i>quoted <b>b</b></i>\n———\n———'
        )
    })

    it('renders a fenced block as pre, dropping the info string and escaping the content', () => {
        expect(html('before\n```ts\nconst a = b < c && **d**\n```\nafter')).toBe(
            'before\n<pre>const a = b &lt; c &amp;&amp; **d**</pre>\nafter'
        )
    })

    it('keeps Markdown inside a fence literal', () => {
        expect(html('```\n# not a heading\n- not a bullet\n```')).toBe('<pre># not a heading\n- not a bullet</pre>')
    })

    it('closes a fence left open at the end', () => {
        expect(html('```bash\nls -la')).toBe('<pre>ls -la</pre>')
    })

    it('handles indented fences and CRLF line endings', () => {
        expect(html('text\r\n  ```python\r\n  x = 1\r\n  ```\r\nend')).toBe('text\n<pre>  x = 1</pre>\nend')
    })

    it('handles two fences in a row', () => {
        expect(html('```\na\n```\n```js\nb\n```')).toBe('<pre>a</pre>\n<pre>b</pre>')
    })

    it('does not let a NUL in the input pick a kept span', () => {
        expect(html('\u00000\u0000 and `code`')).not.toContain('undefined')
    })

    it.each([
        ['**a _b** c_', '**a _b** c_'],
        ['~~a **b~~ c**', '~~a **b~~ c**'],
        ['**a ~~b** c~~ `x`', '**a ~~b** c~~ <code>x</code>']
    ])('keeps crossed emphasis as text in %j', (md, out) => {
        const result = html(md)
        expect(balanced(result)).toBe(true)
        if (!nested(result.replace(/<\/?code>/g, ''))) throw new Error(result)
        expect(result).toBe(out)
    })

    it('always gives balanced, nested tags (fuzz)', () => {
        const alphabet = [
            '*',
            '**',
            '_',
            '__',
            '~~',
            'a',
            ' ',
            '`',
            '[',
            ']',
            '(',
            ')',
            'https://x.y',
            '<',
            '&',
            '\n',
            '>',
            '#',
            '-'
        ]
        const unbalanced: string[] = []
        let seed = 42
        const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
        for (let n = 0; n < 3000; n++) {
            const md = Array.from(
                { length: 1 + Math.floor(random() * 30) },
                () => alphabet[Math.floor(random() * alphabet.length)]
            ).join('')
            const out = html(md)
            if (!balanced(out)) unbalanced.push(`${JSON.stringify(md)} → ${out}`)
        }
        expect(unbalanced).toEqual([])
    })
})

/** Every tag Telegram knows opens and closes in order; no stray `<` outside a tag. */
function balanced(out: string): boolean {
    const open: string[] = []
    for (const [, closing, tag] of out.matchAll(/<(\/?)(b|i|s|u|code|pre|a)(?: href="[^"<>]*")?>/g)) {
        if (!closing) open.push(tag)
        else if (open.pop() !== tag) return false
    }
    const stray = out.replace(/<\/?(b|i|s|u|code|pre|a)(?: href="[^"<>]*")?>/g, '')
    return open.length === 0 && !/[<>]/.test(stray)
}
