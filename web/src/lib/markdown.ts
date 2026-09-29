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

/**
 * Render Markdown. Sanitized: transcripts may quote untrusted content.
 * `breaks` (the default) turns single newlines into line breaks, which is
 * right for chat replies; a file written with hard-wrapped paragraphs is
 * rendered with `breaks: false` so the wraps disappear.
 */
export function renderMarkdown(source: string, options: { breaks?: boolean } = {}): string {
    return DOMPurify.sanitize(marked.parse(source, { async: false, breaks: options.breaks ?? true }) as string)
}
