import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { Bot, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'

import { MODEL_ALIASES } from './claude/models.js'
import type { Config } from './config.js'
import { type Attachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from './files/inbox.js'
import { modelRef, parseModelRef } from './files/providers.js'
import { changesLine } from './git/changes.js'
import { createLogger } from './logger.js'
import type { Routines } from './routines/service.js'
import type { RoutineSpec } from './routines/spec.js'
import type { StepOutput, StepResult } from './routines/steps.js'
import type { SandboxManager } from './sandbox/manager.js'
import type { Previews } from './sandbox/previews.js'
import type { Vault } from './secrets/vault.js'
import type { Ask, Conversation, RateLimitSnapshot, RoutineRun, Store, Task, TaskEvent } from './store/index.js'
import { transcribe } from './stt/groq.js'
import {
    type Answer,
    askQuestions,
    type Delegation,
    openQuestions,
    type TaskService,
    titleFrom
} from './tasks/service.js'
import { type DraftState, LiveDraft } from './telegram/draft.js'
import {
    findRoutine,
    parseRoutineData,
    previewText,
    routineCard,
    routineData,
    routinesList,
    runsText
} from './telegram/routinesMenu.js'
import { DeliveryError, EFFECT, sendMarkdown, sendReply } from './telegram/send.js'
import {
    type Button,
    buttonBaseUrl,
    editView,
    errorText,
    escapeHtml,
    replyParameters,
    row,
    sendView,
    text,
    type View,
    type ViewSendOptions
} from './telegram/view.js'
import { WebNotifier } from './telegram/webNotify.js'
import { VERSION } from './version.js'
import { describeUserAgent, type LoginNotice, type WebAuth } from './web/auth.js'

const log = createLogger('bot')

const pct = (used: number) => `${Math.round(used * 100)}%`

function resetsIn(iso: string): string {
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return 'now'
    const h = Math.floor(ms / 3_600_000)
    const m = Math.round((ms % 3_600_000) / 60_000)
    if (h >= 48) return `${Math.round(h / 24)}d`
    return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** `Tue 17:00` in the owner's zone. */
function clockAt(iso: string, timeZone: string): string {
    return new Date(iso).toLocaleString('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * What the owner hears about a routine's run row, or null. Errors, missed
 * minutes and a firing stuck behind the previous run are told once per
 * distinct note (`lastNotice` remembers it per routine). A firing skipped
 * for the soft-stop is told every time, unless the routine says
 * `notify: none`: it would have sent a report, so silence would read as a
 * dead factory.
 */
export function routineNotice(
    run: RoutineRun,
    spec: RoutineSpec | null,
    lastNotice: Map<string, string>,
    timeZone: string
): string | null {
    const note = run.note ?? ''
    if (run.status === 'skipped' && note.startsWith('soft stop')) {
        if (spec?.notify === 'none') return null
        const reason = note.replace(/^soft stop: /, '').replace(/, resets \S+/, '')
        const resets = /resets (\S+)/.exec(note)?.[1]
        const until =
            resets && !Number.isNaN(Date.parse(resets)) ? `${clockAt(resets, timeZone)} (in ${resetsIn(resets)})` : null
        return `⏸ Routine **${run.schedule}** skipped this run: subscription ${reason}.${until ? ` Routine runs resume after the reset, ${until}.` : ''} /run ${run.schedule} runs it anyway.`
    }
    const stuck = run.status === 'skipped' && note.startsWith('the previous run is still')
    if (run.status !== 'error' && run.status !== 'missed' && run.status !== 'done' && !stuck) {
        if (run.status !== 'skipped') lastNotice.delete(run.schedule)
        return null
    }
    if (run.status === 'done') {
        // A good run ends an error streak, so the same error later is told again.
        lastNotice.delete(run.schedule)
        // Run now was pressed where its result shows (the card in Telegram, the page in the web): no second notice.
        if (spec?.notify === 'none' || run.trigger === 'manual') return null
        return `✅ Routine **${run.schedule}** ran its steps${run.items ? ` (${run.items} new item(s))` : ''}:\n\n${note || '(no output)'}`
    }
    // A run by hand tells its outcome where it was pressed (the card's note, the routine's page).
    if (run.trigger === 'manual') return null
    if (lastNotice.get(run.schedule) === note) return null
    lastNotice.set(run.schedule, note)
    return run.status === 'missed'
        ? `⏭ Routine **${run.schedule}** ${run.note ?? 'missed a firing'}. /run ${run.schedule} starts it now.`
        : stuck
          ? `⏸ Routine **${run.schedule}** skipped a firing: ${run.note}. It waits for your answer or for the task to end.`
          : `⚠️ Routine **${run.schedule}** could not run: ${run.note ?? 'unknown error'}`
}

/**
 * What the owner hears when a run's scripts after the agent are done: each with ✅ / ❌, its time and
 * the head of what it printed (a published URL, an error). Null for `notify: none`.
 */
export function afterNotice(
    run: RoutineRun,
    spec: RoutineSpec,
    steps: StepResult[],
    outputs: StepOutput[]
): string | null {
    if (spec.notify === 'none' || !steps.length) return null
    const lines = steps.map((step, i) => {
        const out = (outputs[i]?.output ?? '').trim()
        const shown = out.length > 600 ? `${out.slice(0, 600)}…` : out
        return `${step.ok ? '✅' : '❌'} ${step.name} (${Math.round(step.ms / 1000)} s)${shown ? `\n\`\`\`\n${shown}\n\`\`\`` : ''}`
    })
    return `⏱ **${run.schedule}**, after the agent:\n\n${lines.join('\n')}`
}

/** Time passed since `iso`: `under a minute`, `5 min`, `3 h`, `2 d`. */
function elapsed(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return 'under a minute'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h`
    return `${Math.floor(ms / 86_400_000)} d`
}

/** One line: how full the subscription windows are, e.g. "5h 12% · week 31%". */
function limitsLine(limits: RateLimitSnapshot | undefined): string | null {
    if (!limits) return null
    const parts: string[] = []
    if (limits.five_hour) parts.push(`5h ${pct(limits.five_hour.used)}`)
    if (limits.seven_day) parts.push(`week ${pct(limits.seven_day.used)}`)
    return parts.length ? parts.join(' · ') : null
}

function limitsReport(limits: RateLimitSnapshot | undefined): string[] {
    if (!limits)
        return ['Subscription limits: unknown yet — the CLI reports them with the first task, or press Refresh.']
    const lines: string[] = []
    if (limits.five_hour)
        lines.push(
            `5-hour window: ${pct(limits.five_hour.used)} used · resets in ${resetsIn(limits.five_hour.resets_at)}`
        )
    if (limits.seven_day)
        lines.push(
            `Weekly window: ${pct(limits.seven_day.used)} used · resets in ${resetsIn(limits.seven_day.resets_at)}`
        )
    if (limits.status !== 'allowed') lines.push(`Status: ${limits.status}`)
    lines.push(`As of ${new Date(limits.ts).toLocaleString('en-GB', { hour12: false })}`)
    return lines
}

/** One line per role the task handed work to: where it ran, or why not on its provider. */
export function delegationLines(delegations: Delegation[]): string[] {
    return delegations.map((d) =>
        d.fallback
            ? `${d.agent} ran on the subscription${d.model ? ` (${d.model})` : ''}: ${d.fallback}`
            : `${d.agent} on ${d.provider ?? 'the subscription'}${d.model ? ` · ${d.model}` : ''}`
    )
}

/**
 * Footer under every reply, one fact per line: which project the agent
 * worked in (the owner reads several threads on a phone and forgets), what
 * it changed, the roles it delegated and where they ran, and how full the
 * windows are now, with this task's share. Turns, tokens and duration stay on
 * the task page: the subscription is metered in windows, not money.
 */
export function footer(
    task: Task,
    limits: RateLimitSnapshot | undefined,
    publicUrl: string | null,
    delegations: Delegation[] = []
): string[] {
    const delta = task.window_5h_delta
    const share = delta === null ? null : delta < 0.01 ? 'this task <1%' : `this task +${Math.round(delta * 100)}%`
    // A task on another provider touches no subscription window: name the provider and the tokens instead.
    const tokens = task.input_tokens + task.output_tokens + task.cache_creation_tokens
    const windows = task.provider
        ? `${task.provider}${task.model ? ` · ${task.model}` : ''} · ${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens, no subscription window`
        : [limitsLine(limits), share].filter(Boolean).join(' · ')
    // What the task changed, so the phone decides from the summary; the task page has the files and the diff.
    const changed = changesLine(task.git)
    const pr = task.git?.pr
        ? `PR #${task.git.pr.number}${task.git.pr.state === 'OPEN' ? '' : ` (${task.git.pr.state.toLowerCase()})`} ${task.git.pr.url}`
        : null
    const review = changed && publicUrl ? `review: ${publicUrl}/tasks/${task.id}#changes` : null
    return [
        `project: ${task.project ?? 'none (workspaces root)'}`,
        changed
            ? `changes: ${[changed, task.git?.branch ? `on ${task.git.branch}` : null].filter(Boolean).join(' ')}${task.git?.uncommitted ? ` · ${task.git.uncommitted} uncommitted` : ''}`
            : null,
        pr,
        review,
        ...delegationLines(delegations),
        windows ? `windows: ${windows}` : null
    ].filter((line): line is string => Boolean(line))
}

/** What a permission request is about, in one line: the command, the file, or the arguments. */
function permissionSummary(input: Record<string, unknown>): string {
    for (const key of ['command', 'file_path', 'pattern', 'description', 'prompt', 'query', 'url']) {
        if (typeof input[key] === 'string') return String(input[key]).slice(0, 600)
    }
    const json = JSON.stringify(input)
    return json.length > 600 ? `${json.slice(0, 600)}…` : json
}

/**
 * A question of the agent as a message: the question, its options with
 * their descriptions, and one button per option inside the message; free
 * text is the "Other" choice. A question without options asks the client for
 * a reply, which lands in the right conversation whichever chat is the
 * topic; one with buttons does not: Telegram never edits a message sent with
 * `force_reply`, so its buttons would outlive the answer. A permission
 * request gets a green Allow and a red Deny.
 */
export function askMessage(task: Task, ask: Ask): { key: string; view: View; forceReply: boolean } | null {
    if (ask.kind === 'permission') {
        return {
            key: ask.request_id,
            forceReply: false,
            view: [
                text(
                    `🔐 The agent asks to run <b>${escapeHtml(ask.tool_name)}</b>:\n<pre>${escapeHtml(permissionSummary(ask.input))}</pre>`
                ),
                row(
                    { text: '✅ Allow', data: `p|${task.id}|allow|${askTag(ask.request_id)}`, style: 'success' },
                    { text: '⛔ Deny', data: `p|${task.id}|deny|${askTag(ask.request_id)}`, style: 'danger' }
                )
            ]
        }
    }
    const questions = askQuestions(ask)
    const next = openQuestions(ask)[0]
    if (!next) return null
    const index = questions.indexOf(next)
    const lines = [`❓ ${next.header ? `<b>${escapeHtml(next.header)}</b>: ` : ''}${escapeHtml(next.question)}`]
    const options = next.options ?? []
    if (options.length) {
        lines.push('')
        for (const option of options)
            lines.push(
                `• <b>${escapeHtml(option.label)}</b>${option.description ? ` — ${escapeHtml(option.description)}` : ''}`
            )
    }
    lines.push(
        '',
        options.length
            ? next.multiSelect
                ? 'Tap an option, or reply with your answer (several: comma-separated).'
                : 'Tap an option, or reply with your answer.'
            : 'Reply with your answer.'
    )
    if (questions.length > 1) lines.push(`(question ${index + 1} of ${questions.length})`)
    const view: View = [text(lines.join('\n'))]
    // Every option on a row of its own: labels are sentences, and a row of them would not fit a phone.
    options.forEach((option, i) =>
        view.push(
            row({
                text: Array.from(option.label).slice(0, 60).join(''),
                data: `a|${task.id}|${index}|${i}|${askTag(ask.request_id)}`,
                style: 'primary'
            })
        )
    )
    return { key: `${ask.request_id}:${index}`, view, forceReply: !options.length }
}

/** A short tag of an ask's request id: its buttons carry it, so a late or double tap never answers a newer request. */
export const askTag = (requestId: string): string => createHash('sha1').update(requestId).digest('hex').slice(0, 8)

/** A tap on a button whose request is settled: said as a toast, not an alert, since nothing went wrong. */
export class StaleTap extends Error {}

/**
 * A tap on a question's option (`a|<task>|<question>|<option>|<tag>`) or a
 * permission's button (`p|<task>|allow|<tag>`) as the answer to the task's
 * open ask, or a StaleTap when that ask is not the one the button was sent
 * for. `task` is the task as it is now; `answered` what the request the
 * button names was settled with, when the bot knows.
 */
export function askTap(
    data: string,
    task: Pick<Task, 'status' | 'ask'> | null | undefined,
    answered?: string
): { taskId: string; answer: Answer; said: string } {
    const [kind, taskId, b, c, d] = data.split('|')
    const tag = kind === 'p' ? c : d
    const ask = task?.ask
    if (!ask || !tag || askTag(ask.request_id) !== tag || ask.kind !== (kind === 'p' ? 'permission' : 'question'))
        throw new StaleTap(
            answered
                ? `Already answered: ${answered}`
                : task && task.status !== 'running'
                  ? 'The task has ended: nothing waits for this answer any more.'
                  : 'This question is already answered.'
        )
    if (kind === 'p') {
        const allow = b === 'allow'
        return { taskId, answer: { behavior: allow ? 'allow' : 'deny' }, said: allow ? '✓ Allowed' : 'Denied' }
    }
    const question = askQuestions(ask)[Number(b)]
    const option = question?.options?.[Number(c)]
    if (!question || !option) throw new Error('this option is no longer available')
    return { taskId, answer: { answers: { [question.question]: option.label } }, said: `✓ ${option.label}` }
}

/** A callback query's answer: Telegram takes 200 characters at most and refuses the whole answer beyond. */
export const toast = (text: string): string => {
    const chars = Array.from(text)
    return chars.length > 190 ? `${chars.slice(0, 189).join('')}…` : text
}

/**
 * What the owner hears about the web UI's door, as HTML. The address, the
 * client and the name typed are the visitor's words: escaped, so a name
 * never turns into a link or markup in the owner's chat.
 */
export function signInNotice(
    notice: LoginNotice,
    policy: { max_failures: number; lock_minutes: number },
    timeZone: string
): string {
    const where = `from <code>${escapeHtml(notice.ip)}</code> (${escapeHtml(describeUserAgent(notice.userAgent))})`
    const name = notice.username ? ` as <code>${escapeHtml(notice.username)}</code>` : ''
    if (notice.kind === 'ok')
        return `🔓 Signed in to the web UI ${where}. Not you? Settings → Security → Sign out everywhere, and change WEB_AUTH_PASSWORD.`
    if (notice.kind === 'locked') {
        const until = new Date(notice.locked_until ?? Date.now()).toLocaleTimeString('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit'
        })
        return `🔒 Web sign-in locked for ${where} until ${until} after ${notice.failures} wrong passwords${name}.`
    }
    return `⚠️ Wrong web password ${where}${name}. ${policy.max_failures - notice.failures} more and that address is locked for ${policy.lock_minutes} min.`
}

/**
 * How a Telegram chat talks to the agent. `fresh` (default): every message
 * without a reply starts a new chat, so a self-contained skill does not drag
 * the last task's context along; a reply continues the chat of the message it
 * answers. `thread`: one conversation until `/new`, a reply switches to its
 * conversation and stays there.
 */
export type ChatMode = 'fresh' | 'thread'

/**
 * Where a message goes: the conversation of the message it replies to (when
 * the bot still knows it), the chat's topic, or a new chat. A question the
 * topic's agent waits on takes a plain message as its answer in both modes,
 * and a topic with no task yet (right after `/new`) takes the message instead
 * of a second empty chat.
 */
export function routeMessage(input: {
    mode: ChatMode
    replied: boolean
    topicAsks: boolean
    topicEmpty: boolean
}): 'replied' | 'topic' | 'fresh' {
    if (input.replied) return 'replied'
    if (input.mode === 'thread' || input.topicAsks || input.topicEmpty) return 'topic'
    return 'fresh'
}

const QUOTE_MAX = 3000

/** The message a reply answers, quoted for a new chat when its own conversation is gone; null for nothing to quote. */
export function quoteReply(text: string | undefined): string | null {
    const body = text?.trim()
    if (!body) return null
    const cut = body.length > QUOTE_MAX ? `${body.slice(0, QUOTE_MAX)}…` : body
    return ['In reply to this earlier message (its chat is gone):', ...cut.split('\n').map((line) => `> ${line}`)].join(
        '\n'
    )
}

/**
 * The owner's message carries the task's state as a reaction, so a glance at
 * the chat says where every task stands without a message per step: seen,
 * working, asking, waiting for the window, done, failed, stopped.
 */
export const REACTION = {
    seen: '👀',
    working: '👨‍💻',
    asking: '🤔',
    waiting: '😴',
    done: '👍',
    failed: '💔',
    stopped: '🫡'
} as const satisfies Record<string, ReactionTypeEmoji['emoji']>
export type Reaction = (typeof REACTION)[keyof typeof REACTION]

/** The reaction a task's state earns on the owner's message. */
export function reactionFor(task: Pick<Task, 'status' | 'ask' | 'not_before'>): Reaction {
    switch (task.status) {
        case 'queued':
            return task.not_before ? REACTION.waiting : REACTION.seen
        case 'running':
            return task.ask ? REACTION.asking : REACTION.working
        case 'done':
            return REACTION.done
        case 'cancelled':
            return REACTION.stopped
        default:
            return REACTION.failed
    }
}

const MODE_META = 'telegram.mode'

/** What a new chat of a Telegram chat starts with in `fresh` mode: `/new <project>`, `/model <provider>:<model>`. */
interface ChatDefaults {
    project: string | null
    provider: string | null
    model: string | null
}

/** The buttons that open the bot's main views, under `/help` and `/status`. */
const MENU: Button[] = [
    { text: '📋 Routines', data: 'v|routines' },
    { text: '📊 Status', data: 'v|status' },
    { text: '🧠 Model', data: 'v|model' },
    { text: '📈 Usage', data: 'v|usage' }
]

export function createBot(
    config: Config,
    tasks: TaskService,
    store: Store,
    routines?: Routines,
    auth?: WebAuth,
    vault?: Vault,
    sandbox?: { sandboxes: SandboxManager; previews: Previews }
): Bot {
    if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set')
    const bot = new Bot(config.telegram.botToken)
    const publicUrl = config.web.publicUrl
    // Links in buttons only to an address Telegram accepts there; text links still use publicUrl.
    const buttonUrl = buttonBaseUrl(publicUrl)

    // A chat talks to one conversation at a time — its topic: its own by
    // default, or the one the owner switched to by replying to a message of
    // the bot (a routine's report, a question). `/new` switches back.
    const topicFor = (chatId: number): Conversation =>
        store.telegramTopic(chatId) ?? tasks.conversationFor('telegram', String(chatId))
    // A question, not a use: it never creates the chat's own conversation (an empty chat in the list).
    const isTopic = (chatId: number, conversationId: string) =>
        (store.telegramTopic(chatId) ?? store.findConversation('telegram', String(chatId)))?.id === conversationId
    /** The bot sent a message about a conversation: a reply to it later continues that conversation. */
    const remember = (
        chatId: number,
        messageIds: number | number[],
        conversationId: string,
        taskId: string | null = null
    ) => {
        for (const id of Array.isArray(messageIds) ? messageIds : [messageIds])
            store.rememberTelegramMessage(chatId, id, conversationId, taskId)
    }
    const topicName = (conversation: Conversation) =>
        conversation.title || (conversation.channel === 'telegram' ? 'this chat' : 'web conversation')
    // Where routine runs report and ask: the owner's private chat (a user's chat id is the user id).
    const ownerChat = [...config.telegram.allowedUserIds][0]
    /**
     * A web task the owner left (reply unopened, question unanswered, see
     * WebNotifier) goes to Telegram: the chat whose topic its thread is, else
     * the owner's.
     */
    const notifier = new WebNotifier({
        afterMs: config.telegram.webNotifyAfterMs,
        task: (id) => tasks.task(id),
        conversation: (id) => store.getConversation(id),
        notify: (kind, task) => (kind === 'reply' ? void deliverWeb(task) : askFromWeb(task))
    })
    /** The chat a task talks to: its own for a Telegram task, the owner's for a routine run or a topic's, none otherwise. */
    const chatFor = (task: Task): number | null => {
        if (task.source === 'routine' || task.source === 'cron')
            return task.schedule && routines?.spec(task.schedule)?.notify === 'none' ? null : (ownerChat ?? null)
        // A chat a routine's run handed work to talks where that run does (its questions; the run reports).
        if (task.source === 'handoff') {
            const run = task.handed_by ? tasks.task(task.handed_by) : undefined
            return run ? chatFor(run) : null
        }
        const conversation = tasks.conversationOf(task)
        if (!conversation) return null
        if (conversation.channel === 'telegram') return Number(conversation.external_id) || null
        // A Telegram message into another conversation (a routine's thread): the chat that has it as its topic.
        if (task.source === 'telegram') return store.telegramChatsFor(conversation.id)[0] ?? ownerChat ?? null
        // A web task whose question already reached Telegram: its next questions follow there.
        if (task.source === 'web' && notifier.isEscalated(task.id)) return webChatFor(conversation)
        return null
    }
    const webChatFor = (conversation: Conversation): number | null =>
        store.telegramChatsFor(conversation.id)[0] ?? ownerChat ?? null
    /** The chat follows the thread it was told about: the next message there continues it, as after a reply. */
    const switchTo = (chatId: number, conversation: Conversation) => {
        if (!isTopic(chatId, conversation.id)) store.setTelegramTopic(chatId, conversation.id)
    }
    const mode = (): ChatMode => (store.getMeta<ChatMode>(MODE_META) === 'thread' ? 'thread' : 'fresh')
    const fromWeb = (conversation: Conversation) =>
        mode() === 'fresh'
            ? `💻 **${topicName(conversation)}** — from the web. Reply to this message to continue it.`
            : `💻 **${topicName(conversation)}** — from the web. This chat now continues that thread; /new comes back.`
    const defaultsKey = (chatId: number) => `telegram.chat.${chatId}`
    const defaultsFor = (chatId: number): ChatDefaults => ({
        project: null,
        provider: null,
        model: null,
        ...store.getMeta<Partial<ChatDefaults>>(defaultsKey(chatId))
    })
    const setDefaults = (chatId: number, patch: Partial<ChatDefaults>) =>
        store.setMeta(defaultsKey(chatId), { ...defaultsFor(chatId), ...patch })
    /** A new conversation of the chat, made its topic: in the chat's project and on its provider, if it has them. */
    const freshConversation = (chatId: number): Conversation => {
        const defaults = defaultsFor(chatId)
        const project = defaults.project && tasks.hasProject(defaults.project) ? defaults.project : null
        let conversation = tasks.newConversation('telegram', String(chatId), null, project)
        if (defaults.provider) {
            try {
                conversation = tasks.setConversationModel(conversation.id, defaults.provider, defaults.model)
            } catch (error) {
                log.warn(`chat ${chatId}: provider ${defaults.provider} left out: ${errorText(error)}`)
            }
        }
        store.setTelegramTopic(chatId, conversation.id)
        return conversation
    }
    /** The live conversation of the message a reply answers: a message of the bot or of the owner, while remembered. */
    const repliedConversation = (chatId: number, replyTo: { message_id: number } | undefined): Conversation | null => {
        const target = replyTo ? store.telegramMessage(chatId, replyTo.message_id) : undefined
        const found = target ? store.getConversation(target.conversation_id) : undefined
        return found && !found.deleted_at ? found : null
    }
    const isEmpty = (conversation: Conversation) =>
        !store.listTasks({ conversationId: conversation.id, limit: 1 }).length

    // grammY handles one update at a time, so anything slow runs detached:
    // a /stop sent during a probe or a transcription must not wait for it.
    const detached = (label: string, work: () => Promise<void>) => {
        void work().catch((error) => log.error(`${label} failed`, error))
    }
    /** A view sent to a chat, remembered for the task it is about (a reply to it continues that chat). */
    const send = async (chatId: number, view: View, options: ViewSendOptions & { taskId?: string | null } = {}) => {
        const id = await sendView(bot, chatId, view, options)
        const task = options.taskId ? tasks.task(options.taskId) : undefined
        if (task) remember(chatId, id, task.conversation_id, task.id)
        return id
    }
    /** A message the bot sent, replaced by the view. */
    const editSent = async (chatId: number, messageId: number, view: View, taskId?: string | null) => {
        await editView(bot, chatId, messageId, view)
        const task = taskId ? tasks.task(taskId) : undefined
        if (task) remember(chatId, messageId, task.conversation_id, task.id)
    }
    /** The message under a tapped button, replaced by the view. */
    const edit = async (ctx: Context, view: View, taskId?: string | null) => {
        const message = ctx.callbackQuery?.message
        if (message) await editSent(message.chat.id, message.message_id, view, taskId)
    }
    /** `edit` after the tap was answered: a flood wait in it must not hold up the next update. */
    const redraw = (ctx: Context, view: View, taskId?: string | null) =>
        detached('redraw', () => edit(ctx, view, taskId))

    // ---- the owner's message: a reaction per state, a draft while it runs -----------------

    /** The owner's message that started a task: the reactions sit on it, the reply quotes it. */
    const origins = new Map<string, { chatId: number; messageId: number; reaction: Reaction | null }>()
    const react = (taskId: string, reaction: Reaction) => {
        const origin = origins.get(taskId)
        if (!origin || origin.reaction === reaction) return
        origin.reaction = reaction
        bot.api
            .setMessageReaction(origin.chatId, origin.messageId, [{ type: 'emoji', emoji: reaction }])
            .catch((error) => log.warn(`reaction on ${origin.messageId} failed: ${errorText(error)}`))
    }
    /** The task as it runs, typed into the chat as a draft; its Stop button stops the task. */
    const draft = new LiveDraft(bot.api, (taskId) => {
        if (tasks.stop(taskId)) log.info(`task ${taskId} stopped from the draft`)
    })
    const draftState = (task: Task, extra: Partial<DraftState> = {}): DraftState => ({
        head: task.schedule ? '⏱' : '▶️',
        title: task.schedule ?? titleFrom(task.prompt),
        startedAt: Date.parse(task.started_at ?? task.created_at),
        waiting: null,
        steps: 0,
        step: null,
        ...extra
    })
    const waitingFor = (task: Task): string | null =>
        task.status === 'queued'
            ? task.not_before
                ? `subscription limit, continues at ${clockAt(task.not_before, config.timezone)}`
                : 'waiting for a free slot'
            : null

    // Whitelist: the bot fronts an agent with repository access, so it must
    // ignore everyone who is not the owner. (A stopped draft names only the
    // chat; in a private chat that is the user.)
    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id ?? ctx.chat?.id
        if (!userId || !config.telegram.allowedUserIds.has(userId)) {
            log.warn(`ignored update from user ${userId ?? 'unknown'}`)
            return
        }
        await next()
    })

    // ---- /help ---------------------------------------------------------------------------------

    const helpView = (): View => {
        const fresh = mode() === 'fresh'
        return [
            text(
                [
                    '<b>Pocket Factory is online.</b>',
                    '',
                    fresh
                        ? 'Send a task as text or voice. Every message starts a new chat; reply to a message (mine or yours) to continue its chat.'
                        : 'Send a task as text or voice. Replies continue the same Claude Code session.',
                    'Photos and files go with the task: send them with a caption, or first and then the text.',
                    'Your message gets a reaction as the task moves: 👀 seen · 👨‍💻 working · 🤔 asking you · 😴 waiting for the window · 👍 done · 💔 failed · 🫡 stopped. While it works, a draft under the chat counts the steps; its Stop button stops the task.',
                    fresh
                        ? 'A question of the agent takes your next message as the answer, or a tap on one of its buttons.'
                        : 'Reply to a message of mine (a report, a question) to continue in its conversation; /new comes back to a fresh one.',
                    fresh
                        ? 'A web task you left (reply unopened, question unanswered for a couple of minutes) comes here; reply to it to continue.'
                        : 'A web task you left (reply unopened, question unanswered for a couple of minutes) comes here, and this chat switches to its thread.',
                    '',
                    '/routines — every routine with its buttons: run, switch on / off, details',
                    '/run &lt;name&gt; — fire a routine now',
                    '/status — what is going on, with a Stop button',
                    '/usage — subscription limits (5-hour and weekly windows)',
                    "/model — the orchestrator's model; /model &lt;provider&gt;:&lt;model&gt; puts this chat on another provider",
                    fresh
                        ? '/new — pick the project new chats run in, on buttons; /new &lt;project&gt; picks it by name'
                        : '/new [project] — start a fresh session; with a project name, inside its checkout',
                    `/mode — ${fresh ? 'a new chat per message now; thread keeps one session until /new' : 'one session until /new now; fresh starts a new chat per message'}`,
                    '/stop — cancel the running task (as a reply: the task of that chat)'
                ].join('\n')
            ),
            row(...MENU)
        ]
    }
    bot.command(['start', 'help'], async (ctx) => {
        await send(ctx.chat.id, helpView())
    })

    // ---- routines: a list with buttons per routine, a card per routine ----------------------

    const listView = (note?: string): View => routinesList(routines?.list() ?? [], buttonUrl, Date.now(), note)
    const cardView = (name: string, options: { note?: string; emptyRun?: number } = {}): View | null => {
        const view = routines?.get(name)
        if (!view) return null
        return routineCard(view, config.timezone, { ...options, webUrl: buttonUrl })
    }
    /** Said at once when a run is asked for: the steps before the agent may take a while. */
    const STARTING = '▶️ Started: running the steps…'
    /** Fire a routine by hand; the card's note says what came of it, and offers everything the poll sees when nothing was new. */
    const fireRoutine = async (
        name: string,
        everything = false
    ): Promise<{ note: string; run: RoutineRun; emptyRun?: number }> => {
        const run = await routines!.fire(name, 'manual', null, { everything })
        if (run.status === 'queued')
            return {
                run,
                note: `🤖 Steps done, the agent's task is queued${run.note ? ` (${run.note})` : ''}. Its report comes here; reply to it to follow up.`
            }
        if (run.status === 'empty')
            return {
                run,
                emptyRun: run.found || undefined,
                note: run.found
                    ? `Nothing started: ${run.note} — every item was handed to an earlier run. "Run with all" hands them over again.`
                    : `Nothing started: ${run.note ?? 'the sources found nothing'}.`
            }
        if (run.status === 'done')
            return {
                run,
                note: `✅ Done (no agent): ${(run.note ?? '').slice(0, 400)}${(run.note?.length ?? 0) > 400 ? '…' : ''}`
            }
        return {
            run,
            note: `${run.status === 'skipped' ? '⏸ Skipped' : '⚠️ ' + run.status}${run.note ? ` — ${run.note}` : ''}`
        }
    }

    bot.command(['routines', 'run'], async (ctx) => {
        if (!routines) return void (await ctx.reply('Routines are not available.'))
        const name = ctx.match.trim()
        if (!name) return void (await send(ctx.chat.id, listView()))
        if (!routines.get(name))
            return void (await send(ctx.chat.id, [
                text(`No routine named "${escapeHtml(name)}".`),
                row({ text: '📋 Routines', data: routineData('list') })
            ]))
        // The steps may take minutes: the bot keeps answering meanwhile, and the card says at once
        // that the run started; it is edited with what came of it.
        const chatId = ctx.chat.id
        detached('routine run', async () => {
            const messageId = await send(chatId, cardView(name, { note: STARTING }) ?? listView(STARTING))
            try {
                const { note, run, emptyRun } = await fireRoutine(name)
                await editSent(chatId, messageId, cardView(name, { note, emptyRun }) ?? listView(), run.task_id)
            } catch (error) {
                await editSent(chatId, messageId, [
                    text(`<b>${escapeHtml(name)}</b>: ❌ ${escapeHtml(errorText(error))}`),
                    backRow(name)
                ])
            }
        })
    })

    /**
     * A button of the routines menu: `r|<action>|<key>`. The list and the cards edit the message
     * they sit under. The tap is acknowledged first: a step may take seconds, and Telegram
     * forgets a callback query after a while, so the answer would be lost and the owner would
     * see a tap that did nothing (2026-10-16, "Run now did not start the routine").
     */
    const routineButton = async (ctx: Context & { callbackQuery: { data: string } }) => {
        const parsed = parseRoutineData(ctx.callbackQuery.data)
        if (!parsed || !routines) throw new Error('routines are not available')
        const chatId = ctx.chat!.id
        const view = parsed.key === null ? undefined : findRoutine(routines.list(), parsed.key)
        if (parsed.action !== 'list' && !view) throw new Error('this routine is gone')
        const name = view?.name ?? ''
        switch (parsed.action) {
            case 'list':
                await ctx.answerCallbackQuery()
                return redraw(ctx, listView())
            case 'card':
                await ctx.answerCallbackQuery()
                return redraw(ctx, cardView(name)!)
            case 'open': {
                await ctx.answerCallbackQuery()
                const card = cardView(name)!
                return detached('routine card', async () => void (await send(chatId, card)))
            }
            case 'run':
            case 'all':
            case 'fire': {
                await ctx.answerCallbackQuery({ text: toast(`▶️ ${name}…`) })
                // The query is answered already: what goes wrong from here is said in the message itself.
                // Detached, as the steps may take minutes and grammY handles one update at a time.
                // The message says at once that the run started (a new one for `fire`, the list or the
                // card otherwise) and is edited with what came of it.
                detached('routine run', async () => {
                    const line = (note: string) => [
                        text(`<b>${escapeHtml(name)}</b>: ${escapeHtml(note)}`),
                        backRow(name)
                    ]
                    const fired = parsed.action === 'fire' ? await send(chatId, line(STARTING)) : null
                    const show = (view: View, taskId?: string | null) =>
                        fired === null ? edit(ctx, view, taskId) : editSent(chatId, fired, view, taskId)
                    if (fired === null)
                        await edit(
                            ctx,
                            parsed.from === 'list'
                                ? listView(`${name}: ${STARTING}`)
                                : cardView(name, { note: STARTING })!
                        )
                    try {
                        const { note, run, emptyRun } = await fireRoutine(name, parsed.action === 'all')
                        if (parsed.action === 'fire') await show(line(note), run.task_id)
                        else if (parsed.from === 'list') await show(listView(`${name}: ${note}`), run.task_id)
                        else await show(cardView(name, { note, emptyRun })!, run.task_id)
                    } catch (error) {
                        await show([
                            text(`<b>${escapeHtml(name)}</b>: ❌ ${escapeHtml(errorText(error))}`),
                            backRow(name)
                        ])
                    }
                })
                return
            }
            case 'on':
            case 'off': {
                const on = parsed.action === 'on'
                routines.setEnabled(name, on)
                await ctx.answerCallbackQuery({ text: toast(on ? `🟢 ${name} is on` : `⚪️ ${name} is off`) })
                // The list stays a list, the card stays a card.
                return redraw(ctx, parsed.from === 'list' ? listView() : cardView(name)!)
            }
            case 'runs':
                await ctx.answerCallbackQuery()
                return redraw(ctx, runsText(view!, routines.runs(name, 8, true), config.timezone))
            case 'preview': {
                await ctx.answerCallbackQuery({ text: 'Running the steps…' })
                // A step may take a while (a host, a timeout): the bot must not stall meanwhile.
                detached('routine preview', async () => {
                    try {
                        await edit(ctx, previewText(view!, await routines.preview(name)))
                    } catch (error) {
                        await edit(ctx, [
                            text(`👁 <b>${escapeHtml(name)}</b>: ❌ ${escapeHtml(errorText(error))}`),
                            backRow(name)
                        ])
                    }
                })
                return
            }
            default:
                await ctx.answerCallbackQuery()
        }
    }
    const backRow = (name: string) => row({ text: '📋 Routine', data: routineData('card', name) })

    // ---- /new, /model, /mode, /stop, /status, /usage ---------------------------------------

    // `/new` forgets the session; `/new <project>` also starts the next one inside that checkout.
    // The one project command (2026-10-05): `/project <name>` did the same minus a new thread and only confused.
    /** `/new` alone asks for the project on buttons: the first is no project, then every project with a checkout. */
    const projectPicker = (chatId: number): View => {
        const current = defaultsFor(chatId).project
        const projects = tasks
            .projects()
            .filter((slug) => tasks.hasProject(slug) && Buffer.byteLength(`n|${slug}`) <= 64)
            .sort()
        const buttons: Button[] = [
            current === null ? { text: '✓ No project', disabled: true } : { text: 'No project', data: 'n|-' },
            ...projects.map((slug): Button =>
                slug === current ? { text: `✓ ${slug}`, disabled: true } : { text: slug, data: `n|${slug}` }
            )
        ]
        const view: View = [
            text(
                mode() === 'fresh'
                    ? `New chats run ${current ? `in <b>${escapeHtml(current)}</b>` : 'without a project'}. Pick where the next ones run:`
                    : `Fresh session — in which project?`
            )
        ]
        for (let i = 0; i < buttons.length; i += 2) view.push(row(...buttons.slice(i, i + 2)))
        return view
    }
    /** `/new [project]` and the picker's button: the chat's project for new chats, and a fresh conversation now. */
    const startNew = (chatId: number, project: string | null): { said: string; conversation: Conversation } => {
        setDefaults(chatId, { project })
        const conversation = freshConversation(chatId)
        pending.delete(chatId)
        const said =
            mode() === 'fresh'
                ? project
                    ? `New chats run in ${project} from now on, from its checkout. /new alone picks another.`
                    : 'New chats run without a project from now on.'
                : project
                  ? `Fresh session in ${project}. Next message runs from its checkout.`
                  : 'Fresh session. Next message starts from scratch.'
        return { said, conversation }
    }
    bot.command('new', async (ctx) => {
        const project = ctx.match.trim() || null
        if (project && !tasks.hasProject(project)) {
            await ctx.reply(
                `Unknown project "${project}". Projects are the files in /data/config/projects; say "onboard project ${project}" to create one.`
            )
            return
        }
        // In fresh mode the project is a default for the chat's next chats: pick it on buttons. In thread
        // mode `/new` is the reset of the session (the old behaviour), and a name picks the project.
        if (!project && mode() === 'fresh' && tasks.projects().some((slug) => tasks.hasProject(slug))) {
            await send(ctx.chat.id, projectPicker(ctx.chat.id))
            return
        }
        const { said, conversation } = startNew(ctx.chat.id, project)
        const sent = await ctx.reply(said)
        remember(ctx.chat.id, sent.message_id, conversation.id)
    })

    /**
     * The model message: the factory's alias and this chat's provider, with
     * a button per alias (the current one pressed) and per provider.
     */
    const modelView = (chatId: number): View => {
        const conversation = topicFor(chatId)
        const fresh = mode() === 'fresh'
        const defaults = defaultsFor(chatId)
        const chatProvider = fresh ? defaults.provider : conversation.provider
        const chatModel = fresh ? defaults.model : conversation.model
        const current = tasks.model()
        const providers = tasks.providerStatus()
        const view: View = [
            text(
                [
                    `Model: <b>${current}</b> — the orchestrator in every chat; sub-agents keep their own.`,
                    chatProvider
                        ? `${fresh ? 'New chats here' : 'This chat'}: <b>${escapeHtml(modelRef(chatProvider, chatModel) ?? chatProvider)}</b> (claude comes back to the subscription).`
                        : providers.length
                          ? `${fresh ? 'New chats here' : 'This chat'}: the subscription. A provider button puts ${fresh ? 'them' : 'it'} on that box; /model &lt;provider&gt;:&lt;model&gt; names the model.`
                          : null
                ]
                    .filter(Boolean)
                    .join('\n')
            ),
            row(
                ...MODEL_ALIASES.map((alias): Button =>
                    alias === current ? { text: `✓ ${alias}`, disabled: true } : { text: alias, data: `m|${alias}` }
                )
            )
        ]
        if (providers.length)
            view.push(
                row(
                    chatProvider
                        ? { text: 'claude', data: 'm|claude', style: 'primary' }
                        : { text: '✓ claude', disabled: true },
                    // Telegram refuses callback data over 64 bytes, and with it the whole view: such a name stays /model's.
                    ...providers
                        .filter((p) => p.name === chatProvider || Buffer.byteLength(`m|${p.name}`) <= 64)
                        .map((p): Button =>
                            p.name === chatProvider
                                ? { text: `✓ ${p.name}`, disabled: true }
                                : { text: p.name, data: `m|${p.name}` }
                        )
                )
            )
        return view
    }
    /** Apply `/model <what>`: an alias for the factory, `claude` or `<provider>[:<model>]` for this chat. Returns what to say. */
    const applyModel = (chatId: number, what: string): string => {
        const alias = what.trim().toLowerCase()
        const conversation = topicFor(chatId)
        const fresh = mode() === 'fresh'
        // `provider:model` (or `claude`) is about this chat only: the factory's alias stays.
        if (alias.includes(':') || alias === 'claude' || tasks.providerStatus().some((p) => p.name === alias)) {
            const ref = parseModelRef(what.trim())
            if (fresh) {
                // Every message is a new chat: the choice goes to the chat's new chats, the running ones keep theirs.
                if (ref.provider && !tasks.providerStatus().some((p) => p.name === ref.provider))
                    throw new Error(`Unknown provider "${ref.provider}" (Settings → Providers)`)
                setDefaults(chatId, { provider: ref.provider, model: ref.provider ? ref.model : null })
                return ref.provider
                    ? `New chats here run on ${modelRef(ref.provider, ref.model)}.`
                    : `New chats here run on the subscription (${tasks.model()}).`
            }
            const updated = tasks.setConversationModel(conversation.id, ref.provider, ref.model)
            return updated.provider
                ? `This chat runs on ${modelRef(updated.provider, updated.model)} from the next task on (fresh session there).`
                : `This chat is back on the subscription (${tasks.model()}).`
        }
        const model = tasks.setModel(alias)
        return `Model: ${model} from the next task on, in every chat. A running task keeps the one it started with.`
    }
    // One model for the whole factory, applied to the next task everywhere; sub-agents keep the `model:` of their files.
    bot.command('model', async (ctx) => {
        const what = ctx.match.trim()
        if (what) {
            try {
                await ctx.reply(applyModel(ctx.chat.id, what))
            } catch (error) {
                await ctx.reply(`❌ ${errorText(error)}`)
            }
            return
        }
        await send(ctx.chat.id, modelView(ctx.chat.id))
    })

    // How messages map to chats (`ChatMode`); one setting for every chat of the bot, kept in meta.
    const modeView = (): View => {
        const fresh = mode() === 'fresh'
        return [
            text(
                fresh
                    ? 'Mode: <b>fresh</b>. Every message starts a new chat (no context of the last task); reply to a message to continue its chat. Thread keeps one session until /new.'
                    : 'Mode: <b>thread</b>. Messages continue one session until /new; a reply switches to its conversation. Fresh starts a new chat per message.'
            ),
            row(
                fresh ? { text: '✓ fresh', disabled: true } : { text: 'fresh', data: 'md|fresh' },
                fresh ? { text: 'thread', data: 'md|thread' } : { text: '✓ thread', disabled: true }
            )
        ]
    }
    bot.command('mode', async (ctx) => {
        const wanted = ctx.match.trim().toLowerCase()
        if (wanted === 'fresh' || wanted === 'thread') store.setMeta(MODE_META, wanted)
        else if (wanted) return void (await ctx.reply('Usage: /mode fresh | /mode thread'))
        await send(ctx.chat.id, modeView())
    })

    bot.command('stop', async (ctx) => {
        // As a reply: the task of that message's chat (several chats run side by side in `fresh` mode).
        const conversation = repliedConversation(ctx.chat.id, ctx.message?.reply_to_message) ?? topicFor(ctx.chat.id)
        // A task waiting in the queue (for a window reset, or behind a running one) is cancelled too.
        const active = tasks.activeTask(conversation.id) ?? tasks.queuedTask(conversation.id)
        if (!active) {
            await ctx.reply('Nothing is running.')
            return
        }
        tasks.stop(active.id)
        // A queued task ends at once, and its reply ("⏹ Stopped.") says so when it comes here: one message, not two.
        if (active.status === 'queued' && delivered(active)) return
        await ctx.reply(active.status === 'queued' ? '⏹ Cancelled.' : 'Stopping…')
    })

    // What the owner needs on a phone: where the next message goes, what runs now, the model
    // and the windows (2026-10-05: session id and the workspaces path were noise, the
    // conversation line is shown only when the chat was switched to another thread by a reply).
    /** The sandboxes in one line: how many run, whether the daemon answers, what waits for the owner. */
    const sandboxLine = (): string | null => {
        const status = sandbox?.sandboxes.status()
        if (!status || status.mode !== 'sbx') return null
        if (status.ok === false) return `Sandboxes: ⚠️ ${escapeHtml(status.error ?? 'the daemon does not answer')}`
        const running = status.sandboxes.filter((s) => s.status === 'running').length
        const extra = [
            status.approvals.length ? `${status.approvals.length} blocked request(s) waiting` : null,
            status.claude_login === false ? 'no Claude login' : null,
            status.docker_login === false ? 'no Docker login' : null
        ].filter(Boolean)
        return `Sandboxes: ${running} running of ${status.sandboxes.length}${extra.length ? ` · ${extra.join(' · ')}` : ''}`
    }
    const statusView = (chatId: number): View => {
        const conversation = topicFor(chatId)
        const fresh = mode() === 'fresh'
        const defaults = defaultsFor(chatId)
        // A topic is an override: after `/new` the chat's own (newest) conversation is the topic too.
        const switched =
            !fresh && conversation.id !== tasks.conversationFor('telegram', String(chatId)).id ? conversation : null
        const active = tasks.activeTask(conversation.id)
        const queued = active ? undefined : tasks.queuedTask(conversation.id)
        // Every task running anywhere (other chats, routines), so the phone sees the whole factory.
        const running = tasks
            .runningTaskIds()
            .map((id) => tasks.task(id))
            .filter((t): t is Task => Boolean(t))
        const windows = limitsLine(tasks.limits())
        const here = active
            ? `"${titleFrom(active.prompt)}" · ${active.started_at ? elapsed(active.started_at) : 'starting'}${active.ask ? ' · waiting for your answer' : ''}`
            : queued
              ? `"${titleFrom(queued.prompt)}" · queued, waiting for a free slot`
              : 'nothing'
        const current = active ?? queued
        const lines = [
            `<b>Pocket Factory v${VERSION}</b>`,
            fresh
                ? 'Mode: a new chat per message; reply to a message to continue its chat (/mode: one session)'
                : 'Mode: one thread until /new (/mode: a new chat per message)',
            switched ? `Thread: ${escapeHtml(topicName(switched))} (switched by your reply; /new comes back)` : null,
            fresh
                ? `Project of new chats: ${escapeHtml(defaults.project ?? 'none (workspaces root)')} (/new to pick)`
                : `Project: ${escapeHtml(conversation.project ?? 'none (workspaces root)')} (/new &lt;project&gt; starts a fresh one there)`,
            fresh ? `Last chat: ${escapeHtml(topicName(conversation))}` : null,
            `Running here: ${escapeHtml(here)}`,
            running.length
                ? `Running in all: ${running.length} — ${running
                      .map((t) => escapeHtml(t.schedule ? `⏱ ${t.schedule}` : titleFrom(t.prompt)))
                      .join(', ')}`
                : null,
            fresh && defaults.provider
                ? `Model: ${escapeHtml(modelRef(defaults.provider, defaults.model) ?? defaults.provider)} for new chats (/model claude comes back; factory: ${tasks.model()})`
                : !fresh && conversation.provider
                  ? `Model: ${escapeHtml(modelRef(conversation.provider, conversation.model) ?? conversation.provider)} for this chat (/model claude comes back; factory: ${tasks.model()})`
                  : `Model: ${tasks.model()} (/model to switch)`,
            `Limits: ${windows ?? 'unknown (see /usage)'}`,
            sandboxLine()
        ].filter((line): line is string => Boolean(line))
        return [
            text(lines.join('\n')),
            row(
                current ? { text: '⏹ Stop', data: `s|stop|${current.id}`, style: 'danger' } : null,
                { text: '🔄 Refresh', data: 's|refresh' },
                ...MENU.filter((b) => b.data !== 'v|status')
            )
        ]
    }
    bot.command('status', async (ctx) => {
        await send(ctx.chat.id, statusView(ctx.chat.id))
    })

    // `/usage` shows the last reading; Refresh (or `/usage refresh`) spends one Haiku turn to get a fresh one.
    const usageView = (snapshot: RateLimitSnapshot | undefined | null, probing = false): View => [
        text(probing ? 'Asking the CLI…' : limitsReport(snapshot ?? undefined).join('\n')),
        row(probing ? null : { text: '🔄 Refresh (one Haiku turn)', data: 'u|refresh' })
    ]
    const refreshUsage = (chatId: number, messageId: number) =>
        detached('usage refresh', async () => {
            const snapshot = await tasks.probeLimits()
            await editView(
                bot,
                chatId,
                messageId,
                snapshot
                    ? usageView(snapshot)
                    : [
                          text('❌ The CLI reported no rate-limit status; see the supervisor log.'),
                          row({ text: '🔄 Refresh (one Haiku turn)', data: 'u|refresh' })
                      ]
            )
        })
    bot.command('usage', async (ctx) => {
        if (/^refresh\b/i.test(ctx.match)) {
            refreshUsage(ctx.chat.id, await send(ctx.chat.id, usageView(null, true)))
            return
        }
        await send(ctx.chat.id, usageView(tasks.limits()))
    })

    // A message that *starts* with an unknown command is a typo, not a task
    // for the agent. A slash word further in ("fix the /login page") is text.
    bot.on('message:entities:bot_command', async (ctx, next) => {
        const leading = ctx.message.entities?.some((e) => e.type === 'bot_command' && e.offset === 0)
        if (!leading) return next()
        await ctx.reply(`Unknown command ${ctx.message.text.split(/\s/)[0]}. See /help.`)
    })

    // ---- a message = a task ------------------------------------------------------------------

    // A reply to a message (the bot's or the owner's own) goes to that message's conversation
    // (a routine's thread, an older chat) and makes it the chat's topic. Otherwise the mode
    // decides (`routeMessage`): `fresh` starts a new chat, `thread` stays in the topic. While
    // the agent waits for an answer, the message is the answer (see TaskService.submit).
    // The message gets a reaction (seen, then every state the task goes through) and a draft
    // under it shows the task at work; a message of the bot is sent only when there is more
    // to say than "working": a switched thread, an answer passed on, files taken along.
    /** Where a message goes (see routeMessage), and the task it becomes there. */
    const route = (ctx: Context, chatId: number, prompt: string, attachments: Attachment[]) => {
        const replyTo = ctx.message?.reply_to_message
        const topic = topicFor(chatId)
        const replied = repliedConversation(chatId, replyTo)
        const where = routeMessage({
            mode: mode(),
            replied: Boolean(replied),
            topicAsks: Boolean(tasks.pendingAsk(topic.id)),
            topicEmpty: isEmpty(topic)
        })
        let conversation = topic
        if (replied) {
            if (replied.id !== topic.id) store.setTelegramTopic(chatId, replied.id)
            conversation = replied
        } else if (where === 'fresh') {
            conversation = freshConversation(chatId)
            // A reply whose chat is gone (deleted, or older than the bot remembers) brings the message it answers.
            const quoted = replyTo ? quoteReply(replyTo.text ?? replyTo.caption) : null
            if (quoted) prompt = `${quoted}\n\n${prompt}`
        }
        const switched = replied && replied.id !== topic.id ? replied : null
        const first = isEmpty(conversation)
        const answering = Boolean(tasks.pendingAsk(conversation.id))
        const task = tasks.submit(conversation.id, 'telegram', prompt, { attachments })
        return { task, conversation, switched, first, answering }
    }

    const submit = async (ctx: Context, prompt: string, attachments: Attachment[] = []) => {
        const chatId = ctx.chat!.id
        // Files sent a moment ago without a caption go with this message; they wait for the next one if it fails.
        const held = takePending(chatId)
        attachments = [...held, ...attachments]
        let routed: ReturnType<typeof route>
        try {
            routed = route(ctx, chatId, prompt, attachments)
        } catch (error) {
            if (held.length) holdFiles(chatId, held)
            throw error
        }
        const { task, conversation, switched, first, answering } = routed
        // The owner's own message: a reply to it later continues this chat, and its reactions tell the task's state.
        if (ctx.message) {
            remember(chatId, ctx.message.message_id, conversation.id, task.id)
            if (!origins.has(task.id))
                origins.set(task.id, { chatId, messageId: ctx.message.message_id, reaction: null })
            react(task.id, reactionFor(task))
        }
        if (!answering && !draft.has(task.id))
            draft.start(
                task.id,
                chatId,
                draftState(task, {
                    head:
                        first && mode() === 'fresh'
                            ? `▶️ New chat${conversation.project ? ` in ${conversation.project}` : ''} ·`
                            : '▶️',
                    startedAt: Date.now(),
                    waiting: waitingFor(task)
                })
            )
        const notes = [
            switched ? `↪️ ${topicName(switched)}` : null,
            answering ? '↩️ Passed on as the answer, continuing…' : null,
            attachments.length ? `📎 ${attachments.length} file${attachments.length === 1 ? '' : 's'} with it` : null
        ].filter(Boolean)
        if (notes.length) {
            const sent = await bot.api.sendMessage(chatId, notes.join(' · '))
            remember(chatId, sent.message_id, conversation.id, task.id)
        }
    }

    // ---- buttons -----------------------------------------------------------------------------

    // The data names the task and the option, never the answer text: the ask
    // on the task is the truth, so a stale button (already answered, task
    // over) is refused.
    bot.on('callback_query:data', async (ctx) => {
        const data = ctx.callbackQuery.data
        const [kind, a, b, c] = data.split('|')
        const chatId = ctx.chat!.id
        try {
            switch (kind) {
                case 'a':
                case 'p': {
                    // The button names the request it was sent for: a late tap never answers a newer one.
                    const tap = askTap(data, tasks.task(a), answeredAsks.get(data.split('|').at(-1)!))
                    tasks.answer(tap.taskId, tap.answer)
                    await ctx.answerCallbackQuery({ text: toast(tap.said) })
                    return
                }
                case 'c': {
                    // Continue a failed task's chat: "continue" as the next message of its conversation.
                    const task = tasks.task(a)
                    const conversation = task && tasks.conversationOf(task)
                    if (!task || !conversation) throw new Error('that chat is gone')
                    if (tasks.activeTask(conversation.id) || tasks.queuedTask(conversation.id))
                        throw new StaleTap('This chat is already at work.')
                    const next = tasks.submit(conversation.id, 'telegram', 'continue')
                    switchTo(chatId, conversation)
                    const message = ctx.callbackQuery.message
                    if (message) remember(chatId, message.message_id, conversation.id, next.id)
                    await ctx.answerCallbackQuery({ text: '▶️ Continuing…' })
                    return
                }
                case 'r':
                    return await routineButton(ctx)
                case 'n': {
                    const project = a === '-' ? null : a
                    if (project && !tasks.hasProject(project)) throw new Error(`project "${project}" is gone`)
                    await ctx.answerCallbackQuery({ text: toast(project ? `New chats in ${project}` : 'No project') })
                    const { said, conversation } = startNew(chatId, project)
                    const message = ctx.callbackQuery.message
                    if (message) remember(chatId, message.message_id, conversation.id)
                    redraw(ctx, [text(escapeHtml(said)), ...projectPicker(chatId).slice(1)])
                    return
                }
                case 'm': {
                    const said = applyModel(chatId, a)
                    await ctx.answerCallbackQuery({ text: toast(said) })
                    redraw(ctx, modelView(chatId))
                    return
                }
                case 'md': {
                    if (a === 'fresh' || a === 'thread') store.setMeta(MODE_META, a)
                    await ctx.answerCallbackQuery({ text: `Mode: ${mode()}` })
                    redraw(ctx, modeView())
                    return
                }
                case 's': {
                    if (a === 'stop') {
                        const task = tasks.task(b)
                        if (!task || (task.status !== 'running' && task.status !== 'queued'))
                            throw new Error('that task is not running')
                        tasks.stop(task.id)
                        await ctx.answerCallbackQuery({ text: task.status === 'queued' ? '⏹ Cancelled' : 'Stopping…' })
                    } else await ctx.answerCallbackQuery()
                    // Under the routines list or a routine's card the Stop button keeps that view; elsewhere it is the status.
                    const schedule = a === 'stop' ? tasks.task(b)?.schedule : undefined
                    const view =
                        c === 'l' ? listView() : c === 'c' && schedule ? cardView(schedule) : statusView(chatId)
                    redraw(ctx, view ?? listView())
                    return
                }
                case 'w': {
                    if (!sandbox) throw new Error('sandboxes are off')
                    const { sandboxes } = sandbox
                    const allow = a === 'a'
                    // sbx may take seconds: the tap is answered first, the message tells what came of it.
                    await ctx.answerCallbackQuery({ text: allow ? 'Allowing…' : 'Denying…' })
                    detached('approval', async () => {
                        try {
                            const approval = await sandboxes.decide(data.slice(4), allow)
                            await edit(ctx, [
                                text(
                                    `${allow ? '✅' : '🚫'} <code>${escapeHtml(approval.resource)}</code> ${allow ? (approval.project ? `allowed for ${escapeHtml(approval.project)} (its project file's network: list)` : 'allowed') : 'stays blocked'}.`
                                )
                            ])
                        } catch (error) {
                            // A blip of sbx must not take the question away: the buttons stay for another try.
                            await edit(ctx, [
                                text(`❌ ${escapeHtml(errorText(error))}`),
                                row(
                                    { text: '✅ Allow', data: `w|a|${data.slice(4)}`, style: 'success' },
                                    { text: '🚫 Deny', data: `w|d|${data.slice(4)}` }
                                )
                            ])
                        }
                    })
                    return
                }
                case 'pv': {
                    if (!sandbox) throw new Error('previews are off')
                    const { previews } = sandbox
                    const project = data.slice('pv|stop|'.length)
                    await ctx.answerCallbackQuery({ text: 'Stopping the preview…' })
                    detached('preview stop', async () => {
                        let closed: boolean
                        try {
                            closed = await previews.close(project, 'stopped by the owner')
                        } catch (error) {
                            await edit(ctx, [text(`❌ ${escapeHtml(errorText(error))}`), row({ text: '⏹ Stop', data })])
                            return
                        }
                        await edit(ctx, [
                            text(
                                closed
                                    ? `⏹ The preview of <b>${escapeHtml(project)}</b> is stopped.`
                                    : `No preview of <b>${escapeHtml(project)}</b> was open.`
                            )
                        ])
                    })
                    return
                }
                case 'u': {
                    await ctx.answerCallbackQuery({ text: 'Asking the CLI…' })
                    const message = ctx.callbackQuery.message
                    if (!message) return
                    detached('usage refresh', async () => {
                        await edit(ctx, usageView(null, true)).catch(() => undefined)
                        refreshUsage(message.chat.id, message.message_id)
                    })
                    return
                }
                case 'v': {
                    await ctx.answerCallbackQuery()
                    const view =
                        a === 'routines'
                            ? listView()
                            : a === 'status'
                              ? statusView(chatId)
                              : a === 'model'
                                ? modelView(chatId)
                                : a === 'usage'
                                  ? usageView(tasks.limits())
                                  : helpView()
                    detached('menu view', async () => void (await send(chatId, view)))
                    return
                }
                default:
                    await ctx.answerCallbackQuery()
            }
        } catch (error) {
            await ctx
                .answerCallbackQuery(
                    error instanceof StaleTap
                        ? { text: toast(error.message) }
                        : { text: toast(`❌ ${errorText(error)}`), show_alert: true }
                )
                .catch(() => undefined)
        }
    })
    // The Stop button under a task's draft.
    bot.on('stopped_message_generation', (ctx) => {
        const stopped = ctx.update.stopped_message_generation
        draft.stopped(stopped.chat.id, stopped.draft_id)
    })

    /** A message as a task; what goes wrong is said in the chat (a throw here would reach only the log). */
    const submitOrSay = async (ctx: Context, prompt: string) => {
        try {
            await submit(ctx, prompt)
        } catch (error) {
            log.error(`message to a task failed: ${errorText(error)}`)
            await ctx.reply(`❌ ${errorText(error)}`).catch(() => undefined)
        }
    }
    bot.on('message:text', async (ctx) => {
        const prompt = ctx.message.text
        // A file or a voice note still on its way goes first: its text, or the files it holds back, belong
        // to what came before this message.
        if (receiving.has(ctx.chat.id)) return receiveIn(ctx.chat.id, 'message', () => submitOrSay(ctx, prompt))
        await submitOrSay(ctx, prompt)
    })

    // ---- files and voice -----------------------------------------------------------------------

    /** A file the owner sent, fetched from Telegram's file server. */
    const download = async (ctx: Context, fileId: string): Promise<{ data: Buffer; filePath: string }> => {
        const file = await ctx.api.getFile(fileId)
        if (!file.file_path) throw new Error('Telegram returned no file path')
        const response = await fetch(`https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`, {
            signal: AbortSignal.timeout(60_000)
        })
        if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
        return { data: Buffer.from(await response.arrayBuffer()), filePath: file.file_path }
    }

    // Photos and files. With a caption they are a task (or an answer) at
    // once; without one they wait for the next text or voice message of the
    // chat, for PENDING_MS. An album arrives as one update per file sharing a
    // media_group_id: they are gathered for a moment and handled as one.
    const PENDING_MS = 30 * 60_000
    const ALBUM_MS = 1500
    const pending = new Map<number, { files: Attachment[]; at: number }>()
    const takePending = (chatId: number): Attachment[] => {
        const held = pending.get(chatId)
        pending.delete(chatId)
        // A file whose conversation was deleted in the web meanwhile is gone from the disk.
        return held && Date.now() - held.at < PENDING_MS ? held.files.filter((f) => fs.existsSync(f.path)) : []
    }
    /** Files held back for the chat's next message, after the ones held already. */
    const holdFiles = (chatId: number, files: Attachment[]): Attachment[] => {
        const held = pending.get(chatId)
        const all = [...(held && Date.now() - held.at < PENDING_MS ? held.files : []), ...files].slice(-MAX_ATTACHMENTS)
        pending.set(chatId, { files: all, at: Date.now() })
        return all
    }
    /**
     * Files and voice notes take a while (a download, a transcription); a text sent meanwhile must not
     * overtake them, or the files would go with the next, unrelated message. Per chat, what comes in
     * is handled in order: each piece of work starts once the one before it has ended.
     */
    const receiving = new Map<number, Promise<void>>()
    const receiveIn = (chatId: number, label: string, work: () => Promise<void>) => {
        const done = (receiving.get(chatId) ?? Promise.resolve())
            .then(work)
            .catch((error) => log.error(`${label} failed`, error))
        receiving.set(chatId, done)
        void done.finally(() => {
            if (receiving.get(chatId) === done) receiving.delete(chatId)
        })
    }
    type Incoming = {
        ctx: Context
        fileId: string
        name: string
        type: string | null
        size: number | undefined
        caption: string
    }
    const albums = new Map<string, Incoming[]>()
    const receive = async (items: Incoming[]) => {
        const { ctx } = items[0]
        const chatId = ctx.chat!.id
        try {
            const tooBig = items.find((i) => (i.size ?? 0) > MAX_ATTACHMENT_BYTES)
            if (tooBig)
                throw new Error(
                    `"${tooBig.name}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, the most a bot may download`
                )
            // Saved where the next message will go; a reply that switches the topic still finds them by path.
            const conversation = topicFor(chatId)
            const saved: Attachment[] = []
            for (const item of items.slice(0, MAX_ATTACHMENTS)) {
                const { data, filePath } = await download(item.ctx, item.fileId)
                const name = item.name || filePath.split('/').pop() || 'file'
                saved.push(tasks.inbox.save(conversation.id, name, data, item.type))
            }
            const caption = items.map((i) => i.caption).find(Boolean) ?? ''
            if (caption) {
                await submit(ctx, caption, saved)
                return
            }
            const files = holdFiles(chatId, saved)
            const what =
                files.length === 1 ? (files[0].type.startsWith('image/') ? 'Photo' : 'File') : `${files.length} files`
            await ctx.reply(
                `📎 ${what} saved. Now send the task as text or voice (within 30 minutes), and ${files.length === 1 ? 'it goes' : 'they go'} with it.`
            )
        } catch (error) {
            const message = errorText(error)
            log.error(`attachment handling failed: ${message}`)
            await ctx.reply(`❌ Could not take the file: ${message}`)
        }
    }
    bot.on(['message:photo', 'message:document', 'message:video'], (ctx) => {
        const m = ctx.message
        const photo = m.photo?.at(-1) // the largest size
        const media = photo ?? m.document ?? m.video
        if (!media) return
        const item: Incoming = {
            ctx,
            fileId: media.file_id,
            name: photo ? 'photo.jpg' : (m.document?.file_name ?? m.video?.file_name ?? ''),
            type: photo ? 'image/jpeg' : (m.document?.mime_type ?? m.video?.mime_type ?? null),
            size: media.file_size,
            caption: m.caption?.trim() ?? ''
        }
        const group = m.media_group_id
        if (!group) return receiveIn(ctx.chat.id, 'attachment', () => receive([item]))
        const key = `${ctx.chat.id}:${group}`
        const list = albums.get(key)
        if (list) return void list.push(item)
        albums.set(key, [item])
        // Held in the chat's line from the first file on, so a text right after the album waits for all of it.
        receiveIn(ctx.chat.id, 'album', async () => {
            await new Promise((resolve) => setTimeout(resolve, ALBUM_MS))
            const items = albums.get(key) ?? []
            albums.delete(key)
            await receive(items)
        })
    })

    // Voice notes and audio files: download from Telegram, transcribe, then
    // treat the text exactly like a typed message. The transcript is echoed
    // back so the owner can see what the agent is going to act on.
    bot.on(['message:voice', 'message:audio'], async (ctx) => {
        if (!config.stt.groqApiKey) {
            await ctx.reply('Voice messages are disabled: set GROQ_API_KEY in .env to enable transcription.')
            return
        }
        const media = ctx.message.voice ?? ctx.message.audio
        const apiKey = config.stt.groqApiKey
        await ctx.replyWithChatAction('typing').catch(() => undefined)
        receiveIn(ctx.chat.id, 'voice message', async () => {
            try {
                const { data: audio, filePath } = await download(ctx, media.file_id)
                const text = await transcribe(audio, filePath, {
                    apiKey,
                    model: config.stt.model,
                    language: config.stt.language,
                    mimeType: media.mime_type
                })
                if (!text) {
                    await ctx.reply('Could not make out any words in that recording.')
                    return
                }
                // A long recording outgrows one message (4096 characters): echo the start, the agent gets it all.
                const echo = text.length > 3500 ? `${text.slice(0, 3500)}… (${text.length} characters in all)` : text
                await ctx
                    .reply(`🎤 ${echo}`, { reply_parameters: { message_id: ctx.message.message_id } })
                    .catch((error: unknown) => log.warn(`voice echo failed: ${errorText(error)}`))
                await submit(ctx, text)
            } catch (error) {
                const message = errorText(error)
                log.error(`voice handling failed: ${message}`)
                await ctx.reply(`❌ Voice message failed: ${message}`)
            }
        })
    })

    // ---- the task's life: reactions, the draft, questions ----------------------------------

    tasks.on('task', (task) => {
        if (origins.has(task.id)) react(task.id, reactionFor(task))
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
            void draft.end(task.id)
            return
        }
        const chatId = chatFor(task)
        if (!chatId) return
        // A question is a message of its own: the draft would vanish under it and come back on
        // the next refresh. It ends while the agent waits and starts again with the answer.
        if (task.ask) {
            void draft.end(task.id)
            return
        }
        if (task.status === 'running' && !draft.has(task.id)) {
            draft.start(task.id, chatId, draftState(task, { waiting: waitingFor(task) }))
            return
        }
        // Back in the queue until the window resets, maybe for hours: the limit notice says when, and the
        // draft starts again when the task runs.
        if (task.status === 'queued' && task.not_before) {
            void draft.end(task.id)
            return
        }
        draft.update(task.id, () => ({ waiting: waitingFor(task) }))
    })
    tasks.on('event', (event: TaskEvent) => draft.event(event))

    // Questions and permission requests go to the conversation's chat with
    // buttons; once the request is settled, from whichever channel, the
    // buttons give way to a line that names the answer. Keyed by request and
    // question, so a poll of the same task never sends a question twice.
    const sentAsks = new Map<
        string,
        {
            taskId: string
            tag: string
            chatId: number
            messageId: number
            question: string | null
            view: View
            settled?: string
        }
    >()
    // What each request of a running task was settled with, by its buttons' tag: a late tap on a button
    // still in the chat is told the answer it already has.
    const answeredAsks = new Map<string, string>()
    const answeredBy = new Map<string, string[]>()
    const settle = async (key: string, note: string) => {
        const sent = sentAsks.get(key)
        if (!sent) return
        const tags = answeredBy.get(sent.taskId) ?? []
        answeredBy.set(sent.taskId, [...tags, sent.tag])
        answeredAsks.set(sent.tag, note)
        // The message is still on its way (a retry, a slow network): settled once it has an id.
        if (!sent.messageId) {
            sent.settled = note
            return
        }
        sentAsks.delete(key)
        try {
            // The question stays, its buttons give way to the answer.
            await editView(bot, sent.chatId, sent.messageId, [
                ...sent.view.filter((block) => block.kind === 'text'),
                row({ text: Array.from(note).slice(0, 60).join(''), disabled: true })
            ])
        } catch (error) {
            log.warn(`could not settle ask message ${sent.messageId}: ${errorText(error)}`)
            // A message Telegram will not edit keeps its buttons: say under it that the request is settled.
            if (sent.view.some((block) => block.kind === 'buttons'))
                await bot.api
                    .sendMessage(sent.chatId, note, { reply_parameters: replyParameters(sent.messageId) })
                    .catch(() => undefined)
        }
    }
    tasks.on('task', (task) => {
        if (task.status !== 'running') {
            for (const [key, sent] of sentAsks)
                if (sent.taskId === task.id) void settle(key, '— the task ended before an answer')
            for (const tag of answeredBy.get(task.id) ?? []) answeredAsks.delete(tag)
            answeredBy.delete(task.id)
            return
        }
        const chatId = chatFor(task)
        if (!chatId) return
        if (!task.ask) {
            // Answered from the web (the `answer` event settled it already) or withdrawn by the CLI.
            for (const [key, sent] of sentAsks) if (sent.taskId === task.id) void settle(key, '— withdrawn')
            return
        }
        // A handed chat's question names the chat: the owner may have several going.
        const conversation = task.source === 'handoff' ? tasks.conversationOf(task) : undefined
        sendAsk(
            task,
            chatId,
            conversation
                ? [
                      text(
                          `💬 <b>${escapeHtml(topicName(conversation))}</b>${task.project ? ` · ${escapeHtml(task.project)}` : ''}`
                      )
                  ]
                : []
        )
    })
    const sendAsk = (task: Task, chatId: number, head: View = []) => {
        if (!task.ask) return
        const message = askMessage(task, task.ask)
        if (!message || sentAsks.has(message.key)) return
        const question = task.ask.kind === 'question' ? (openQuestions(task.ask)[0]?.question ?? null) : null
        const view = [...head, ...message.view]
        sentAsks.set(message.key, {
            taskId: task.id,
            tag: askTag(task.ask.request_id),
            chatId,
            messageId: 0,
            question,
            view
        })
        // After the draft's last request, so the question is the newest thing in the chat.
        void draft
            .end(task.id)
            .then(() => sendView(bot, chatId, view, { forceReply: message.forceReply }))
            .then((id) => {
                const entry = sentAsks.get(message.key)
                if (entry) {
                    entry.messageId = id
                    if (entry.settled) void settle(message.key, entry.settled)
                }
                remember(chatId, id, task.conversation_id, task.id)
            })
            .catch((error) => {
                sentAsks.delete(message.key)
                log.error(`ask to chat ${chatId} failed`, error)
            })
    }
    const askFromWeb = (task: Task) => {
        try {
            const conversation = tasks.conversationOf(task)
            const chatId = conversation && webChatFor(conversation)
            if (!conversation || !chatId) return
            switchTo(chatId, conversation)
            sendAsk(task, chatId, [
                text(
                    `💻 <b>${escapeHtml(topicName(conversation))}</b> — from the web. This chat now continues that thread.`
                )
            ])
        } catch (error) {
            log.error(`web question of task ${task.id} to Telegram failed`, error)
        }
    }
    tasks.on('event', (event: TaskEvent) => {
        if (event.type !== 'answer') return
        const p = event.payload as { request_id?: string; behavior?: string; answers?: Record<string, string> }
        for (const [key, sent] of sentAsks) {
            if (sent.taskId !== event.task_id) continue
            const answer = sent.question ? p.answers?.[sent.question] : p.behavior === 'allow' ? 'Allowed' : 'Denied'
            void settle(key, `✓ ${answer ?? 'answered'}`)
        }
    })

    // A task the subscription limit stopped waits for the window to reset:
    // say when it continues, once per wait (keyed by the wait's number).
    const toldWaits = new Map<string, number>()
    tasks.on('task', (task) => {
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
            toldWaits.delete(task.id)
            return
        }
        if (task.status !== 'queued' || !task.not_before || toldWaits.get(task.id) === task.limit_waits) return
        toldWaits.set(task.id, task.limit_waits)
        if (task.source !== 'telegram' && task.source !== 'routine' && task.source !== 'cron') return
        const chatId = chatFor(task)
        if (!chatId) return
        const clock = clockAt(task.not_before, config.timezone)
        const head = task.schedule ? `⏱ <b>${escapeHtml(task.schedule)}</b>: ` : ''
        void send(
            chatId,
            [
                text(
                    `${head}⏸ Subscription limit reached. The task continues by itself at ${clock} (in ${resetsIn(task.not_before)}), in the same session.`
                ),
                row({ text: '⏹ Cancel it', data: `s|stop|${task.id}`, style: 'danger' })
            ],
            { taskId: task.id }
        ).catch((error) => log.error(`limit notice to chat ${chatId} failed`, error))
    })

    // ---- replies -------------------------------------------------------------------------------

    /** A task whose end is told in Telegram (the reply, or "⏹ Stopped."): one of a chat, or a routine run's. */
    const delivered = (task: Task) =>
        (task.source === 'telegram' || task.source === 'routine' || task.source === 'cron') && chatFor(task) !== null

    /** Buttons inside a reply: the task page, its pull request, and for a routine's report the routine itself. */
    const replyButtons = (task: Task): Button[][] => {
        const first: Button[] = []
        // A chat's task that failed with its session kept (the turn limit, a timeout) goes on from where it stopped.
        if (task.status === 'failed' && task.session_id && !task.schedule)
            first.push({ text: '▶️ Continue', data: `c|${task.id}`, style: 'primary' })
        if (buttonUrl) first.push({ text: '🌐 Open', url: `${buttonUrl}/tasks/${task.id}` })
        if (task.git?.pr) first.push({ text: `PR #${task.git.pr.number}`, url: task.git.pr.url, style: 'success' })
        const second: Button[] = []
        if (task.schedule && routines?.get(task.schedule))
            second.push(
                { text: '▶️ Run again', data: routineData('fire', task.schedule), style: 'success' },
                { text: '📋 Routine', data: routineData('open', task.schedule) }
            )
        return [first, second].filter((r) => r.length)
    }
    const deliver = async (chatId: number, task: Task, head: string, replyTo?: number) => {
        // The draft's last request lands before the reply, or it would show under the reply for half a minute.
        await draft.end(task.id)
        const body =
            task.status === 'done'
                ? (task.result ?? '')
                : task.status === 'cancelled'
                  ? '⏹ Stopped.'
                  : `❌ ${task.error || 'failed'}`
        return sendReply(bot, chatId, `${head}${body}`, {
            footer: footer(task, tasks.limits(), publicUrl, tasks.delegationsOf(task.id)),
            replyTo,
            buttons: replyButtons(task),
            // A pull request is an occasion.
            effect: task.status === 'done' && task.git?.pr ? EFFECT.party : undefined
        })
    }

    // Deliver results of Telegram-originated tasks back to their chat, and of
    // routine runs to the owner (unless the routine says notify: none).
    tasks.on('task', (task) => {
        if (task.status === 'queued' || task.status === 'running') return
        // Whatever its source (a message may answer a web task's question), the task's origin is done with.
        const origin = origins.get(task.id)
        origins.delete(task.id)
        if (!delivered(task)) return
        const chatId = chatFor(task)
        if (!chatId) return
        const head = task.schedule ? `⏱ **${task.schedule}**\n\n` : ''
        // Delivered = seen: the web's "unread" mark goes; a failed delivery keeps it, so the reply is not lost.
        void deliver(chatId, task, head, origin?.chatId === chatId ? origin.messageId : undefined)
            .then((ids) => {
                remember(chatId, ids, task.conversation_id, task.id)
                tasks.markRead(task.conversation_id)
            })
            .catch((error) => {
                // What did arrive is remembered: a reply to it continues the chat. The unread mark stays.
                if (error instanceof DeliveryError) remember(chatId, error.ids, task.conversation_id, task.id)
                log.error(`delivery to chat ${chatId} failed`, error)
            })
    })

    // A web task's reply nobody opened in the web goes here after a while (WebNotifier),
    // and the chat switches to its thread, so the next message continues it.
    const deliverWeb = async (task: Task) => {
        let chatId: number | null = null
        try {
            // Called from a timer: a throw here (the store) would be an uncaught exception.
            const conversation = tasks.conversationOf(task)
            chatId = conversation ? webChatFor(conversation) : null
            if (!conversation || !chatId) return
            switchTo(chatId, conversation)
            const ids = await deliver(chatId, task, `${fromWeb(conversation)}\n\n`)
            remember(chatId, ids, task.conversation_id, task.id)
            tasks.markRead(task.conversation_id)
        } catch (error) {
            if (chatId && error instanceof DeliveryError) remember(chatId, error.ids, task.conversation_id, task.id)
            log.error(`web reply to chat ${chatId ?? '?'} failed`, error)
        }
    }
    tasks.on('task', (task) => notifier.onTask(task))

    // A step that breaks (credentials expired, a host down) would
    // otherwise fail silently every hour: say so once per distinct error. A
    // minute the factory slept through, a firing skipped because the previous
    // run still waits, and a firing skipped for the soft-stop are told too,
    // with the routine's buttons under the notice.
    const lastNotice = new Map<string, string>()
    routines?.on('run', (run, spec) => {
        if (!ownerChat) return
        const text = routineNotice(run, spec, lastNotice, config.timezone)
        if (!text) return
        const conversation = store.findConversation('web', `schedule:${run.schedule}`)
        sendMarkdown(bot, ownerChat, text, {
            buttons: [
                [
                    { text: '▶️ Run now', data: routineData('fire', run.schedule), style: 'success' },
                    { text: '📋 Routine', data: routineData('open', run.schedule) }
                ]
            ]
        })
            .then((ids) => {
                if (conversation) remember(ownerChat, ids, conversation.id, run.task_id)
            })
            .catch((error) => log.error('routine notice failed', error))
    })

    // The scripts after a run's agent: what they did, under the agent's report.
    routines?.on('after', (run, spec, steps, outputs) => {
        if (!ownerChat) return
        const text = afterNotice(run, spec, steps, outputs)
        if (!text) return
        sendMarkdown(bot, ownerChat, text).catch((error) => log.error('routine notice failed', error))
    })

    // The web UI's door: the owner hears about every sign-in, the first wrong
    // password of a streak (the ones after it would only repeat the message)
    // and a lock, so an attempt to guess the password is never silent.
    auth?.on('notice', (notice) => {
        if (!ownerChat) return
        send(ownerChat, [text(signInNotice(notice, auth.policy, config.timezone))]).catch((error) =>
            log.error('sign-in notice failed', error)
        )
    })

    // A sandbox's network policy held a request back: the owner allows the host for the project (it goes
    // into the project file's `network:`) or leaves it blocked. Callback data carries sbx's approval id.
    const fits = (data: string) => Buffer.byteLength(data) <= 64
    sandbox?.sandboxes.on('recreated', (name, reason) => {
        if (!ownerChat) return
        send(ownerChat, [
            text(
                `♻️ Sandbox <code>${escapeHtml(name)}</code> was made again: ${escapeHtml(reason)}. What was installed inside it is gone; checkouts and data are untouched.`
            )
        ]).catch((error) => log.error('sandbox notice failed', error))
    })
    sandbox?.sandboxes.on('approval', (approval) => {
        if (!ownerChat) return
        const allow = `w|a|${approval.id}`
        const deny = `w|d|${approval.id}`
        const where = approval.project ? `project <b>${escapeHtml(approval.project)}</b>` : 'a chat without a project'
        send(ownerChat, [
            text(
                `🌐 The sandbox of ${where} was refused <code>${escapeHtml(approval.resource)}</code> by its network policy.\nAllow it, and the agent's next try gets through.`
            ),
            fits(allow)
                ? row(
                      {
                          text: approval.project ? '✅ Allow for this project' : '✅ Allow',
                          data: allow,
                          style: 'success'
                      },
                      { text: '🚫 Deny', data: deny }
                  )
                : text('Answer it in Settings → Sandboxes.')
        ]).catch((error) => log.error('approval notice failed', error))
    })

    // The agent showed its app: the address, with Open (when the factory has a public address) and Stop.
    sandbox?.previews.on('opened', (preview) => {
        if (!ownerChat) return
        const stop = `pv|stop|${preview.project}`
        send(
            ownerChat,
            [
                text(
                    `👀 Preview of <b>${escapeHtml(preview.project)}</b>: ${escapeHtml(preview.url)}${preview.expires_at ? `\nOpen until ${new Date(preview.expires_at).toLocaleString('en-GB', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' })}.` : ''}`
                ),
                row(
                    /^https?:\/\//.test(preview.url) && buttonBaseUrl(preview.url)
                        ? { text: '🔗 Open', url: preview.url }
                        : null,
                    fits(stop) ? { text: '⏹ Stop', data: stop } : null
                )
            ],
            { taskId: preview.task_id }
        ).catch((error) => log.error('preview notice failed', error))
    })
    sandbox?.previews.on('closed', (preview, reason) => {
        if (!ownerChat || reason === 'stopped by the owner') return
        sendMarkdown(bot, ownerChat, `⏹ The preview of \`${preview.project}\` is stopped: ${reason}.`).catch((error) =>
            log.error('preview notice failed', error)
        )
    })

    // A secret is as sensitive as the password: every change is told, never its value.
    vault?.on('change', (change) => {
        if (!ownerChat) return
        const what = change.secret ? 'Secret' : 'Variable'
        const icon = change.action === 'deleted' ? '🗑' : '🔑'
        const text = `${icon} ${what} \`${change.name}\` ${change.action} in the web UI${change.from ? ` from \`${change.from}\`` : ''}.`
        sendMarkdown(bot, ownerChat, text).catch((error) => log.error('vault notice failed', error))
    })

    bot.catch((err) => {
        log.error('unhandled bot error', err.error)
    })

    return bot
}
