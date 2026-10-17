import fs from 'node:fs'

import { Bot, type Context, InlineKeyboard } from 'grammy'
import type { InlineKeyboardMarkup, ReactionTypeEmoji } from 'grammy/types'

import { MODEL_ALIASES } from './claude/models.js'
import type { Config } from './config.js'
import { type Attachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from './files/inbox.js'
import { modelRef, parseModelRef } from './files/providers.js'
import { changesLine } from './git/changes.js'
import { createLogger } from './logger.js'
import type { Routines } from './routines/service.js'
import { routineOf, type RoutineSpec } from './routines/spec.js'
import type { Ask, Conversation, RateLimitSnapshot, RoutineRun, Store, Task, TaskEvent } from './store/index.js'
import { transcribe } from './stt/groq.js'
import { askQuestions, type Delegation, openQuestions, type TaskService, titleFrom } from './tasks/service.js'
import { type DraftState, LiveDraft } from './telegram/draft.js'
import {
    backToCard,
    findRoutine,
    parseRoutineData,
    previewText,
    routineCard,
    routineData,
    routinesList,
    runsText
} from './telegram/routinesMenu.js'
import { EFFECT, sendMarkdown, sendReply } from './telegram/send.js'
import { WebNotifier } from './telegram/webNotify.js'
import { VERSION } from './version.js'
import { describeUserAgent, type WebAuth } from './web/auth.js'

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
    if (run.status !== 'error' && run.status !== 'missed' && !stuck) {
        if (run.status !== 'skipped') lastNotice.delete(run.schedule)
        return null
    }
    if (lastNotice.get(run.schedule) === note) return null
    lastNotice.set(run.schedule, note)
    return run.status === 'missed'
        ? `⏭ Routine **${run.schedule}** ${run.note ?? 'missed a firing'}. /run ${run.schedule} starts it now.`
        : stuck
          ? `⏸ Routine **${run.schedule}** skipped a firing: ${run.note}. It waits for your answer or for the task to end.`
          : `⚠️ Routine **${run.schedule}** could not run: ${run.note ?? 'unknown error'}`
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
 * A question of the agent as a Telegram message: the question, its options
 * with their descriptions, and one button per option; free text is the
 * "Other" choice — the keyboard asks the client for a reply to the question,
 * which lands in the right conversation whichever chat is the topic. A
 * permission request gets a green Allow and a red Deny.
 */
export function askMessage(
    task: Task,
    ask: Ask
): { key: string; text: string; markup: InlineKeyboardMarkup & { force_reply?: boolean } } | null {
    if (ask.kind === 'permission') {
        const text = [
            `🔐 The agent asks to run ${ask.tool_name}:`,
            '',
            permissionSummary(ask.input),
            '',
            'Allow it or deny it below.'
        ].join('\n')
        const keyboard = new InlineKeyboard()
            .text('✅ Allow', `p|${task.id}|allow`)
            .success()
            .text('⛔ Deny', `p|${task.id}|deny`)
            .danger()
        return { key: ask.request_id, text, markup: { inline_keyboard: keyboard.inline_keyboard } }
    }
    const questions = askQuestions(ask)
    const next = openQuestions(ask)[0]
    if (!next) return null
    const index = questions.indexOf(next)
    const lines = [`❓ ${next.header ? `${next.header}: ` : ''}${next.question}`]
    const options = next.options ?? []
    if (options.length) {
        lines.push('')
        for (const option of options)
            lines.push(`• ${option.label}${option.description ? ` — ${option.description}` : ''}`)
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
    const keyboard = new InlineKeyboard()
    options.forEach((option, i) => keyboard.text(option.label.slice(0, 60), `a|${task.id}|${index}|${i}`).row())
    return {
        key: `${ask.request_id}:${index}`,
        text: lines.join('\n'),
        markup: { inline_keyboard: keyboard.inline_keyboard, force_reply: true }
    }
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

const noPreview = { link_preview_options: { is_disabled: true } } as const

export function createBot(config: Config, tasks: TaskService, store: Store, routines?: Routines, auth?: WebAuth): Bot {
    if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set')
    const bot = new Bot(config.telegram.botToken)
    const publicUrl = config.web.publicUrl

    // A chat talks to one conversation at a time — its topic: its own by
    // default, or the one the owner switched to by replying to a message of
    // the bot (a routine's report, a question). `/new` switches back.
    const topicFor = (chatId: number): Conversation =>
        store.telegramTopic(chatId) ?? tasks.conversationFor('telegram', String(chatId))
    /** The conversation a message is about: its topic's (topics on), else the chat's current one. */
    const conversationFor = (ctx: Context) =>
        topicConversation(ctx) ??
        (topicsOn() ? tasks.conversationFor('telegram', String(ctx.chat!.id)) : topicFor(ctx.chat!.id))
    const isTopic = (chatId: number, conversationId: string) => topicFor(chatId).id === conversationId
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
        if (!topicsOn() && !isTopic(chatId, conversation.id)) store.setTelegramTopic(chatId, conversation.id)
    }
    const mode = (): ChatMode => (store.getMeta<ChatMode>(MODE_META) === 'thread' ? 'thread' : 'fresh')
    const fromWeb = (conversation: Conversation) =>
        topicsOn()
            ? `💻 **${topicName(conversation)}** — from the web.`
            : mode() === 'fresh'
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
                log.warn(
                    `chat ${chatId}: provider ${defaults.provider} left out: ${error instanceof Error ? error.message : String(error)}`
                )
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
    const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

    // ---- topics: with topics on for the bot, a conversation is a topic of the chat -----------

    /**
     * Topics in the private chat (Bot API 9.3) are a BotFather setting of the
     * bot. With them on, the chat is a list of topics and every conversation
     * gets one — the owner's chats (named after the project, or the chat's
     * title), a routine's thread (`⏱ name`), a web chat that reached Telegram.
     * A message in a topic continues its conversation; General is for new
     * chats and commands. Off, the chat is flat and `/mode` rules.
     */
    const topicsOn = (): boolean => {
        try {
            return bot.botInfo.has_topics_enabled
        } catch {
            return false
        }
    }
    const threadOfCtx = (ctx: Context): number | undefined =>
        ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined
    /** The chat a conversation's topic lives in: the Telegram chat it belongs to, else the owner's. */
    const chatOf = (conversation: Conversation): number | null =>
        conversation.channel === 'telegram' ? Number(conversation.external_id) || null : (ownerChat ?? null)
    /**
     * What to call a conversation's topic: a routine's name, the project, or
     * the chat's title. A second live topic of the same project (the owner
     * forgot to delete the first) carries the chat's title after the project.
     */
    const topicTitle = (conversation: Conversation, chatId: number, own: string | null = null): string => {
        const routine = routineOf(conversation)
        if (routine) return `⏱ ${routine}`
        const title = conversation.title?.trim() || 'New chat'
        if (!conversation.project) return title.slice(0, 128)
        const taken = store.telegramThreadNames(chatId).filter((name) => name !== own)
        return (
            taken.includes(conversation.project) ? `${conversation.project} · ${title}` : conversation.project
        ).slice(0, 128)
    }
    const TOPIC_COLOR = { routine: 0xffd67e, project: 0x6fb9f0, chat: 0x8eee98 } as const
    /** The topic of a conversation, made on first use; undefined with topics off or when Telegram refuses. */
    const threadFor = async (conversation: Conversation, chatId: number): Promise<number | undefined> => {
        if (!topicsOn()) return undefined
        const known = store.threadOf(conversation.id, chatId)
        if (known) return known.thread_id
        const name = topicTitle(conversation, chatId)
        try {
            const topic = await bot.api.createForumTopic(chatId, name, {
                icon_color: routineOf(conversation)
                    ? TOPIC_COLOR.routine
                    : conversation.project
                      ? TOPIC_COLOR.project
                      : TOPIC_COLOR.chat
            })
            store.setTelegramThread(chatId, topic.message_thread_id, conversation.id, name)
            return topic.message_thread_id
        } catch (error) {
            log.warn(`could not make a topic for ${conversation.id}: ${errorText(error)}`)
            return undefined
        }
    }
    /** A topic the owner made in the client (or one the bot lost): a conversation for it, in the project of its name if there is one. */
    const bindTopic = (chatId: number, thread: number, name: string): Conversation => {
        const project = tasks.hasProject(name) ? name : null
        const conversation = tasks.newConversation('telegram', String(chatId), project ? null : name, project)
        store.setTelegramThread(chatId, thread, conversation.id, name)
        log.info(`topic ${thread} "${name}" bound to conversation ${conversation.id}`)
        return conversation
    }
    /** The conversation of the topic a message came in; null in General or with topics off. */
    const topicConversation = (ctx: Context): Conversation | null => {
        const thread = threadOfCtx(ctx)
        if (!thread) return null
        const chatId = ctx.chat!.id
        const known = store.telegramThread(chatId, thread)
        const found = known ? store.getConversation(known.conversation_id) : undefined
        if (found && !found.deleted_at) return found
        // A message in a topic replies to the topic's opening service message, which carries its name.
        const name = ctx.msg?.reply_to_message?.forum_topic_created?.name ?? known?.name ?? 'Chat'
        return bindTopic(chatId, thread, name)
    }
    /** Telegram's answer to a message into a topic the owner deleted. */
    const threadGone = (error: unknown) =>
        /thread not found|topic.*(deleted|closed)|TOPIC_(DELETED|CLOSED)/i.test(errorText(error))
    /**
     * The owner deleted a topic (the client tells the bot nothing): its
     * conversation goes the way of a chat deleted in the web, and what was
     * meant for it is said in General instead.
     */
    const topicDeleted = (conversation: Conversation, chatId: number) => {
        const thread = store.threadOf(conversation.id, chatId)
        if (thread) store.dropTelegramThread(chatId, thread.thread_id)
        try {
            tasks.deleteConversation(conversation.id)
        } catch {
            // a task still runs: the conversation stays, its next message goes to General
        }
    }

    // ---- the owner's message: a reaction per state, a draft while it runs -----------------

    /** The owner's message that started a task: the reactions sit on it, the reply quotes it (or its copy in the task's topic). */
    const origins = new Map<
        string,
        { chatId: number; messageId: number; replyTo: number; thread: number | undefined; reaction: Reaction | null }
    >()
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
        prose: '',
        ...extra
    })
    const waitingFor = (task: Task): string | null =>
        task.status === 'queued'
            ? task.not_before
                ? `subscription limit, continues at ${clockAt(task.not_before, config.timezone)}`
                : 'waiting for a free slot'
            : task.ask
              ? 'waiting for your answer'
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

    const help = async (ctx: Context) => {
        const fresh = mode() === 'fresh'
        const topics = topicsOn()
        await ctx.reply(
            [
                '<b>Pocket Factory is online.</b>',
                '',
                topics
                    ? 'Every chat is a topic: /new picks the project and opens one, a message there continues it, a message in General starts a new chat in its own topic. Delete a topic to drop its chat; routines report in topics of their own.'
                    : fresh
                      ? 'Send a task as text or voice. Every message starts a new chat; reply to a message (mine or yours) to continue its chat.'
                      : 'Send a task as text or voice. Replies continue the same Claude Code session.',
                'Photos and files go with the task: send them with a caption, or first and then the text.',
                'Your message gets a reaction as the task moves: 👀 seen · 👨‍💻 working · 🤔 asking you · 😴 waiting for the window · 👍 done · 💔 failed · 🫡 stopped. While it works, a draft shows the steps; its Stop button stops the task.',
                topics
                    ? 'A question of the agent takes your next message in its topic as the answer, or a tap on one of its buttons.'
                    : fresh
                      ? 'A question of the agent takes your next message as the answer, or a tap on one of its buttons.'
                      : 'Reply to a message of mine (a report, a question) to continue in its conversation; /new comes back to a fresh one.',
                topics
                    ? 'A web task you left (reply unopened, question unanswered for a couple of minutes) comes here, in a topic of its own.'
                    : fresh
                      ? 'A web task you left (reply unopened, question unanswered for a couple of minutes) comes here; reply to it to continue.'
                      : 'A web task you left (reply unopened, question unanswered for a couple of minutes) comes here, and this chat switches to its thread.',
                '',
                '/routines — the routines on buttons: run, switch on / off, preview, last runs',
                '/run &lt;name&gt; — fire a routine now',
                '/status — what is going on, with a Stop button',
                '/usage — subscription limits (5-hour and weekly windows)',
                "/model — the orchestrator's model on buttons; /model &lt;provider&gt;:&lt;model&gt; puts this chat on another provider",
                topics
                    ? '/new — a new chat: pick the project, a topic opens for it'
                    : fresh
                      ? '/new [project] — new chats run inside that checkout from now on; /new alone: no project'
                      : '/new [project] — start a fresh session; with a project name, inside its checkout',
                topics
                    ? null
                    : `/mode — ${fresh ? 'a new chat per message now; thread keeps one session until /new' : 'one session until /new now; fresh starts a new chat per message'}`,
                '/stop — cancel the running task (as a reply: the task of that chat)'
            ]
                .filter(Boolean)
                .join('\n'),
            { parse_mode: 'HTML', ...noPreview }
        )
    }
    bot.command(['start', 'help'], help)

    // ---- routines: a list, a card per routine, buttons that act -------------------------

    const routinesView = (): RoutineViewMessage => {
        const { text, keyboard } = routinesList(routines?.list() ?? [])
        return { text, reply_markup: keyboard }
    }
    type RoutineViewMessage = { text: string; reply_markup: InlineKeyboard }
    const cardView = (name: string, note?: string): RoutineViewMessage | null => {
        const view = routines?.get(name)
        if (!view) return null
        const { text, keyboard } = routineCard(view, config.timezone, { note, webUrl: publicUrl })
        return { text, reply_markup: keyboard }
    }
    /** Fire a routine by hand; the card's note and the toast say what came of it. */
    const fireRoutine = async (chatId: number, name: string): Promise<{ note: string; run: RoutineRun }> => {
        const run = await routines!.fire(name, 'manual')
        const note =
            run.status === 'queued'
                ? `▶️ Queued${run.note ? ` (${run.note})` : ''}. The report comes here when it is done; reply to it to follow up.`
                : `${run.status}${run.note ? ` — ${run.note}` : ''}`
        return { note, run }
    }
    const sendView = async (chatId: number, view: RoutineViewMessage, taskId?: string | null) => {
        const sent = await bot.api.sendMessage(chatId, view.text, {
            parse_mode: 'HTML',
            reply_markup: view.reply_markup,
            ...noPreview
        })
        const task = taskId ? tasks.task(taskId) : undefined
        if (task) remember(chatId, sent.message_id, task.conversation_id, task.id)
        return sent
    }

    bot.command(['routines', 'run'], async (ctx) => {
        if (!routines) return void (await ctx.reply('Routines are not available.'))
        const name = ctx.match.trim()
        if (!name) return void (await sendView(ctx.chat.id, routinesView()))
        if (!routines.get(name))
            return void (await sendView(ctx.chat.id, {
                text: `No routine named "${name}".`,
                reply_markup: new InlineKeyboard().text('📋 Routines', routineData('list'))
            }))
        const { note, run } = await fireRoutine(ctx.chat.id, name)
        await sendView(ctx.chat.id, cardView(name, note) ?? routinesView(), run.task_id)
    })

    /** A button of the routines menu: `r|<action>|<key>`. The list and the cards edit the message they sit under. */
    const routineButton = async (ctx: Context & { callbackQuery: { data: string } }) => {
        const parsed = parseRoutineData(ctx.callbackQuery.data)
        if (!parsed || !routines) throw new Error('routines are not available')
        const chatId = ctx.chat!.id
        const view = parsed.key === null ? undefined : findRoutine(routines.list(), parsed.key)
        if (parsed.action !== 'list' && !view) throw new Error('this routine is gone')
        const edit = async (message: RoutineViewMessage, taskId?: string | null) => {
            try {
                await ctx.editMessageText(message.text, {
                    parse_mode: 'HTML',
                    reply_markup: message.reply_markup,
                    ...noPreview
                })
            } catch (error) {
                if (!/not modified/.test(errorText(error))) throw error
            }
            const task = taskId ? tasks.task(taskId) : undefined
            const id = ctx.callbackQuery.message?.message_id
            if (task && id) remember(chatId, id, task.conversation_id, task.id)
        }
        const name = view?.name ?? ''
        switch (parsed.action) {
            case 'list':
                await ctx.answerCallbackQuery()
                return edit(routinesView())
            case 'card':
                await ctx.answerCallbackQuery()
                return edit(cardView(name)!)
            case 'open':
                await ctx.answerCallbackQuery()
                await sendView(chatId, cardView(name)!)
                return
            case 'run':
            case 'fire': {
                const { note, run } = await fireRoutine(chatId, name)
                await ctx.answerCallbackQuery({ text: run.status === 'queued' ? `▶️ ${name} queued` : note })
                if (parsed.action === 'run') return edit(cardView(name, note)!, run.task_id)
                await sendView(chatId, { text: `<b>${name}</b>: ${note}`, reply_markup: backToCard(name) }, run.task_id)
                return
            }
            case 'on':
            case 'off': {
                const on = parsed.action === 'on'
                routines.setEnabled(name, on)
                await ctx.answerCallbackQuery({ text: on ? `🟢 ${name} is on` : `⚪️ ${name} is off` })
                return edit(cardView(name)!)
            }
            case 'runs':
                await ctx.answerCallbackQuery()
                return edit({
                    text: runsText(view!, routines.runs(name, 8, true), config.timezone),
                    reply_markup: backToCard(name)
                })
            case 'preview': {
                await ctx.answerCallbackQuery({ text: 'Running the prefilter…' })
                // A prefilter may take a while (a host, a timeout): the bot must not stall meanwhile.
                detached('routine preview', async () => {
                    try {
                        const preview = await routines.preview(name)
                        await edit({ text: previewText(view!, preview), reply_markup: backToCard(name) })
                    } catch (error) {
                        await edit({
                            text: `👁 <b>${name}</b>: ❌ ${errorText(error).replace(/&/g, '&amp;').replace(/</g, '&lt;')}`,
                            reply_markup: backToCard(name)
                        })
                    }
                })
                return
            }
            default:
                await ctx.answerCallbackQuery()
        }
    }

    // ---- /new, /model, /mode, /stop, /status, /usage ---------------------------------------

    // `/new` forgets the session; `/new <project>` also starts the next one inside that checkout.
    // The one project command (2026-10-05): `/project <name>` did the same minus a new thread and only confused.
    /** With topics on, `/new` asks for the project: the first button is no project, then every project file. */
    const projectPicker = (): { text: string; reply_markup: InlineKeyboard } => {
        const keyboard = new InlineKeyboard().text('No project', 'n|-').row()
        const projects = tasks.projects().filter((slug) => Buffer.byteLength(`n|${slug}`) <= 64)
        projects.forEach((slug, i) => {
            keyboard.text(slug, `n|${slug}`)
            if (i % 2 === 1) keyboard.row()
        })
        return { text: 'New chat — in which project?', reply_markup: keyboard }
    }
    /** A new chat with its own topic, in the chat's provider if it has one; the topic opens with a word on where to write. */
    const newTopicChat = async (chatId: number, project: string | null): Promise<Conversation> => {
        setDefaults(chatId, { project })
        const conversation = freshConversation(chatId)
        pending.delete(chatId)
        const thread = await threadFor(conversation, chatId)
        await bot.api.sendMessage(
            chatId,
            `${project ? `New chat in ${project}, from its checkout` : 'New chat without a project'}. Send the task here; delete the topic when it is done.`,
            { message_thread_id: thread }
        )
        return conversation
    }
    bot.command('new', async (ctx) => {
        const project = ctx.match.trim() || null
        if (project && !tasks.hasProject(project)) {
            await ctx.reply(
                `Unknown project "${project}". Projects are the files in /data/config/projects; say "onboard project ${project}" to create one.`
            )
            return
        }
        if (topicsOn()) {
            if (project || !tasks.projects().length) await newTopicChat(ctx.chat.id, project)
            else {
                const view = projectPicker()
                await ctx.reply(view.text, { reply_markup: view.reply_markup })
            }
            return
        }
        // The project stays for the chat's next new chats too (`fresh` mode).
        setDefaults(ctx.chat.id, { project })
        const fresh = freshConversation(ctx.chat.id)
        pending.delete(ctx.chat.id)
        const sent = await ctx.reply(
            mode() === 'fresh'
                ? project
                    ? `New chats run in ${project} from now on, from its checkout. /new alone drops the project.`
                    : 'New chats run without a project from now on.'
                : project
                  ? `Fresh session in ${project}. Next message runs from its checkout.`
                  : 'Fresh session. Next message starts from scratch.'
        )
        remember(ctx.chat.id, sent.message_id, fresh.id)
    })

    /**
     * The model message: the factory's alias and this chat's provider, with
     * a button per alias (the current one pressed) and per provider.
     */
    const modelView = (chatId: number): { text: string; reply_markup: InlineKeyboard } => {
        const conversation = topicFor(chatId)
        const fresh = mode() === 'fresh'
        const defaults = defaultsFor(chatId)
        const chatProvider = fresh ? defaults.provider : conversation.provider
        const chatModel = fresh ? defaults.model : conversation.model
        const current = tasks.model()
        const keyboard = new InlineKeyboard()
        for (const alias of MODEL_ALIASES)
            if (alias === current) keyboard.disabled(`✓ ${alias}`)
            else keyboard.text(alias, `m|${alias}`)
        const providers = tasks.providerStatus()
        if (providers.length) {
            keyboard.row()
            if (chatProvider) keyboard.text('claude', 'm|claude').primary()
            else keyboard.disabled('✓ claude')
            for (const p of providers)
                if (p.name === chatProvider) keyboard.disabled(`✓ ${p.name}`)
                else keyboard.text(p.name, `m|${p.name}`)
        }
        return {
            text: [
                `Model: <b>${current}</b> — the orchestrator in every chat; sub-agents keep their own.`,
                chatProvider
                    ? `${fresh ? 'New chats here' : 'This chat'}: <b>${modelRef(chatProvider, chatModel)}</b> (claude comes back to the subscription).`
                    : providers.length
                      ? `${fresh ? 'New chats here' : 'This chat'}: the subscription. A provider button puts ${fresh ? 'them' : 'it'} on that box; /model &lt;provider&gt;:&lt;model&gt; names the model.`
                      : null
            ]
                .filter(Boolean)
                .join('\n'),
            reply_markup: keyboard
        }
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
        const view = modelView(ctx.chat.id)
        await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup })
    })

    // How messages map to chats (`ChatMode`); one setting for every chat of the bot, kept in meta.
    const modeView = (): { text: string; reply_markup: InlineKeyboard } => {
        const fresh = mode() === 'fresh'
        const keyboard = new InlineKeyboard()
        if (topicsOn())
            return {
                text: 'Mode: <b>topics</b> (a BotFather setting of the bot). Every chat is a topic; /new picks the project. Switch topics off in BotFather for the fresh / thread modes.',
                reply_markup: keyboard
            }
        if (fresh) keyboard.disabled('✓ fresh').text('thread', 'md|thread')
        else keyboard.text('fresh', 'md|fresh').disabled('✓ thread')
        return {
            text: fresh
                ? 'Mode: <b>fresh</b>. Every message starts a new chat (no context of the last task); reply to a message to continue its chat. Thread keeps one session until /new.'
                : 'Mode: <b>thread</b>. Messages continue one session until /new; a reply switches to its conversation. Fresh starts a new chat per message.',
            reply_markup: keyboard
        }
    }
    bot.command('mode', async (ctx) => {
        const wanted = ctx.match.trim().toLowerCase()
        if (wanted === 'fresh' || wanted === 'thread') store.setMeta(MODE_META, wanted)
        else if (wanted) return void (await ctx.reply('Usage: /mode fresh | /mode thread'))
        const view = modeView()
        await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup })
    })

    bot.command('stop', async (ctx) => {
        // As a reply: the task of that message's chat (several chats run side by side in `fresh` mode).
        const conversation = repliedConversation(ctx.chat.id, ctx.message?.reply_to_message) ?? conversationFor(ctx)
        // A task waiting in the queue (for a window reset, or behind a running one) is cancelled too.
        const active = tasks.activeTask(conversation.id) ?? tasks.queuedTask(conversation.id)
        if (!active) {
            await ctx.reply('Nothing is running.')
            return
        }
        tasks.stop(active.id)
        await ctx.reply(active.status === 'queued' ? '⏹ Cancelled.' : 'Stopping…')
    })

    // What the owner needs on a phone: where the next message goes, what runs now, the model
    // and the windows (2026-10-05: session id and the workspaces path were noise, the
    // conversation line is shown only when the chat was switched to another thread by a reply).
    const statusView = (
        chatId: number,
        conversation: Conversation = topicFor(chatId)
    ): { text: string; reply_markup: InlineKeyboard } => {
        const topics = topicsOn()
        const fresh = !topics && mode() === 'fresh'
        const defaults = defaultsFor(chatId)
        // A topic is an override: after `/new` the chat's own (newest) conversation is the topic too.
        const switched =
            !fresh && !topics && conversation.id !== tasks.conversationFor('telegram', String(chatId)).id
                ? conversation
                : null
        const active = tasks.activeTask(conversation.id)
        const queued = active ? undefined : tasks.queuedTask(conversation.id)
        const windows = limitsLine(tasks.limits())
        const running = active
            ? `"${titleFrom(active.prompt)}" · ${active.started_at ? elapsed(active.started_at) : 'starting'}${active.ask ? ' · waiting for your answer' : ''}`
            : queued
              ? `"${titleFrom(queued.prompt)}" · queued, waiting for a free slot`
              : 'nothing'
        const keyboard = new InlineKeyboard()
        const current = active ?? queued
        if (current) keyboard.text('⏹ Stop', `s|stop|${current.id}`).danger()
        keyboard.text('🔄 Refresh', 's|refresh')
        return {
            text: [
                `<b>Pocket Factory v${VERSION}</b>`,
                topics
                    ? `Mode: topics — ${routineOf(conversation) ? `routine ${routineOf(conversation)}` : topicName(conversation)}`
                    : fresh
                      ? 'Mode: a new chat per message; reply to a message to continue its chat (/mode: one session)'
                      : 'Mode: one thread until /new (/mode: a new chat per message)',
                switched
                    ? `Thread: ${topicName(switched)} (switched by your reply; /new comes back to this chat)`
                    : null,
                fresh
                    ? `Project of new chats: ${defaults.project ?? 'none (workspaces root)'} (/new &lt;project&gt; to set)`
                    : topics
                      ? `Project: ${conversation.project ?? 'none (workspaces root)'}`
                      : `Project: ${conversation.project ?? 'none (workspaces root)'} (/new &lt;project&gt; starts a fresh one there)`,
                fresh ? `Last chat: ${topicName(conversation)}` : null,
                `Running: ${running}`,
                fresh && defaults.provider
                    ? `Model: ${modelRef(defaults.provider, defaults.model)} for new chats (/model claude comes back; factory: ${tasks.model()})`
                    : !fresh && conversation.provider
                      ? `Model: ${modelRef(conversation.provider, conversation.model)} for this chat (/model claude comes back; factory: ${tasks.model()})`
                      : `Model: ${tasks.model()} (/model to switch)`,
                `Limits: ${windows ?? 'unknown (see /usage)'}`
            ]
                .filter(Boolean)
                .join('\n'),
            reply_markup: keyboard
        }
    }
    bot.command('status', async (ctx) => {
        const view = statusView(ctx.chat.id, conversationFor(ctx))
        await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup })
    })

    // `/usage` shows the last reading; Refresh (or `/usage refresh`) spends one Haiku turn to get a fresh one.
    const usageKeyboard = () => new InlineKeyboard().text('🔄 Refresh (one Haiku turn)', 'u|refresh')
    bot.command('usage', async (ctx) => {
        if (/^refresh\b/i.test(ctx.match)) {
            const sent = await ctx.reply('Asking the CLI…')
            detached('usage refresh', async () => {
                const snapshot = await tasks.probeLimits()
                await bot.api.editMessageText(
                    ctx.chat.id,
                    sent.message_id,
                    snapshot
                        ? limitsReport(snapshot).join('\n')
                        : '❌ The CLI reported no rate-limit status; see the supervisor log.',
                    { reply_markup: usageKeyboard() }
                )
            })
            return
        }
        await ctx.reply(limitsReport(tasks.limits()).join('\n'), { reply_markup: usageKeyboard() })
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
    const submit = async (ctx: Context, prompt: string, attachments: Attachment[] = []) => {
        const chatId = ctx.chat!.id
        // Files sent a moment ago without a caption go with this message.
        attachments = [...takePending(chatId), ...attachments]
        const replyTo = ctx.message?.reply_to_message
        const inTopic = topicConversation(ctx)
        const topic = inTopic ?? (topicsOn() ? null : topicFor(chatId))
        // In a topic the message is for its conversation; a real reply wins over the topic's opening message.
        const replied = inTopic ? null : repliedConversation(chatId, replyTo)
        const route = topic
            ? routeMessage({
                  mode: inTopic ? 'thread' : mode(),
                  replied: Boolean(replied),
                  topicAsks: Boolean(tasks.pendingAsk(topic.id)),
                  topicEmpty: isEmpty(topic)
              })
            : 'fresh'
        let conversation = topic ?? replied ?? freshConversation(chatId)
        if (replied) {
            if (!topicsOn() && topic && replied.id !== topic.id) store.setTelegramTopic(chatId, replied.id)
            conversation = replied
        } else if (route === 'fresh' && topic) {
            conversation = freshConversation(chatId)
        }
        if (route === 'fresh' && !replied) {
            // A reply whose chat is gone (deleted, or older than the bot remembers) brings the message it answers.
            const quoted = replyTo ? quoteReply(replyTo.text ?? replyTo.caption) : null
            if (quoted) prompt = `${quoted}\n\n${prompt}`
        }
        const switched = !topicsOn() && replied && topic && replied.id !== topic.id ? replied : null
        const first = isEmpty(conversation)
        const answering = Boolean(tasks.pendingAsk(conversation.id))
        const task = tasks.submit(conversation.id, 'telegram', prompt, { attachments })
        // The conversation's topic (topics on): made now for a new chat. A message typed in General
        // is copied into the topic, so the topic reads as the whole conversation and the reply quotes it there.
        const thread = await threadFor(conversation, chatId)
        let replyToId = ctx.message?.message_id
        if (thread && ctx.message && !inTopic) {
            try {
                const copy = await bot.api.copyMessage(chatId, chatId, ctx.message.message_id, {
                    message_thread_id: thread
                })
                replyToId = copy.message_id
                remember(chatId, copy.message_id, conversation.id, task.id)
            } catch (error) {
                log.warn(`could not copy the message into topic ${thread}: ${errorText(error)}`)
            }
        }
        // The owner's own message: a reply to it later continues this chat, and its reactions tell the task's state.
        if (ctx.message) {
            remember(chatId, ctx.message.message_id, conversation.id, task.id)
            if (!origins.has(task.id))
                origins.set(task.id, {
                    chatId,
                    messageId: ctx.message.message_id,
                    replyTo: replyToId ?? ctx.message.message_id,
                    thread,
                    reaction: null
                })
            react(task.id, reactionFor(task))
        }
        if (!answering && !draft.has(task.id))
            draft.start(
                task.id,
                chatId,
                draftState(task, {
                    head:
                        first && (topicsOn() || mode() === 'fresh')
                            ? `▶️ New chat${conversation.project ? ` in ${conversation.project}` : ''} ·`
                            : '▶️',
                    startedAt: Date.now(),
                    waiting: waitingFor(task)
                }),
                thread
            )
        const notes = [
            switched ? `↪️ ${topicName(switched)}` : null,
            answering ? '↩️ Passed on as the answer, continuing…' : null,
            attachments.length ? `📎 ${attachments.length} file${attachments.length === 1 ? '' : 's'} with it` : null
        ].filter(Boolean)
        if (notes.length) {
            const sent = await bot.api.sendMessage(chatId, notes.join(' · '), { message_thread_id: thread })
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
        try {
            switch (kind) {
                case 'a': {
                    const ask = tasks.task(a)?.ask
                    if (!ask) throw new Error('this request is no longer open')
                    const question = askQuestions(ask)[Number(b)]
                    const option = question?.options?.[Number(c)]
                    if (!question || !option) throw new Error('this option is no longer available')
                    tasks.answer(a, { answers: { [question.question]: option.label } })
                    await ctx.answerCallbackQuery({ text: `✓ ${option.label}` })
                    return
                }
                case 'p': {
                    if (!tasks.task(a)?.ask) throw new Error('this request is no longer open')
                    tasks.answer(a, b === 'allow' ? { behavior: 'allow' } : { behavior: 'deny' })
                    await ctx.answerCallbackQuery({ text: b === 'allow' ? '✓ Allowed' : 'Denied' })
                    return
                }
                case 'r':
                    return await routineButton(ctx)
                case 'n': {
                    const project = a === '-' ? null : a
                    if (project && !tasks.hasProject(project)) throw new Error(`project "${project}" is gone`)
                    await ctx.answerCallbackQuery({ text: project ? `New chat in ${project}` : 'New chat' })
                    await ctx
                        .editMessageReplyMarkup({
                            reply_markup: new InlineKeyboard().disabled(`✓ ${project ?? 'No project'}`)
                        })
                        .catch(() => undefined)
                    await newTopicChat(ctx.chat!.id, project)
                    return
                }
                case 'm': {
                    const text = applyModel(ctx.chat!.id, a === 'p' ? b : a)
                    await ctx.answerCallbackQuery({ text })
                    const view = modelView(ctx.chat!.id)
                    await ctx
                        .editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup })
                        .catch(() => undefined)
                    return
                }
                case 'md': {
                    if (a === 'fresh' || a === 'thread') store.setMeta(MODE_META, a)
                    await ctx.answerCallbackQuery({ text: `Mode: ${mode()}` })
                    const view = modeView()
                    await ctx
                        .editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup })
                        .catch(() => undefined)
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
                    const view = statusView(ctx.chat!.id, conversationFor(ctx))
                    await ctx
                        .editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup })
                        .catch(() => undefined)
                    return
                }
                case 'u': {
                    await ctx.answerCallbackQuery({ text: 'Asking the CLI…' })
                    const message = ctx.callbackQuery.message
                    if (!message) return
                    await ctx.editMessageText('Asking the CLI…').catch(() => undefined)
                    detached('usage refresh', async () => {
                        const snapshot = await tasks.probeLimits()
                        await bot.api.editMessageText(
                            message.chat.id,
                            message.message_id,
                            snapshot
                                ? limitsReport(snapshot).join('\n')
                                : '❌ The CLI reported no rate-limit status; see the supervisor log.',
                            { reply_markup: usageKeyboard() }
                        )
                    })
                    return
                }
                default:
                    await ctx.answerCallbackQuery()
            }
        } catch (error) {
            await ctx.answerCallbackQuery({ text: `❌ ${errorText(error)}`, show_alert: true }).catch(() => undefined)
        }
    })

    // The Stop button under a task's draft.
    bot.on('stopped_message_generation', (ctx) => {
        const stopped = ctx.update.stopped_message_generation
        draft.stopped(stopped.chat.id, stopped.draft_id)
    })

    // A topic the owner made in the client: a chat of its own from the start, in the project of its name if there is one.
    bot.on('message:forum_topic_created', (ctx) => {
        const thread = ctx.message.message_thread_id
        if (thread && !store.telegramThread(ctx.chat.id, thread))
            bindTopic(ctx.chat.id, thread, ctx.message.forum_topic_created.name)
    })

    bot.on('message:text', async (ctx) => {
        await submit(ctx, ctx.message.text)
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
            const conversation = conversationFor(ctx)
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
            const held = pending.get(chatId)
            const files = [...(held && Date.now() - held.at < PENDING_MS ? held.files : []), ...saved].slice(
                -MAX_ATTACHMENTS
            )
            pending.set(chatId, { files, at: Date.now() })
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
        if (!group) return void detached('attachment', () => receive([item]))
        const key = `${ctx.chat.id}:${group}`
        const list = albums.get(key)
        if (list) return void list.push(item)
        albums.set(key, [item])
        setTimeout(() => {
            const items = albums.get(key) ?? []
            albums.delete(key)
            detached('album', () => receive(items))
        }, ALBUM_MS)
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
        detached('voice message', async () => {
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
                await ctx.reply(`🎤 ${text}`, { reply_parameters: { message_id: ctx.message.message_id } })
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
            draft.end(task.id)
            return
        }
        const chatId = chatFor(task)
        if (!chatId) return
        if (task.status === 'running' && !draft.has(task.id)) {
            const conversation = tasks.conversationOf(task)
            void (conversation ? threadFor(conversation, chatId) : Promise.resolve(undefined)).then((thread) => {
                if (!draft.has(task.id) && tasks.task(task.id)?.status === 'running')
                    draft.start(task.id, chatId, draftState(task, { waiting: waitingFor(task) }), thread)
            })
            return
        }
        draft.update(task.id, () => ({ waiting: waitingFor(task) }))
    })
    tasks.on('event', (event: TaskEvent) => draft.event(event))

    // Questions and permission requests go to the conversation's chat with
    // buttons; once the request is settled, from whichever channel, the
    // buttons give way to one that names the answer. Keyed by request and
    // question, so a poll of the same task never sends a question twice.
    const sentAsks = new Map<string, { taskId: string; chatId: number; messageId: number; question: string | null }>()
    const settle = async (key: string, note: string) => {
        const sent = sentAsks.get(key)
        if (!sent) return
        sentAsks.delete(key)
        try {
            await bot.api.editMessageReplyMarkup(sent.chatId, sent.messageId, {
                reply_markup: new InlineKeyboard().disabled(note.slice(0, 60))
            })
        } catch (error) {
            log.warn(`could not settle ask message ${sent.messageId}: ${errorText(error)}`)
        }
    }
    tasks.on('task', (task) => {
        if (task.status !== 'running') {
            for (const [key, sent] of sentAsks)
                if (sent.taskId === task.id) void settle(key, '— the task ended before an answer')
            return
        }
        const chatId = chatFor(task)
        if (!chatId) return
        if (!task.ask) {
            // Answered from the web (the `answer` event settled it already) or withdrawn by the CLI.
            for (const [key, sent] of sentAsks) if (sent.taskId === task.id) void settle(key, '— withdrawn')
            return
        }
        sendAsk(task, chatId)
    })
    const sendAsk = (task: Task, chatId: number, head = '') => {
        if (!task.ask) return
        const message = askMessage(task, task.ask)
        if (!message || sentAsks.has(message.key)) return
        const question = task.ask.kind === 'question' ? (openQuestions(task.ask)[0]?.question ?? null) : null
        sentAsks.set(message.key, { taskId: task.id, chatId, messageId: 0, question })
        const conversation = tasks.conversationOf(task)
        const send = (thread: number | undefined) =>
            bot.api.sendMessage(chatId, `${head}${message.text}`, {
                message_thread_id: thread,
                reply_markup: message.markup,
                ...noPreview
            })
        void (conversation ? threadFor(conversation, chatId) : Promise.resolve(undefined))
            .then((thread) =>
                send(thread).catch((error) => {
                    if (!thread || !threadGone(error) || !conversation) throw error
                    topicDeleted(conversation, chatId)
                    return send(undefined)
                })
            )
            .then((sent) => {
                const entry = sentAsks.get(message.key)
                if (entry) entry.messageId = sent.message_id
                remember(chatId, sent.message_id, task.conversation_id, task.id)
            })
            .catch((error) => {
                sentAsks.delete(message.key)
                log.error(`ask to chat ${chatId} failed`, error)
            })
    }
    const askFromWeb = (task: Task) => {
        const conversation = tasks.conversationOf(task)
        const chatId = conversation && webChatFor(conversation)
        if (!conversation || !chatId) return
        switchTo(chatId, conversation)
        sendAsk(
            task,
            chatId,
            topicsOn()
                ? `💻 ${topicName(conversation)} — from the web.\n\n`
                : `💻 ${topicName(conversation)} — from the web. This chat now continues that thread.\n\n`
        )
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
        if (task.status !== 'queued' || !task.not_before || toldWaits.get(task.id) === task.limit_waits) return
        toldWaits.set(task.id, task.limit_waits)
        if (task.source !== 'telegram' && task.source !== 'routine' && task.source !== 'cron') return
        const chatId = chatFor(task)
        if (!chatId) return
        const clock = clockAt(task.not_before, config.timezone)
        const head = task.schedule ? `⏱ ${task.schedule}: ` : ''
        const conversation = tasks.conversationOf(task)
        void (conversation ? threadFor(conversation, chatId) : Promise.resolve(undefined))
            .then((thread) =>
                bot.api.sendMessage(
                    chatId,
                    `${head}⏸ Subscription limit reached. The task continues by itself at ${clock} (in ${resetsIn(task.not_before!)}), in the same session.`,
                    {
                        message_thread_id: thread,
                        reply_markup: new InlineKeyboard().text('⏹ Cancel it', `s|stop|${task.id}`).danger()
                    }
                )
            )
            .then((sent) => remember(chatId, sent.message_id, task.conversation_id, task.id))
            .catch((error) => log.error(`limit notice to chat ${chatId} failed`, error))
    })

    // ---- replies -------------------------------------------------------------------------------

    /** Buttons under a reply: the task page, its pull request, and for a routine's report the routine itself. */
    const replyButtons = (task: Task): InlineKeyboard | undefined => {
        const keyboard = new InlineKeyboard()
        let any = false
        if (publicUrl) {
            keyboard.url('🌐 Open', `${publicUrl}/tasks/${task.id}`)
            any = true
        }
        if (task.git?.pr) {
            keyboard.url(`PR #${task.git.pr.number}`, task.git.pr.url)
            any = true
        }
        if (task.schedule && routines?.get(task.schedule)) {
            if (any) keyboard.row()
            keyboard
                .text('▶️ Run again', routineData('fire', task.schedule))
                .text('📋 Routine', routineData('open', task.schedule))
            any = true
        }
        return any ? keyboard : undefined
    }
    const deliver = async (chatId: number, task: Task, head: string, replyTo?: number) => {
        draft.end(task.id)
        const body =
            task.status === 'done'
                ? (task.result ?? '')
                : task.status === 'cancelled'
                  ? '⏹ Stopped.'
                  : `❌ ${task.error || 'failed'}`
        const conversation = tasks.conversationOf(task)
        const thread = conversation ? await threadFor(conversation, chatId) : undefined
        const send = (thread: number | undefined, head: string) =>
            sendReply(bot, chatId, `${head}${body}`, {
                thread,
                footer: footer(task, tasks.limits(), publicUrl, tasks.delegationsOf(task.id)),
                replyTo,
                markup: replyButtons(task),
                // A pull request is an occasion.
                effect: task.status === 'done' && task.git?.pr ? EFFECT.party : undefined
            })
        try {
            return await send(thread, head)
        } catch (error) {
            // The owner deleted the topic meanwhile: the reply still arrives, in General.
            if (!thread || !threadGone(error) || !conversation) throw error
            topicDeleted(conversation, chatId)
            return send(undefined, `🗑 *${topicName(conversation)}* — its topic was deleted.\n\n${head}`)
        }
    }

    // Deliver results of Telegram-originated tasks back to their chat, and of
    // routine runs to the owner (unless the routine says notify: none).
    tasks.on('task', (task) => {
        if (
            (task.source !== 'telegram' && task.source !== 'routine' && task.source !== 'cron') ||
            task.status === 'queued' ||
            task.status === 'running'
        )
            return
        const origin = origins.get(task.id)
        origins.delete(task.id)
        const chatId = chatFor(task)
        if (!chatId) return
        const head = task.schedule ? `⏱ **${task.schedule}**\n\n` : ''
        // Delivered = seen: the web's "unread" mark goes; a failed delivery keeps it, so the reply is not lost.
        void deliver(chatId, task, head, origin?.chatId === chatId ? origin.replyTo : undefined)
            .then((ids) => {
                remember(chatId, ids, task.conversation_id, task.id)
                tasks.markRead(task.conversation_id)
            })
            .catch((error) => log.error(`delivery to chat ${chatId} failed`, error))
    })

    // A web task's reply nobody opened in the web goes here after a while (WebNotifier),
    // and the chat switches to its thread, so the next message continues it.
    const deliverWeb = async (task: Task) => {
        const conversation = tasks.conversationOf(task)
        const chatId = conversation && webChatFor(conversation)
        if (!conversation || !chatId) return
        switchTo(chatId, conversation)
        try {
            const ids = await deliver(chatId, task, `${fromWeb(conversation)}\n\n`)
            remember(chatId, ids, task.conversation_id, task.id)
            tasks.markRead(task.conversation_id)
        } catch (error) {
            log.error(`web reply to chat ${chatId} failed`, error)
        }
    }
    tasks.on('task', (task) => notifier.onTask(task))

    // A prefilter that breaks (credentials expired, a host down) would
    // otherwise fail silently every hour: say so once per distinct error. A
    // minute the factory slept through, a firing skipped because the previous
    // run still waits, and a firing skipped for the soft-stop are told too,
    // with the routine's buttons under the notice.
    const lastNotice = new Map<string, string>()
    routines?.on('run', (run, spec) => {
        if (!ownerChat) return
        const text = routineNotice(run, spec, lastNotice, config.timezone)
        if (!text) return
        const markup = new InlineKeyboard()
            .text('▶️ Run now', routineData('fire', run.schedule))
            .success()
            .text('📋 Routine', routineData('open', run.schedule))
        const conversation = store.findConversation('web', `schedule:${run.schedule}`)
        void (conversation ? threadFor(conversation, ownerChat) : Promise.resolve(undefined))
            .then((thread) => sendMarkdown(bot, ownerChat, text, { markup, thread }))
            .then((ids) => {
                if (conversation) remember(ownerChat, ids, conversation.id, run.task_id)
            })
            .catch((error) => log.error('routine notice failed', error))
    })

    // A topic follows its conversation: the Haiku title renames a topic named after the
    // chat (a project's keeps the project's name), a chat deleted in the web takes its topic along.
    tasks.on('conversation', (conversation, change) => {
        if (!topicsOn()) return
        const chatId = chatOf(conversation)
        const thread = chatId === null ? undefined : store.threadOf(conversation.id, chatId)
        if (!chatId || !thread) return
        if (change === 'deleted') {
            store.dropTelegramThread(chatId, thread.thread_id)
            bot.api
                .deleteForumTopic(chatId, thread.thread_id)
                .catch((error) => log.warn(`could not delete topic ${thread.thread_id}: ${errorText(error)}`))
            return
        }
        if (thread.name === conversation.project || routineOf(conversation)) return
        const name = topicTitle(conversation, chatId, thread.name)
        if (name === thread.name) return
        store.renameTelegramThread(chatId, thread.thread_id, name)
        bot.api
            .editForumTopic(chatId, thread.thread_id, { name })
            .catch((error) => log.warn(`could not rename topic ${thread.thread_id}: ${errorText(error)}`))
    })

    // The web UI's door: the owner hears about every sign-in, the first wrong
    // password of a streak (the ones after it would only repeat the message)
    // and a lock, so an attempt to guess the password is never silent.
    auth?.on('notice', (notice) => {
        if (!ownerChat) return
        const where = `from \`${notice.ip}\` (${describeUserAgent(notice.userAgent)})`
        const name = notice.username ? ` as \`${notice.username}\`` : ''
        const text =
            notice.kind === 'ok'
                ? `🔓 Signed in to the web UI ${where}. Not you? Settings → Security → Sign out everywhere, and change WEB_AUTH_PASSWORD.`
                : notice.kind === 'locked'
                  ? `🔒 Web sign-in locked for ${where} until ${new Date(notice.locked_until ?? Date.now()).toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' })} after ${notice.failures} wrong passwords${name}.`
                  : `⚠️ Wrong web password ${where}${name}. ${auth.policy.max_failures - notice.failures} more and that address is locked for ${auth.policy.lock_minutes} min.`
        sendMarkdown(bot, ownerChat, text).catch((error) => log.error('sign-in notice failed', error))
    })

    bot.catch((err) => {
        log.error('unhandled bot error', err.error)
    })

    return bot
}
