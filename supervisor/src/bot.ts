import { Bot, type Context } from 'grammy'

import type { Config } from './config.js'
import { createLogger } from './logger.js'
import type { Task } from './store/index.js'
import type { TaskService } from './tasks/service.js'
import { markdownToTelegramHtml } from './telegram/format.js'

const log = createLogger('bot')

const TELEGRAM_MAX_LENGTH = 4000

/** Split long replies so every chunk fits Telegram's message limit. */
function chunk(text: string): string[] {
    const parts: string[] = []
    let rest = text
    while (rest.length > TELEGRAM_MAX_LENGTH) {
        let cut = rest.lastIndexOf('\n', TELEGRAM_MAX_LENGTH)
        if (cut < TELEGRAM_MAX_LENGTH / 2) cut = TELEGRAM_MAX_LENGTH
        parts.push(rest.slice(0, cut))
        rest = rest.slice(cut).trimStart()
    }
    parts.push(rest)
    return parts
}

async function sendMarkdown(bot: Bot, chatId: number, text: string): Promise<void> {
    for (const part of chunk(text || '(empty reply)')) {
        try {
            await bot.api.sendMessage(chatId, markdownToTelegramHtml(part), { parse_mode: 'HTML' })
        } catch (error) {
            // Telegram rejected the markup — better a plain message than none.
            log.warn(`html reply rejected, falling back to plain text: ${error instanceof Error ? error.message : error}`)
            await bot.api.sendMessage(chatId, part)
        }
    }
}

function footer(task: Task): string {
    return `— ${task.num_turns} turns · ≈$${task.cost_usd.toFixed(2)} · ${Math.round(task.duration_ms / 1000)}s`
}

export function createBot(config: Config, tasks: TaskService): Bot {
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
                '/new — start a fresh session',
                '/stop — cancel the running task',
                '/status — what is going on'
            ].join('\n')
        )
    })

    bot.command('new', async (ctx) => {
        tasks.newConversation('telegram', String(ctx.chat.id))
        await ctx.reply('Fresh session. Next message starts from scratch.')
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
        await ctx.reply(
            [
                `Running task: ${active ? 'yes' : 'no'}`,
                `Session: ${conversation.session_id ?? 'none'}`,
                `Workspaces: ${config.paths.workspacesRoot}`,
                `Model: ${config.claude.model ?? 'CLI default'}`
            ].join('\n')
        )
    })

    // Anything else that looks like a command is a typo, not a task for the agent.
    bot.on('message:entities:bot_command', async (ctx) => {
        await ctx.reply(`Unknown command ${ctx.message.text.split(/\s/)[0]}. See /start.`)
    })

    const submit = async (ctx: Context, prompt: string) => {
        const conversation = conversationFor(ctx)
        const queuedBefore = tasks.activeTask(conversation.id)
        tasks.submit(conversation.id, 'telegram', prompt)
        await ctx.reply(queuedBefore ? '⏳ Queued after the running task…' : conversation.session_id ? '▶️ Continuing…' : '▶️ Working…')
    }

    bot.on('message:text', async (ctx) => {
        await submit(ctx, ctx.message.text)
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
                  : `❌ ${task.error ?? 'failed'}`
        void sendMarkdown(bot, chatId, `${body}\n\n${footer(task)}`).catch((error) =>
            log.error(`delivery to chat ${chatId} failed`, error)
        )
    })

    bot.catch((err) => {
        log.error('unhandled bot error', err.error)
    })

    return bot
}
