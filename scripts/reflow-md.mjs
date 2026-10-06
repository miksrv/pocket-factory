// Unwrap hard-wrapped prose in Markdown files so that editors show paragraphs
// at their own width: the lines of one paragraph, list item or quote are
// joined with a space. Frontmatter, fenced code, indented code, headings,
// tables and blank lines are left alone; two trailing spaces keep a break.
//   node scripts/reflow-md.mjs <file.md> [...]      rewrites in place, prints what changed
import fs from 'node:fs'
import path from 'node:path'

const FENCE = /^\s*(```|~~~)/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^(\s*>\s?)(.*)$/
const LEAVE = /^\s*(#{1,6}\s|\||([-*_]\s*){3,}$)/

export function reflow(text) {
    const out = []
    let open = null // { prefix, text, kind: 'para' | 'item' | 'quote' }
    const flush = () => {
        if (open) out.push(open.prefix + open.text)
        open = null
    }
    const start = (prefix, text, kind) => {
        flush()
        open = { prefix, text: text.trim(), kind }
    }
    const append = (text) => {
        if (/ {2}$/.test(open.text)) {
            // a marked hard break: keep it, continue on a new line aligned under the text
            out.push(open.prefix + open.text)
            open = {
                prefix: open.kind === 'item' ? ' '.repeat(open.prefix.length) : open.prefix,
                text: text.trim(),
                kind: open.kind
            }
        } else {
            open.text += ' ' + text.trim()
        }
    }

    const lines = text.split('\n')
    let inFrontmatter = lines[0] === '---'
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (inFrontmatter) {
            out.push(line)
            if (i > 0 && line === '---') inFrontmatter = false
            continue
        }
        if (FENCE.test(line)) {
            flush()
            inFence = !inFence
            out.push(line)
            continue
        }
        if (inFence || line.trim() === '' || LEAVE.test(line)) {
            flush()
            out.push(line)
            continue
        }
        const item = ITEM.exec(line)
        if (item) {
            start(`${item[1]}${item[2]} `, item[3], 'item')
            continue
        }
        const quote = QUOTE.exec(line)
        if (quote) {
            if (open?.kind === 'quote') append(quote[2])
            else start(quote[1], quote[2], 'quote')
            continue
        }
        if (!open && /^ {4,}\S/.test(line)) {
            // indented code block
            out.push(line)
            continue
        }
        if (open && open.kind !== 'quote') append(line)
        else start(line.match(/^\s*/)[0], line, 'para')
    }
    flush()
    return out.join('\n')
}

if (process.argv[1] && path.basename(process.argv[1]) === 'reflow-md.mjs') {
    for (const file of process.argv.slice(2)) {
        const before = fs.readFileSync(file, 'utf8')
        const after = reflow(before)
        if (after !== before) {
            fs.writeFileSync(file, after)
            console.log('reflowed', file)
        }
    }
}
