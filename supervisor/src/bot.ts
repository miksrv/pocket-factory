import { Bot, type Context } from 'grammy'

import type { Config } from './config.js'
import { createLogger } from './logger.js'
import type { RateLimitSnapshot, Task } from './store/index.js'
import { transcribe } from './stt/groq.js'
import type { TaskService } from './tasks/service.js'
import { markdownToTelegramHtml } from './telegram/format.js'

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

async function sendOne(bot: Bot, chatId: number, part: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await bot.api.sendMessage(chatId, markdownToTelegramHtml(part), { parse_mode: 'HTML' })
            return
        } catch (error) {
            const wait = retryAfter(error)
            if (wait !== null && attempt < 3) {
                await sleep((wait + 1) * 1000)
                continue
            }
            // Telegram rejected the markup — better a plain message than none.
            log.warn(`html reply rejected, falling back to plain text: ${error instanceof Error ? error.message : error}`)
            await bot.api.sendMessage(chatId, part)
            return
        }
    }
}

/** Every chunk is attempted: one failed chunk is logged, the rest still arrive. */
async function sendMarkdown(bot: Bot, chatId: number, text: string): Promise<void> {
    let failed = 0
    for (const part of chunk(text || '(empty reply)')) {
        try {
            await sendOne(bot, chatId, part)
        } catch (error) {
            failed++
            log.error(`chunk to chat ${chatId} failed: ${error instanceof Error ? error.message : error}`)
        }
    }
    if (failed) throw new Error(`${failed} chunk(s) not delivered`)
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

export function createBot(config: Config, tasks: TaskService): Bot {
    if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set')
    const bot = new Bot(config.telegram.botToken)

    const conversationFor = (ctx: Context) => tasks.conversationFor('telegram', String(ctx.chat!.id))

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
                '/project <name> — bind this chat to a project (its MCP servers, agents and rules apply)',
                '/stop — cancel the running task',
                '/status — what is going on',
                '/usage — subscription limits (5-hour and weekly windows)'
            ].join('\n')
        )
    })

    // `/new` forgets the session; `/new <project>` also starts the next one inside that checkout.
    bot.command('new', async (ctx) => {
        const project = ctx.match.trim() || null
        if (project && !tasks.hasProject(project)) {
            await ctx.reply(`Unknown project "${project}". Projects are the files in /data/config/projects; say "onboard project ${project}" to create one.`)
            return
        }
        tasks.newConversation('telegram', String(ctx.chat.id), null, project)
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
                `Running task: ${active ? 'yes' : 'no'}`,
                `Project: ${conversation.project ?? 'none (workspaces root)'}`,
                `Session: ${conversation.session_id ?? 'none'}`,
                `Workspaces: ${config.paths.workspacesRoot}`,
                `Model: ${config.claude.model ?? 'CLI default'}`,
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

    const submit = async (ctx: Context, prompt: string) => {
        const conversation = conversationFor(ctx)
        const waits = tasks.willWait(conversation.id)
        tasks.submit(conversation.id, 'telegram', prompt)
        await ctx.reply(waits ? '⏳ Queued…' : conversation.session_id ? '▶️ Continuing…' : '▶️ Working…')
    }

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

    // Deliver results of Telegram-originated tasks back to their chat.
    tasks.on('task', (task) => {
        if (task.source !== 'telegram' || task.status === 'queued' || task.status === 'running') return
        const chatId = Number(tasks.conversationOf(task)?.external_id)
        if (!chatId) return
        const body =
            task.status === 'done'
                ? task.result ?? ''
                : task.status === 'cancelled'
                  ? '⏹ Stopped.'
                  : `❌ ${task.error || 'failed'}`
        void sendMarkdown(bot, chatId, `${body}\n\n${footer(task, tasks.limits())}`).catch((error) =>
            log.error(`delivery to chat ${chatId} failed`, error)
        )
    })

    bot.catch((err) => {
        log.error('unhandled bot error', err.error)
    })

    return bot
}
