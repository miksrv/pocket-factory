import { Bot, type Context, InlineKeyboard } from 'grammy'

import type { Config } from './config.js'
import { createLogger } from './logger.js'
import type { Ask, Conversation, RateLimitSnapshot, Store, Task, TaskEvent } from './store/index.js'
import { transcribe } from './stt/groq.js'
import type { Schedules } from './schedules/service.js'
import { askQuestions, openQuestions, type TaskService } from './tasks/service.js'
import { markdownToTelegramHtml } from './telegram/format.js'
import { MODEL_ALIASES } from './claude/models.js'

const log = createLogger('bot')

const TELEGRAM_MAX_LENGTH = 4000

/**
 * Split long replies so every chunk fits Telegram's message limit. Cuts fall
 * on line breaks, and a fenced code block that straddles a cut is closed at
 * the end of one chunk and reopened at the start of the next, so the fence
 * markers stay balanced in every message.
 */
export function chunk(text: string): string[] {
    const parts: string[] = []
    let rest = text
    let openFence: string | null = null
    while (rest.length > TELEGRAM_MAX_LENGTH) {
        const budget = TELEGRAM_MAX_LENGTH - (openFence === null ? 0 : 4)
        let cut = rest.lastIndexOf('\n', budget)
        if (cut < budget / 2) cut = budget
        let head = rest.slice(0, cut)
        rest = rest.slice(cut).trimStart()
        // Which fence is open at the end of this chunk? The head already
        // starts with the re-opened fence when one carried over, so the
        // scan starts from a clean state.
        openFence = null
        for (const line of head.split('\n')) {
            const fence = line.match(/^\s*```(\S*)/)
            if (fence) openFence = openFence === null ? fence[1] : null
        }
        if (openFence !== null) {
            head += '\n```'
            rest = `\`\`\`${openFence}\n${rest}`
        }
        parts.push(head)
    }
    parts.push(rest)
    return parts
}

/** Telegram's "Too Many Requests: retry after N" as the seconds to wait, else null. */
function retryAfter(error: unknown): number | null {
    const parameters = (error as { parameters?: { retry_after?: number } } | undefined)?.parameters
    return typeof parameters?.retry_after === 'number' ? parameters.retry_after : null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase())

/** Sends one message; returns its id. */
async function sendOne(bot: Bot, chatId: number, part: string): Promise<number> {
    for (let attempt = 0; ; attempt++) {
        try {
            const sent = await bot.api.sendMessage(chatId, markdownToTelegramHtml(part), { parse_mode: 'HTML' })
            return sent.message_id
        } catch (error) {
            const wait = retryAfter(error)
            if (wait !== null && attempt < 3) {
                await sleep((wait + 1) * 1000)
                continue
            }
            // Telegram rejected the markup — better a plain message than none.
            log.warn(`html reply rejected, falling back to plain text: ${error instanceof Error ? error.message : error}`)
            const sent = await bot.api.sendMessage(chatId, part)
            return sent.message_id
        }
    }
}

/** Every chunk is attempted: one failed chunk is logged, the rest still arrive. Returns the ids of the messages sent. */
async function sendMarkdown(bot: Bot, chatId: number, text: string): Promise<number[]> {
    let failed = 0
    const ids: number[] = []
    for (const part of chunk(text || '(empty reply)')) {
        try {
            ids.push(await sendOne(bot, chatId, part))
        } catch (error) {
            failed++
            log.error(`chunk to chat ${chatId} failed: ${error instanceof Error ? error.message : error}`)
        }
    }
    if (failed) throw new Error(`${failed} chunk(s) not delivered`)
    return ids
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const pct = (used: number) => `${Math.round(used * 100)}%`

function resetsIn(iso: string): string {
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return 'now'
    const h = Math.floor(ms / 3_600_000)
    const m = Math.round((ms % 3_600_000) / 60_000)
    if (h >= 48) return `${Math.round(h / 24)}d`
    return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function resetsAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
    return `${Math.floor(ms / 86_400_000)} d ago`
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
    if (!limits) return ['Subscription limits: unknown yet — the CLI reports them with the first task, or send /usage refresh.']
    const lines: string[] = []
    if (limits.five_hour) lines.push(`5-hour window: ${pct(limits.five_hour.used)} used · resets in ${resetsIn(limits.five_hour.resets_at)}`)
    if (limits.seven_day) lines.push(`Weekly window: ${pct(limits.seven_day.used)} used · resets in ${resetsIn(limits.seven_day.resets_at)}`)
    if (limits.status !== 'allowed') lines.push(`Status: ${limits.status}`)
    lines.push(`As of ${new Date(limits.ts).toLocaleString('en-GB', { hour12: false })}`)
    return lines
}

/**
 * Footer under every reply: what this task consumed and how full the windows
 * are now. Tokens, not money — the subscription is metered in windows.
 */
function footer(task: Task, limits: RateLimitSnapshot | undefined): string {
    const tokens = task.input_tokens + task.output_tokens + task.cache_read_tokens + task.cache_creation_tokens
    const parts = [`${task.num_turns} turns`, `${fmtTokens(tokens)} tokens`]
    if (task.window_5h_delta !== null) parts.push(task.window_5h_delta < 0.01 ? '<1% of 5h' : `+${Math.round(task.window_5h_delta * 100)}% of 5h`)
    parts.push(`${Math.round(task.duration_ms / 1000)}s`)
    const windows = limitsLine(limits)
    return `— ${parts.join(' · ')}${windows ? `\n— windows: ${windows}` : ''}`
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
 * "Other" choice — typed when the task is the chat's topic, as a reply to
 * the question otherwise (a scheduled run's question, say). A permission
 * request gets Allow / Deny.
 */
function askMessage(task: Task, ask: Ask, inTopic: boolean): { key: string; text: string; keyboard: InlineKeyboard } | null {
    if (ask.kind === 'permission') {
        const text = [`🔐 The agent asks to run ${ask.tool_name}:`, '', permissionSummary(ask.input), '', 'Allow it or deny it below.'].join('\n')
        return { key: ask.request_id, text, keyboard: new InlineKeyboard().text('✅ Allow', `p|${task.id}|allow`).text('⛔ Deny', `p|${task.id}|deny`) }
    }
    const questions = askQuestions(ask)
    const next = openQuestions(ask)[0]
    if (!next) return null
    const index = questions.indexOf(next)
    const lines = [`❓ ${next.header ? `${next.header}: ` : ''}${next.question}`]
    const options = next.options ?? []
    if (options.length) {
        lines.push('')
        for (const option of options) lines.push(`• ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    }
    const typed = inTopic ? 'type your answer' : 'reply to this message with your answer'
    lines.push('', options.length ? (next.multiSelect ? `Tap an option, or ${typed} (several: comma-separated).` : `Tap an option, or ${typed}.`) : `${cap(typed)}.`)
    if (questions.length > 1) lines.push(`(question ${index + 1} of ${questions.length})`)
    const keyboard = new InlineKeyboard()
    options.forEach((option, i) => keyboard.text(option.label.slice(0, 60), `a|${task.id}|${index}|${i}`).row())
    return { key: `${ask.request_id}:${index}`, text: lines.join('\n'), keyboard }
}

export function createBot(config: Config, tasks: TaskService, store: Store, schedules?: Schedules): Bot {
    if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set')
    const bot = new Bot(config.telegram.botToken)

    // A chat talks to one conversation at a time — its topic: its own by
    // default, or the one the owner switched to by replying to a message of
    // the bot (a schedule's report, a question). `/new` switches back.
    const topicFor = (chatId: number): Conversation => store.telegramTopic(chatId) ?? tasks.conversationFor('telegram', String(chatId))
    const conversationFor = (ctx: Context) => topicFor(ctx.chat!.id)
    const isTopic = (chatId: number, conversationId: string) => topicFor(chatId).id === conversationId
    /** The bot sent a message about a conversation: a reply to it later continues that conversation. */
    const remember = (chatId: number, messageIds: number | number[], conversationId: string, taskId: string | null = null) => {
        for (const id of Array.isArray(messageIds) ? messageIds : [messageIds]) store.rememberTelegramMessage(chatId, id, conversationId, taskId)
    }
    const topicName = (conversation: Conversation) => conversation.title || (conversation.channel === 'telegram' ? 'this chat' : 'web conversation')
    // Where scheduled runs report and ask: the owner's private chat (a user's chat id is the user id).
    const ownerChat = [...config.telegram.allowedUserIds][0]
    /** The chat a task talks to: its own for a Telegram task, the owner's for a scheduled one or a topic's, none otherwise. */
    const chatFor = (task: Task): number | null => {
        if (task.source === 'cron') return task.schedule && schedules?.spec(task.schedule)?.notify === 'none' ? null : ownerChat ?? null
        const conversation = tasks.conversationOf(task)
        if (!conversation) return null
        if (conversation.channel === 'telegram') return Number(conversation.external_id) || null
        // A Telegram message into another conversation (a schedule's thread): the chat that has it as its topic.
        if (task.source === 'telegram') return store.telegramChatsFor(conversation.id)[0] ?? ownerChat ?? null
        return null
    }

    // Whitelist: the bot fronts an agent with repository access, so it must
    // ignore everyone who is not the owner.
    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id
        if (!userId || !config.telegram.allowedUserIds.has(userId)) {
            log.warn(`ignored update from user ${userId ?? 'unknown'}`)
            return
        }
        await next()
    })

    bot.command('start', async (ctx) => {
        await ctx.reply(
            [
                'Pocket Factory is online.',
                '',
                'Send a task as text or voice. Replies continue the same Claude Code session.',
                '/new [project] — start a fresh session, optionally inside a project checkout',
                'Reply to a message of mine (a report, a question) to continue in its conversation; /new comes back to a fresh one.',
                '/project <name> — bind this chat to a project (its MCP servers, agents and rules apply)',
                '/model [sonnet|opus|haiku|fable] — the orchestrator\'s model for every next task, in every chat',
                '/stop — cancel the running task',
                '/status — what is going on',
                '/usage — subscription limits (5-hour and weekly windows)',
                '/schedules — recurring tasks and their last runs',
                '/run <name> — fire a schedule now'
            ].join('\n')
        )
    })

    bot.command('schedules', async (ctx) => {
        const list = schedules?.list() ?? []
        if (!list.length) return void (await ctx.reply('No schedules yet — create one in the web UI (Schedules).'))
        const lines = list.map((s) => {
            const state = s.errors.length ? '⚠️ invalid' : s.enabled ? '🟢 on' : '⚪️ off'
            const last = s.last_run ? `last ${s.last_run.status}${s.last_run.note ? ` (${s.last_run.note})` : ''} ${resetsAgo(s.last_run.fired_at)}` : 'never ran'
            const next = s.next_run ? `next in ${resetsIn(s.next_run)}` : null
            return `${state} ${s.name} — ${s.cron_text ?? s.cron ?? '?'}${s.project ? ` · ${s.project}` : ''}\n    ${[last, next].filter(Boolean).join(' · ')}`
        })
        await ctx.reply(lines.join('\n'))
    })

    bot.command('run', async (ctx) => {
        const name = ctx.match.trim()
        if (!schedules) return void (await ctx.reply('Schedules are not available.'))
        if (!name) return void (await ctx.reply('Usage: /run <schedule name>'))
        if (!schedules.get(name)) return void (await ctx.reply(`No schedule named "${name}". /schedules lists them.`))
        const run = await schedules.fire(name, 'manual')
        const sent = await ctx.reply(run.status === 'queued' ? `▶️ ${name}: task queued (${run.note}). The report comes here when it is done; reply to it to follow up.` : `${name}: ${run.status}${run.note ? ` — ${run.note}` : ''}`)
        const task = run.task_id ? tasks.task(run.task_id) : undefined
        if (task) remember(ctx.chat.id, sent.message_id, task.conversation_id, task.id)
    })

    // `/new` forgets the session; `/new <project>` also starts the next one inside that checkout.
    bot.command('new', async (ctx) => {
        const project = ctx.match.trim() || null
        if (project && !tasks.hasProject(project)) {
            await ctx.reply(`Unknown project "${project}". Projects are the files in /data/config/projects; say "onboard project ${project}" to create one.`)
            return
        }
        const fresh = tasks.newConversation('telegram', String(ctx.chat.id), null, project)
        store.setTelegramTopic(ctx.chat.id, fresh.id)
        await ctx.reply(project ? `Fresh session in ${project}. Next message runs from its checkout.` : 'Fresh session. Next message starts from scratch.')
    })

    // `/project <name>` binds the current chat; the Claude Code session restarts in the project's directory.
    bot.command('project', async (ctx) => {
        const conversation = conversationFor(ctx)
        const project = ctx.match.trim()
        if (!project) {
            await ctx.reply(conversation.project ? `This chat works in ${conversation.project}. /project <name> to switch, /project - to unbind.` : 'This chat is not bound to a project. /project <name> binds it.')
            return
        }
        try {
            const updated = tasks.setProject(conversation.id, project === '-' ? null : project)
            await ctx.reply(updated.project ? `Bound to ${updated.project}. The next task runs from its checkout in a fresh session.` : 'Unbound. The next task runs from the workspaces root.')
        } catch (error) {
            await ctx.reply(`❌ ${error instanceof Error ? error.message : error}`)
        }
    })

    // One model for the whole factory, applied to the next task everywhere; sub-agents keep the `model:` of their files.
    bot.command('model', async (ctx) => {
        const alias = ctx.match.trim().toLowerCase()
        if (!alias) {
            await ctx.reply(`Model: ${tasks.model()}. /model <${MODEL_ALIASES.join('|')}> switches it for every next task in every chat; sub-agents keep their own.`)
            return
        }
        try {
            const model = tasks.setModel(alias)
            await ctx.reply(`Model: ${model} from the next task on, in every chat. A running task keeps the one it started with.`)
        } catch (error) {
            await ctx.reply(`❌ ${error instanceof Error ? error.message : error}`)
        }
    })

    bot.command('stop', async (ctx) => {
        const active = tasks.activeTask(conversationFor(ctx).id)
        if (!active) {
            await ctx.reply('Nothing is running.')
            return
        }
        tasks.stop(active.id)
        await ctx.reply('Stopping…')
    })

    bot.command('status', async (ctx) => {
        const conversation = conversationFor(ctx)
        const active = tasks.activeTask(conversation.id)
        const windows = limitsLine(tasks.limits())
        await ctx.reply(
            [
                `Conversation: ${conversation.channel === 'telegram' ? 'this chat' : topicName(conversation)} (reply to a message to switch, /new for a fresh one)`,
                `Running task: ${active ? 'yes' : 'no'}`,
                `Project: ${conversation.project ?? 'none (workspaces root)'}`,
                `Session: ${conversation.session_id ?? 'none'}`,
                `Workspaces: ${config.paths.workspacesRoot}`,
                `Model: ${tasks.model()} (/model to switch)`,
                `Limits: ${windows ?? 'unknown (see /usage)'}`
            ].join('\n')
        )
    })

    // grammY handles one update at a time, so anything slow runs detached:
    // a /stop sent during a probe or a transcription must not wait for it.
    const detached = (label: string, work: () => Promise<void>) => {
        void work().catch((error) => log.error(`${label} failed`, error))
    }

    // `/usage` shows the last reading; `/usage refresh` spends one Haiku turn
    // to get a fresh one.
    bot.command('usage', async (ctx) => {
        if (/^refresh\b/i.test(ctx.match)) {
            await ctx.reply('Asking the CLI…')
            detached('usage refresh', async () => {
                const snapshot = await tasks.probeLimits()
                await ctx.reply(snapshot ? limitsReport(snapshot).join('\n') : '❌ The CLI reported no rate-limit status; see the supervisor log.')
            })
            return
        }
        await ctx.reply([...limitsReport(tasks.limits()), '', '/usage refresh — ask the CLI now (one Haiku turn)'].join('\n'))
    })

    // A message that *starts* with an unknown command is a typo, not a task
    // for the agent. A slash word further in ("fix the /login page") is text.
    bot.on('message:entities:bot_command', async (ctx, next) => {
        const leading = ctx.message.entities?.some((e) => e.type === 'bot_command' && e.offset === 0)
        if (!leading) return next()
        await ctx.reply(`Unknown command ${ctx.message.text.split(/\s/)[0]}. See /start.`)
    })

    // A reply to a message of the bot switches the chat to that message's
    // conversation (a schedule's thread, an older session) and stays there;
    // then, while the agent waits for an answer, the message is the answer
    // (see TaskService.submit), otherwise it is the next task.
    const submit = async (ctx: Context, prompt: string) => {
        const chatId = ctx.chat!.id
        let conversation = conversationFor(ctx)
        let switched: Conversation | null = null
        const replyTo = ctx.message?.reply_to_message
        const target = replyTo?.from?.id === ctx.me.id ? store.telegramMessage(chatId, replyTo.message_id) : undefined
        if (target && target.conversation_id !== conversation.id) {
            const found = store.getConversation(target.conversation_id)
            if (found && !found.deleted_at) {
                store.setTelegramTopic(chatId, found.id)
                conversation = found
                switched = found
            }
        }
        const answering = Boolean(tasks.pendingAsk(conversation.id))
        const waits = !answering && tasks.willWait(conversation.id)
        const task = tasks.submit(conversation.id, 'telegram', prompt)
        const head = switched ? `↪️ ${topicName(switched)} · ` : ''
        const sent = await ctx.reply(`${head}${answering ? '↩️ Passed on, continuing…' : waits ? '⏳ Queued…' : conversation.session_id ? '▶️ Continuing…' : '▶️ Working…'}`)
        remember(chatId, sent.message_id, conversation.id, task.id)
    }

    // Buttons under a question or a permission request. The data names the
    // task and the option, never the answer text: the ask on the task is the
    // truth, so a stale button (already answered, task over) is refused.
    bot.on('callback_query:data', async (ctx) => {
        const [kind, taskId, a, b] = ctx.callbackQuery.data.split('|')
        try {
            const ask = tasks.task(taskId)?.ask
            if (!ask) throw new Error('this request is no longer open')
            if (kind === 'a') {
                const question = askQuestions(ask)[Number(a)]
                const option = question?.options?.[Number(b)]
                if (!question || !option) throw new Error('this option is no longer available')
                tasks.answer(taskId, { answers: { [question.question]: option.label } })
                await ctx.answerCallbackQuery({ text: `✓ ${option.label}` })
            } else if (kind === 'p') {
                tasks.answer(taskId, b === 'allow' ? { behavior: 'allow' } : { behavior: 'deny' })
                await ctx.answerCallbackQuery({ text: b === 'allow' ? '✓ Allowed' : 'Denied' })
            } else {
                await ctx.answerCallbackQuery()
            }
        } catch (error) {
            await ctx.answerCallbackQuery({ text: `❌ ${error instanceof Error ? error.message : error}`, show_alert: true }).catch(() => undefined)
        }
    })

    bot.on('message:text', async (ctx) => {
        await submit(ctx, ctx.message.text)
    })

    // Voice notes and audio files: download from Telegram, transcribe, then
    // treat the text exactly like a typed message. The transcript is echoed
    // back so the owner can see what the agent is going to act on.
    bot.on(['message:voice', 'message:audio'], async (ctx) => {
        if (!config.stt.groqApiKey) {
            await ctx.reply('Voice messages are disabled: set GROQ_API_KEY in .env to enable transcription.')
            return
        }
        const media = ctx.message.voice ?? ctx.message.audio!
        const apiKey = config.stt.groqApiKey
        detached('voice message', async () => {
            try {
                const file = await ctx.api.getFile(media.file_id)
                if (!file.file_path) throw new Error('Telegram returned no file path')
                const response = await fetch(`https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) })
                if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
                const audio = Buffer.from(await response.arrayBuffer())
                const text = await transcribe(audio, file.file_path, {
                    apiKey,
                    model: config.stt.model,
                    language: config.stt.language,
                    mimeType: media.mime_type
                })
                if (!text) {
                    await ctx.reply('Could not make out any words in that recording.')
                    return
                }
                await ctx.reply(`🎤 ${text}`)
                await submit(ctx, text)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                log.error(`voice handling failed: ${message}`)
                await ctx.reply(`❌ Voice message failed: ${message}`)
            }
        })
    })

    // Questions and permission requests go to the conversation's chat with
    // buttons; the message is edited once the request is settled, from
    // whichever channel. Keyed by request and question, so a poll of the
    // same task never sends a question twice.
    const sentAsks = new Map<string, { taskId: string; chatId: number; messageId: number; question: string | null }>()
    const settle = async (key: string, note: string) => {
        const sent = sentAsks.get(key)
        if (!sent) return
        sentAsks.delete(key)
        try {
            await bot.api.editMessageReplyMarkup(sent.chatId, sent.messageId)
            await bot.api.sendMessage(sent.chatId, note, { reply_parameters: { message_id: sent.messageId } })
        } catch (error) {
            log.warn(`could not settle ask message ${sent.messageId}: ${error instanceof Error ? error.message : error}`)
        }
    }
    tasks.on('task', (task) => {
        if (task.status !== 'running') {
            for (const [key, sent] of sentAsks) if (sent.taskId === task.id) void settle(key, '— the task ended before an answer')
            return
        }
        const chatId = chatFor(task)
        if (!chatId) return
        if (!task.ask) {
            // Answered from the web (the `answer` event settled it already) or withdrawn by the CLI.
            for (const [key, sent] of sentAsks) if (sent.taskId === task.id) void settle(key, '— withdrawn')
            return
        }
        const message = askMessage(task, task.ask, isTopic(chatId, task.conversation_id))
        if (!message || sentAsks.has(message.key)) return
        const question = task.ask.kind === 'question' ? openQuestions(task.ask)[0]?.question ?? null : null
        sentAsks.set(message.key, { taskId: task.id, chatId, messageId: 0, question })
        bot.api
            .sendMessage(chatId, message.text, { reply_markup: message.keyboard })
            .then((sent) => {
                const entry = sentAsks.get(message.key)
                if (entry) entry.messageId = sent.message_id
                remember(chatId, sent.message_id, task.conversation_id, task.id)
            })
            .catch((error) => {
                sentAsks.delete(message.key)
                log.error(`ask to chat ${chatId} failed`, error)
            })
    })
    tasks.on('event', (event: TaskEvent) => {
        if (event.type !== 'answer') return
        const p = event.payload as { request_id?: string; behavior?: string; answers?: Record<string, string> }
        for (const [key, sent] of sentAsks) {
            if (sent.taskId !== event.task_id) continue
            const answer = sent.question ? p.answers?.[sent.question] : p.behavior === 'allow' ? 'allowed' : 'denied'
            void settle(key, `✅ ${answer ?? 'answered'}`)
        }
    })

    // Deliver results of Telegram-originated tasks back to their chat, and of
    // scheduled runs to the owner (unless the schedule says notify: none).
    tasks.on('task', (task) => {
        if ((task.source !== 'telegram' && task.source !== 'cron') || task.status === 'queued' || task.status === 'running') return
        const chatId = chatFor(task)
        if (!chatId) return
        const body =
            task.status === 'done'
                ? task.result ?? ''
                : task.status === 'cancelled'
                  ? '⏹ Stopped.'
                  : `❌ ${task.error || 'failed'}`
        const head = task.schedule ? `⏱ **${task.schedule}**\n\n` : ''
        // Delivered = seen: the web's "unread" mark goes; a failed delivery keeps it, so the reply is not lost.
        void sendMarkdown(bot, chatId, `${head}${body}\n\n${footer(task, tasks.limits())}`)
            .then((ids) => {
                remember(chatId, ids, task.conversation_id, task.id)
                tasks.markRead(task.conversation_id)
            })
            .catch((error) => log.error(`delivery to chat ${chatId} failed`, error))
    })

    // A prefilter that breaks (credentials expired, a host down) would
    // otherwise fail silently every hour: say so once per distinct error. A
    // minute the factory slept through, and a firing skipped because the
    // previous run still waits, are told the same way (the note names the
    // minute or the task, so each is told once).
    const lastNotice = new Map<string, string>()
    schedules?.on('run', (run) => {
        if (!ownerChat) return
        const stuck = run.status === 'skipped' && (run.note ?? '').startsWith('the previous run is still')
        if (run.status !== 'error' && run.status !== 'missed' && !stuck) {
            if (run.status !== 'skipped') lastNotice.delete(run.schedule)
            return
        }
        if (lastNotice.get(run.schedule) === run.note) return
        lastNotice.set(run.schedule, run.note ?? '')
        const text =
            run.status === 'missed'
                ? `⏭ Schedule **${run.schedule}** ${run.note ?? 'missed a firing'}. /run ${run.schedule} starts it now.`
                : stuck
                  ? `⏸ Schedule **${run.schedule}** skipped a firing: ${run.note}. It waits for your answer or for the task to end.`
                  : `⚠️ Schedule **${run.schedule}** could not run: ${run.note ?? 'unknown error'}`
        void sendMarkdown(bot, ownerChat, text)
            .then((ids) => {
                const conversation = store.findConversation('web', `schedule:${run.schedule}`)
                if (conversation) remember(ownerChat, ids, conversation.id, run.task_id)
            })
            .catch((error) => log.error('schedule notice failed', error))
    })

    bot.catch((err) => {
        log.error('unhandled bot error', err.error)
    })

    return bot
}
