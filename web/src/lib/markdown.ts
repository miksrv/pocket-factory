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

/** Render Markdown produced by the agent. Sanitized: transcripts may quote untrusted content. */
export function renderMarkdown(source: string): string {
    return DOMPurify.sanitize(marked.parse(source, { async: false }) as string)
}
