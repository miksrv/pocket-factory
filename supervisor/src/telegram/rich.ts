/**
 * Rich messages (Bot API 10.1+): Telegram renders GitHub-flavoured Markdown
 * itself — headings, tables, lists, task lists, code blocks with a language,
 * block quotes, `<details>` blocks — up to 32k characters in one message. The
 * agent's reply goes in as it is, after the few things Telegram's parser
 * would trip on are escaped: a stray `<` that opens no supported tag
 * (`Array<string>`), a bare `&`, and `$`, which opens a formula there.
 */

/** Telegram's limit on rich message text, with room for the footer. */
export const RICH_MAX_LENGTH = 30_000

const TAGS =
    'a|b|strong|i|em|u|ins|s|strike|del|code|pre|mark|sub|sup|span|tg-spoiler|tg-emoji|tg-time|tg-math|tg-math-block|tg-reference|tg-button|tg-button-row|tg-document|tg-map|tg-collage|tg-slideshow|h[1-6]|p|footer|hr|br|ul|ol|li|input|blockquote|aside|cite|details|summary|table|caption|tr|td|th|img|video|audio|figure|figcaption'
const TAG_AHEAD = new RegExp(`^</?(?:${TAGS})(?:[\\s/>]|$)`, 'i')
const ENTITY_AHEAD = /^&(?:#\d+|#x[0-9a-f]+|lt|gt|amp|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo);/i
const AUTOLINK = /^<(https?:\/\/[^>\s]+)>/

/** Escape one run of text outside code: tags Telegram knows stay, everything else that looks like HTML is text. */
function escapeText(text: string): string {
    let out = ''
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        const rest = text.slice(i)
        if (c === '<') {
            const link = AUTOLINK.exec(rest)
            if (link) {
                out += link[1]
                i += link[0].length - 1
            } else out += TAG_AHEAD.test(rest) ? '<' : '&lt;'
        } else if (c === '&') out += ENTITY_AHEAD.test(rest) ? '&' : '&amp;'
        else if (c === '$') out += '\\$'
        else out += c
    }
    return out
}

/** A line outside a fenced block: code spans stay as they are, the text between them is escaped. */
function escapeLine(line: string): string {
    return line
        .split(/(`+[^`\n]*?`+)/)
        .map((part, i) => (i % 2 ? part : escapeText(part)))
        .join('')
}

/** The agent's Markdown, ready for `sendRichMessage({ markdown })`. */
export function richMarkdown(markdown: string): string {
    const out: string[] = []
    let fence: string | null = null
    for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
        const open = /^\s*(`{3,}|~{3,})/.exec(line)
        if (fence === null && open) {
            fence = open[1][0]
            out.push(line)
            continue
        }
        if (fence !== null) {
            out.push(line)
            if (open?.[1].startsWith(fence)) fence = null
            continue
        }
        out.push(escapeLine(line))
    }
    return out.join('\n')
}
