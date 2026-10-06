import DOMPurify from 'dompurify'
import { marked } from 'marked'

import { escape, highlight } from './highlight'

// Fenced code blocks come out highlighted; the class names are highlight.js's
// `hljs-*` tokens, coloured by the theme in styles.css.
marked.use({
    gfm: true,
    breaks: true,
    renderer: {
        code({ text, lang }) {
            const language = (lang ?? '').trim().split(/\s+/)[0]
            const { html, language: detected } = highlight(text, language || undefined)
            return `<pre class="code" data-lang="${escape(detected)}"><code class="hljs language-${escape(detected)}">${html}</code></pre>\n`
        }
    }
})

// A link to another site opens in a new tab: the reply it sits in is a
// conversation the owner is reading, and a PR or a ticket is a side trip.
// Links into the factory itself stay in this tab. `target` is not in
// DOMPurify's default attribute list, so it is set after sanitizing, with
// `noopener` so the other page cannot reach back.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return
    const href = node.getAttribute('href')
    if (!href || !/^https?:/i.test(href)) return
    let external = true
    try {
        external = new URL(href, window.location.href).origin !== window.location.origin
    } catch {
        // an unparsable URL: leave it alone
    }
    if (!external) return
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
})

/**
 * Render Markdown. Sanitized: transcripts may quote untrusted content.
 * `breaks` (the default) turns single newlines into line breaks, which is
 * right for chat replies; a file written with hard-wrapped paragraphs is
 * rendered with `breaks: false` so the wraps disappear.
 */
export function renderMarkdown(source: string, options: { breaks?: boolean } = {}): string {
    return DOMPurify.sanitize(marked.parse(source, { async: false, breaks: options.breaks ?? true }))
}
