import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Claude Code writes every session to <CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<session>.jsonl.
 * We never duplicate that; we index and render it.
 */
export interface TranscriptSummary {
    session_id: string
    /** Claude Code's directory slug for the cwd ('/' replaced by '-', lossy). */
    workspace: string
    /** The real working directory, from the transcript's first entries; null for an empty file. */
    cwd: string | null
    path: string
    started_at: string
    updated_at: string
    size: number
    first_prompt: string | null
}

export interface TranscriptStats {
    total: number
    messages: number
    tokens_in: number
    tokens_out: number
}

export interface TranscriptEntry {
    uuid?: string
    parentUuid?: string | null
    type: string // user | assistant | summary | system | …
    timestamp?: string
    isSidechain?: boolean
    agentId?: string
    message?: {
        role?: string
        model?: string
        content?: string | Array<Record<string, unknown>>
        usage?: Record<string, number>
    }
    summary?: string
    toolUseResult?: unknown
}

const SESSION_FILE = /^([0-9a-f-]{36})\.jsonl$/

export class Transcripts {
    constructor(private readonly claudeDir: string) {}

    private get root(): string {
        return path.join(this.claudeDir, 'projects')
    }

    list(limit = 100, before?: string): TranscriptSummary[] {
        if (!fs.existsSync(this.root)) return []
        const out: TranscriptSummary[] = []
        for (const workspace of fs.readdirSync(this.root, { withFileTypes: true })) {
            if (!workspace.isDirectory()) continue
            const dir = path.join(this.root, workspace.name)
            for (const entry of fs.readdirSync(dir)) {
                const match = entry.match(SESSION_FILE)
                if (!match) continue
                const file = path.join(dir, entry)
                const stat = fs.statSync(file)
                if (stat.size === 0) continue
                out.push({
                    session_id: match[1],
                    // Claude Code encodes the cwd by replacing '/' with '-'; it is lossy, so keep it as is.
                    workspace: workspace.name,
                    cwd: null,
                    path: file,
                    started_at: stat.birthtime.toISOString(),
                    updated_at: stat.mtime.toISOString(),
                    size: stat.size,
                    first_prompt: null
                })
            }
        }
        out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        return (before ? out.filter((entry) => entry.updated_at < before) : out).slice(0, limit)
    }

    find(sessionId: string): TranscriptSummary | undefined {
        return this.list(10_000).find((entry) => entry.session_id === sessionId)
    }

    /**
     * A window of a transcript: the `limit` entries before index `before`
     * (default: the end), plus whole-file stats. The file is read once per
     * call; transcripts are append-only, so the indices are stable while a
     * client pages backwards.
     */
    async read(sessionId: string, options: { before?: number; limit?: number } = {}): Promise<{ entries: TranscriptEntry[]; offset: number; stats: TranscriptStats } | null> {
        const summary = this.find(sessionId)
        if (!summary) return null
        const all: TranscriptEntry[] = []
        const rl = readline.createInterface({ input: fs.createReadStream(summary.path) })
        for await (const line of rl) {
            if (!line.trim()) continue
            try {
                all.push(JSON.parse(line) as TranscriptEntry)
            } catch {
                // a partially written last line while the session is live
            }
        }
        const stats: TranscriptStats = { total: all.length, messages: 0, tokens_in: 0, tokens_out: 0 }
        for (const entry of all) {
            if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) stats.messages++
            const u = entry.message?.usage
            if (u) {
                stats.tokens_in += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
                stats.tokens_out += u.output_tokens ?? 0
            }
        }
        const end = Math.min(options.before ?? all.length, all.length)
        const offset = Math.max(0, end - (options.limit ?? 200))
        return { entries: all.slice(offset, end), offset, stats }
    }

    /** First user prompt and cwd of a transcript, for the list. Reads only the head of the file. */
    async head(file: string): Promise<{ first_prompt: string | null; cwd: string | null }> {
        const rl = readline.createInterface({ input: fs.createReadStream(file, { end: 64 * 1024 }) })
        let cwd: string | null = null
        let firstPrompt: string | null = null
        for await (const line of rl) {
            try {
                const entry = JSON.parse(line) as TranscriptEntry & { cwd?: string }
                if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
                if (firstPrompt || entry.type !== 'user' || entry.isSidechain) continue
                const content = entry.message?.content
                const text =
                    typeof content === 'string'
                        ? content
                        : (content ?? []).map((block) => (block.type === 'text' ? String(block.text ?? '') : '')).join('')
                if (text.trim()) firstPrompt = text.trim().slice(0, 120)
            } catch {
                // ignore
            }
            if (cwd && firstPrompt) break
        }
        rl.close()
        return { first_prompt: firstPrompt, cwd }
    }
}
