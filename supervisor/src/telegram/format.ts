/**
 * Convert the subset of Markdown Claude tends to produce into Telegram HTML.
 * Telegram supports only a handful of tags (b, i, code, pre, a, s, u), so
 * everything else is flattened to text. Unknown constructs degrade gracefully:
 * the worst case is a literal asterisk, never a rejected message.
 */

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Inline Markdown → Telegram HTML. Code spans and link targets are lifted out
 * first and put back last, so emphasis markers inside `__init__.py` or a URL
 * with underscores are never rewritten (that would also yield invalid HTML,
 * and Telegram rejects the whole message).
 */
function inline(text: string): string {
    const kept: string[] = []
    const keep = (html: string) => {
        kept.push(html)
        return `\u0000${kept.length - 1}\u0000`
    }
    let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`))
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => keep(`<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(label)}</a>`))
    out = escapeHtml(out)
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    out = out.replace(/__([^_\n]+)__/g, '<b>$1</b>')
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)])
}

export function markdownToTelegramHtml(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n')
    const out: string[] = []
    let codeBlock: string[] | null = null

    for (const line of lines) {
        const fence = line.match(/^\s*```/)
        if (fence) {
            if (codeBlock === null) {
                codeBlock = []
            } else {
                out.push(`<pre>${escapeHtml(codeBlock.join('\n'))}</pre>`)
                codeBlock = null
            }
            continue
        }
        if (codeBlock !== null) {
            codeBlock.push(line)
            continue
        }

        const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
        if (heading) {
            out.push(`<b>${inline(heading[1])}</b>`)
            continue
        }
        if (/^\s*([-*_]\s*){3,}$/.test(line)) {
            out.push('———')
            continue
        }
        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
        if (bullet) {
            out.push(`${bullet[1]}• ${inline(bullet[2])}`)
            continue
        }
        const quote = line.match(/^\s*>\s?(.*)$/)
        if (quote) {
            out.push(`<i>${inline(quote[1])}</i>`)
            continue
        }
        out.push(inline(line))
    }

    if (codeBlock !== null) {
        out.push(`<pre>${escapeHtml(codeBlock.join('\n'))}</pre>`)
    }

    return out.join('\n')
}
