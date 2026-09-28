import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

/** Render Markdown produced by the agent. Sanitized: transcripts may quote untrusted content. */
export function renderMarkdown(source: string): string {
    return DOMPurify.sanitize(marked.parse(source, { async: false }) as string)
}
