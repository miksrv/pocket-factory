import { createHash } from 'node:crypto'

import type { Api } from 'grammy'

import { createLogger } from '../logger.js'
import type { TaskEvent } from '../store/index.js'
import { markdownToTelegramHtml } from './format.js'

const log = createLogger('draft')

/** How long a draft stays on the screen without an update (Telegram's rule), and how often one is refreshed before that. */
const KEEP_ALIVE_MS = 20_000
const MIN_INTERVAL_MS = 1500
const PROSE_MAX = 1200

export interface DraftState {
    /** The task's title (first line of its prompt) or the routine's name. */
    title: string
    /** What the head says before the title: `▶️ New chat in work`, `⏱`. */
    head: string
    startedAt: number
    /** Waiting for a slot, a window or an answer: told instead of the steps. */
    waiting: string | null
    steps: number
    /** The tool call under way, `Bash: yarn test`. */
    step: string | null
    /** The agent's last prose. */
    prose: string
}

/** What the agent is doing, in one line: the command, the file, the pattern, the question. */
export function toolSummary(name: string, input: unknown): string {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    for (const key of ['command', 'file_path', 'pattern', 'description', 'prompt', 'query', 'url', 'skill']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) {
            const one = value.trim().split('\n')[0]
            return `${name}: ${one.length > 90 ? `${one.slice(0, 90)}…` : one}`
        }
    }
    return name
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Time passed in a draft's head: `12 s`, `3 min`, `1 h 05`. */
function elapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 60) return `${s} s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} min`
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** The draft's text: Telegram HTML, or plain text for the retry after Telegram rejected the markup. */
export function draftText(state: DraftState, now = Date.now(), html = true): string {
    const esc = html ? escapeHtml : (text: string) => text
    const lines = [`${state.head} ${html ? `<b>${esc(state.title)}</b>` : state.title}`]
    if (state.waiting) lines.push(`⏳ ${esc(state.waiting)}`)
    else {
        const parts = [`${state.steps} step${state.steps === 1 ? '' : 's'}`, elapsed(now - state.startedAt)]
        if (state.step) parts.push(esc(state.step))
        lines.push(parts.join(' · '))
    }
    if (state.prose) {
        const prose = state.prose.length > PROSE_MAX ? `…${state.prose.slice(-PROSE_MAX)}` : state.prose
        lines.push('', html ? markdownToTelegramHtml(prose) : prose)
    }
    return lines.join('\n')
}

/** A stable non-zero draft id per task (Telegram animates updates to the same id). */
export const draftId = (taskId: string): number =>
    (createHash('sha1').update(taskId).digest().readUInt32BE(0) % 0x7ffffffe) + 1

interface Live {
    chatId: number
    thread: number | undefined
    draftId: number
    state: DraftState
    lastSentAt: number
    timer: NodeJS.Timeout | null
    dirty: boolean
}

/**
 * The task as it runs, streamed into the chat as a message draft
 * (`sendMessageDraft`, Bot API 9.3): the step count, the tool under way and
 * the agent's last words, refreshed as events arrive (at most one request
 * every 1.5 s) and kept alive every 20 s, since Telegram drops a draft after
 * 30 s of silence. The client shows a Stop button under it; a press stops the
 * task. The reply that ends the task replaces the draft.
 */
export class LiveDraft {
    private readonly live = new Map<string, Live>()

    constructor(
        private readonly api: Api,
        private readonly onStop: (taskId: string) => void
    ) {}

    start(taskId: string, chatId: number, state: DraftState, thread?: number): void {
        if (this.live.has(taskId)) {
            this.update(taskId, () => state)
            return
        }
        const entry: Live = {
            chatId,
            thread,
            draftId: draftId(taskId),
            state,
            lastSentAt: 0,
            timer: null,
            dirty: true
        }
        this.live.set(taskId, entry)
        this.flush(taskId)
    }

    has(taskId: string): boolean {
        return this.live.has(taskId)
    }

    /** Change the state (a wait began or ended, the head changed) and redraw. */
    update(taskId: string, change: (state: DraftState) => Partial<DraftState> | DraftState): void {
        const entry = this.live.get(taskId)
        if (!entry) return
        entry.state = { ...entry.state, ...change(entry.state) }
        entry.dirty = true
        this.schedule(taskId)
    }

    /** A stream event of the task: counts the step, remembers the tool and the prose of the orchestrator. */
    event(event: TaskEvent): void {
        const entry = this.live.get(event.task_id)
        if (!entry) return
        if (event.type === 'tool_use') {
            const p = event.payload as { name?: string; input?: unknown }
            entry.state.steps++
            entry.state.step = toolSummary(p.name ?? 'tool', p.input)
        } else if (event.type === 'agent') {
            const p = event.payload as { phase?: string; description?: string }
            if (p.phase === 'started') {
                entry.state.steps++
                entry.state.step = `sub-agent ${event.agent ?? ''}${p.description ? `: ${p.description}` : ''}`.trim()
            }
        } else if (event.type === 'text' && !event.agent) {
            const p = event.payload as { text?: string }
            if (p.text?.trim()) entry.state.prose = p.text.trim()
        } else return
        entry.state.waiting = null
        entry.dirty = true
        this.schedule(event.task_id)
    }

    /** The task ended (its reply is about to replace the draft) — or lost its chat. */
    end(taskId: string): void {
        const entry = this.live.get(taskId)
        if (!entry) return
        if (entry.timer) clearTimeout(entry.timer)
        this.live.delete(taskId)
    }

    /** The task behind a draft the owner stopped from the client. */
    stopped(chatId: number, draftId: number): void {
        for (const [taskId, entry] of this.live)
            if (entry.chatId === chatId && entry.draftId === draftId) {
                this.onStop(taskId)
                return
            }
    }

    stop(): void {
        for (const entry of this.live.values()) if (entry.timer) clearTimeout(entry.timer)
        this.live.clear()
    }

    private schedule(taskId: string): void {
        const entry = this.live.get(taskId)
        if (!entry) return
        const due = entry.dirty ? entry.lastSentAt + MIN_INTERVAL_MS : entry.lastSentAt + KEEP_ALIVE_MS
        const wait = Math.max(0, due - Date.now())
        if (entry.timer) {
            if (wait > 0 && !entry.dirty) return
            clearTimeout(entry.timer)
        }
        entry.timer = setTimeout(() => this.flush(taskId), wait)
        entry.timer.unref?.()
    }

    private flush(taskId: string): void {
        const entry = this.live.get(taskId)
        if (!entry) return
        entry.timer = null
        entry.dirty = false
        entry.lastSentAt = Date.now()
        const send = (text: string, parse: boolean) =>
            this.api.sendMessageDraft(entry.chatId, entry.draftId, text, {
                message_thread_id: entry.thread,
                parse_mode: parse ? 'HTML' : undefined,
                can_stop: true
            })
        send(draftText(entry.state), true)
            .catch(() => send(draftText(entry.state, Date.now(), false), false))
            .catch((error) =>
                log.warn(`draft for ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
            )
            .finally(() => {
                if (this.live.get(taskId) === entry) this.schedule(taskId)
            })
    }
}
