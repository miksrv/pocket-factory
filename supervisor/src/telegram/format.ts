/**
 * Convert the subset of Markdown Claude tends to produce into Telegram HTML.
 * Telegram supports only a handful of tags (b, i, code, pre, a, s, u), so
 * everything else is flattened to text. Unknown constructs degrade gracefully:
 * the worst case is a literal asterisk, never a rejected message.
 */

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(text: string): string {
    let out = escapeHtml(text)
    // inline code first, so markers inside it are left alone
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    out = out.replace(/__([^_\n]+)__/g, '<b>$1</b>')
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    return out
}

export function markdownToTelegramHtml(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n')
    const out: string[] = []
    let codeBlock: string[] | null = null

    for (const line of lines) {
        const fence = line.match(/^\s*```(\w*)\s*$/)
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
        if (/^\s*([-*_]\s*){3,}$/.test(line)) {
            out.push('———')
            continue
        }
        out.push(inline(line))
    }

    if (codeBlock !== null) {
        out.push(`<pre>${escapeHtml(codeBlock.join('\n'))}</pre>`)
    }

    return out.join('\n')
}
