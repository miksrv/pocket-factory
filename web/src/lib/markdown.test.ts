import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown'

/** Parse the rendered HTML the way the page shows it. */
const dom = (html: string) => {
    const root = document.createElement('div')
    root.innerHTML = html
    return root
}

describe('renderMarkdown', () => {
    it('drops scripts and event handler attributes', () => {
        const root = dom(renderMarkdown('Hello <script>alert(1)</script>\n\n<img src="x.png" onerror="alert(2)">'))
        expect(root.querySelector('script')).toBeNull()
        expect(root.textContent).toContain('Hello')
        const img = root.querySelector('img')
        expect(img).not.toBeNull()
        expect(img!.hasAttribute('onerror')).toBe(false)
    })

    it('drops javascript: links', () => {
        const root = dom(renderMarkdown('[click](javascript:alert(1))'))
        expect(root.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/javascript:/i)
    })

    it('opens a link to another site in a new tab without an opener', () => {
        const link = dom(renderMarkdown('See [the PR](https://github.com/acme/repo/pull/1)')).querySelector('a')!
        expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/pull/1')
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('keeps links into the factory in this tab', () => {
        const root = dom(renderMarkdown(`[task](/tasks/1) and [absolute](${window.location.origin}/chat/2)`))
        const links = root.querySelectorAll('a')
        expect(links).toHaveLength(2)
        for (const link of links) {
            expect(link).not.toHaveAttribute('target')
            expect(link).not.toHaveAttribute('rel')
        }
    })

    it('highlights a fenced code block in its language', () => {
        const root = dom(renderMarkdown('```ts\nconst answer: number = 42\n```'))
        const pre = root.querySelector('pre.code')!
        expect(pre).toHaveAttribute('data-lang', 'ts')
        expect(pre.querySelector('code')).toHaveClass('hljs', 'language-ts')
        expect(pre.querySelector('.hljs-keyword')).toHaveTextContent('const')
        expect(pre).toHaveTextContent('const answer: number = 42')
    })

    it('escapes the code of a block in an unknown language', () => {
        const root = dom(renderMarkdown('```nosuchlang\n<b>not bold</b>\n```'))
        expect(root.querySelector('pre b')).toBeNull()
        expect(root.querySelector('pre')).toHaveTextContent('<b>not bold</b>')
    })

    it('turns single newlines into line breaks by default', () => {
        expect(dom(renderMarkdown('one\ntwo')).querySelector('br')).not.toBeNull()
    })

    it('reflows hard-wrapped paragraphs with breaks off', () => {
        const root = dom(renderMarkdown('one\ntwo', { breaks: false }))
        expect(root.querySelector('br')).toBeNull()
        expect(root.querySelector('p')).toHaveTextContent('one two')
    })
})
