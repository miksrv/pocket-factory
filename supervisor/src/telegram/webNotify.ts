import type { Conversation, Task } from '../store/index.js'

export type WebNotice = 'reply' | 'ask'

export interface WebNotifyDeps {
    /** How long a web task's reply may stay unread, or its question unanswered, before Telegram hears of it; 0 = never. */
    afterMs: number
    task: (id: string) => Task | undefined
    conversation: (id: string) => Conversation | undefined
    notify: (kind: WebNotice, task: Task) => void
}

/**
 * The owner started a task in the web UI and walked away: the reply nobody
 * opened there, or the question nobody answered, goes to Telegram after
 * `afterMs`. "Opened" is the web's own read mark (the open thread in a
 * visible tab posts `/read` when the reply lands), so while the owner sits
 * at the browser Telegram stays quiet. Each timer checks the state again when
 * it fires; nothing is told twice. Once a task's question reached Telegram
 * the owner is there, so its reply follows at once.
 */
export class WebNotifier {
    private readonly timers = new Map<string, NodeJS.Timeout>()
    private readonly told = new Set<string>()
    private readonly escalated = new Set<string>()

    constructor(private readonly deps: WebNotifyDeps) {}

    /** A question of this task already went to Telegram: the rest of it talks there too. */
    isEscalated(taskId: string): boolean {
        return this.escalated.has(taskId)
    }

    /** Feed every task update. */
    onTask(task: Task): void {
        if (task.source !== 'web' || this.deps.afterMs <= 0) return
        if (task.status === 'running' && task.ask) {
            if (this.escalated.has(task.id)) return // the bot sends the next question itself
            this.schedule(`${task.id}:ask:${task.ask.request_id}`, this.deps.afterMs, () => {
                const current = this.deps.task(task.id)
                if (current?.status !== 'running' || current.ask?.request_id !== task.ask?.request_id) return false
                this.escalated.add(task.id)
                this.deps.notify('ask', current)
                return true
            })
        } else if (task.status === 'done' || task.status === 'failed') {
            const delay = this.escalated.has(task.id) ? 0 : this.deps.afterMs
            this.escalated.delete(task.id)
            this.schedule(`${task.id}:reply`, delay, () => {
                const current = this.deps.task(task.id)
                const conversation = current && this.deps.conversation(current.conversation_id)
                if (!current?.finished_at || !conversation || conversation.deleted_at) return false
                if (conversation.read_at && conversation.read_at >= current.finished_at) return false
                this.deps.notify('reply', current)
                return true
            })
        } else if (task.status === 'cancelled') {
            this.escalated.delete(task.id)
        }
    }

    stop(): void {
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.timers.clear()
    }

    private schedule(key: string, delay: number, fire: () => boolean): void {
        if (this.timers.has(key) || this.told.has(key)) return
        const timer = setTimeout(() => {
            this.timers.delete(key)
            if (fire()) this.told.add(key)
        }, delay)
        timer.unref?.()
        this.timers.set(key, timer)
    }
}
