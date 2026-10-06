import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createLogger } from '../logger.js'

const log = createLogger('inbox')

/** A file the owner sent with a message (a photo, a screenshot, a log, a PDF), saved on the factory's disk. */
export interface Attachment {
    /** File name inside the conversation's inbox directory; unique, safe as a path segment and a URL part. */
    name: string
    /** Absolute path the agent opens with its Read tool. */
    path: string
    /** MIME type, as the channel said or guessed from the extension. */
    type: string
    size: number
}

/** Telegram's bot API serves files up to 20 MB; the web upload keeps to the same ceiling. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** How many files one message may carry (a Telegram album holds ten). */
export const MAX_ATTACHMENTS = 10

const TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime'
}

/** Images a browser shows inline and the Read tool shows to the model; SVG is left out on purpose (it can carry script). */
export const isPreviewable = (type: string) => /^image\/(png|jpeg|gif|webp)$/.test(type)

/** A guess at a file's type from its name, for channels that send none. */
export const typeOf = (name: string, given?: string | null): string => (given && given !== 'application/octet-stream' ? given : (TYPES[path.extname(name).toLowerCase()] ?? given ?? 'application/octet-stream'))

/** "Screen Shot 2026-10-06 at 9.41.png" → "Screen_Shot_2026-10-06_at_9.41.png", short enough for a path. */
function safeName(original: string): string {
    const base = path.basename(original || 'file').normalize('NFKD')
    const ext = path.extname(base).replace(/[^A-Za-z0-9.]/g, '').slice(0, 10)
    const stem = base.slice(0, base.length - path.extname(base).length).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|_+$/g, '').slice(0, 60)
    return `${stem || 'file'}${ext}`
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/**
 * The owner's uploads: `<root>/<conversation>/<stamp>-<rand>-<name>`. The
 * agent gets absolute paths in its prompt and opens them with the Read tool
 * (images and PDFs included); nothing here is ever executed or served
 * inline unless it is a plain raster image.
 */
export class Inbox {
    constructor(readonly root: string) {}

    dir(conversationId: string): string {
        if (!/^[A-Za-z0-9-]+$/.test(conversationId)) throw new Error('bad conversation id')
        return path.join(this.root, conversationId)
    }

    save(conversationId: string, originalName: string, data: Buffer, type?: string | null): Attachment {
        if (data.length === 0) throw new Error('the file is empty')
        if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`the file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
        const dir = this.dir(conversationId)
        fs.mkdirSync(dir, { recursive: true })
        const name = `${stamp()}-${randomBytes(3).toString('hex')}-${safeName(originalName)}`
        const file = path.join(dir, name)
        fs.writeFileSync(file, data, { flag: 'wx' })
        log.info(`saved ${file} (${data.length} bytes)`)
        return { name, path: file, type: typeOf(originalName, type), size: data.length }
    }

    /** A file saved earlier in this conversation's inbox, or null (unknown name, or one trying to leave the directory). */
    get(conversationId: string, name: string): Attachment | null {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null
        const file = path.join(this.dir(conversationId), name)
        try {
            const stat = fs.statSync(file)
            if (!stat.isFile()) return null
            return { name, path: file, type: typeOf(name), size: stat.size }
        } catch {
            return null
        }
    }

    /**
     * Everything stored for a conversation (uploads from Telegram and the
     * web, and any file the factory keeps for it): the directory goes with
     * the conversation, so nothing outlives the chat it belonged to.
     */
    remove(conversationId: string): number {
        const dir = this.dir(conversationId)
        if (!fs.existsSync(dir)) return 0
        const count = fs.readdirSync(dir).length
        fs.rmSync(dir, { recursive: true, force: true })
        log.info(`removed ${dir} (${count} file(s)) with its conversation`)
        return count
    }

    /** Directories of conversations that are deleted or unknown (a deletion that crashed half-way, a database restored from a backup). */
    sweep(isLive: (conversationId: string) => boolean): void {
        if (!fs.existsSync(this.root)) return
        for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
            if (entry.isDirectory() && !isLive(entry.name)) this.remove(entry.name)
        }
    }

    /** Files older than `days` go, then empty conversation directories. */
    prune(days: number): void {
        if (days <= 0 || !fs.existsSync(this.root)) return
        const cutoff = Date.now() - days * 86_400_000
        let removed = 0
        for (const conversation of fs.readdirSync(this.root, { withFileTypes: true })) {
            if (!conversation.isDirectory()) continue
            const dir = path.join(this.root, conversation.name)
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const file = path.join(dir, entry.name)
                if (entry.isFile() && fs.statSync(file).mtimeMs < cutoff) {
                    fs.rmSync(file, { force: true })
                    removed++
                }
            }
            if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
        }
        if (removed) log.info(`pruned ${removed} file(s) older than ${days} days`)
    }
}

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/**
 * What the agent reads after the owner's text: one line per file with its
 * absolute path. The Read tool shows images and PDFs to the model and reads
 * text; anything else the agent may copy into the repository or inspect
 * with its tools.
 */
export function attachmentNote(attachments: Attachment[]): string {
    if (!attachments.length) return ''
    return [
        '',
        '',
        `[Attached by the owner: ${attachments.length === 1 ? 'one file' : `${attachments.length} files`}, saved on the factory's disk. Open each with the Read tool (it shows images and PDFs); copy one into a repository only when the task asks for it.]`,
        ...attachments.map((a) => `- ${a.path} (${a.type}, ${size(a.size)})`)
    ].join('\n')
}
