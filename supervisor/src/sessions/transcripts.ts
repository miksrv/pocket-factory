import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Claude Code writes every session to <CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<session>.jsonl.
 * We never duplicate that; we index and render it.
 */
export interface TranscriptSummary {
    session_id: string
    workspace: string
    path: string
    started_at: string
    updated_at: string
    size: number
    first_prompt: string | null
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

    list(limit = 100): TranscriptSummary[] {
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
                    workspace: workspace.name.replace(/^-/, '/').replace(/-/g, '/'),
                    path: file,
                    started_at: stat.birthtime.toISOString(),
                    updated_at: stat.mtime.toISOString(),
                    size: stat.size,
                    first_prompt: null
                })
            }
        }
        out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        return out.slice(0, limit)
    }

    find(sessionId: string): TranscriptSummary | undefined {
        return this.list(10_000).find((entry) => entry.session_id === sessionId)
    }

    async read(sessionId: string): Promise<TranscriptEntry[]> {
        const summary = this.find(sessionId)
        if (!summary) return []
        const entries: TranscriptEntry[] = []
        const rl = readline.createInterface({ input: fs.createReadStream(summary.path) })
        for await (const line of rl) {
            if (!line.trim()) continue
            try {
                entries.push(JSON.parse(line) as TranscriptEntry)
            } catch {
                // a partially written last line while the session is live
            }
        }
        return entries
    }

    /** First user prompt of a transcript, for list titles. Reads only the head of the file. */
    async firstPrompt(file: string): Promise<string | null> {
        const rl = readline.createInterface({ input: fs.createReadStream(file, { end: 64 * 1024 }) })
        for await (const line of rl) {
            try {
                const entry = JSON.parse(line) as TranscriptEntry
                if (entry.type !== 'user' || entry.isSidechain) continue
                const content = entry.message?.content
                const text =
                    typeof content === 'string'
                        ? content
                        : (content ?? []).map((block) => (block.type === 'text' ? String(block.text ?? '') : '')).join('')
                if (text.trim()) {
                    rl.close()
                    return text.trim().slice(0, 120)
                }
            } catch {
                // ignore
            }
        }
        return null
    }
}
