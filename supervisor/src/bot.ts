import { Bot, type Context } from 'grammy'

import { type RunHandle, runClaude } from './claude/runner.js'
import type { Config } from './config.js'
import { createLogger } from './logger.js'
import { markdownToTelegramHtml } from './telegram/format.js'

const log = createLogger('bot')

const TELEGRAM_MAX_LENGTH = 4000

interface ChatState {
    /** Claude Code session the next message continues, if any. */
    sessionId?: string
    /** Currently running task, if any. */
    active?: RunHandle
}

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

async function reply(ctx: Context, text: string): Promise<void> {
    for (const part of chunk(text || '(empty reply)')) {
        try {
            await ctx.reply(markdownToTelegramHtml(part), { parse_mode: 'HTML' })
        } catch (error) {
            // Telegram rejected the markup — better a plain message than none.
            log.warn(`html reply rejected, falling back to plain text: ${error instanceof Error ? error.message : error}`)
            await ctx.reply(part)
        }
    }
}

export function createBot(config: Config): Bot {
    const bot = new Bot(config.telegram.botToken)
    const chats = new Map<number, ChatState>()

    const stateFor = (chatId: number): ChatState => {
        let state = chats.get(chatId)
        if (!state) {
            state = {}
            chats.set(chatId, state)
        }
        return state
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
                'Send a task as text. Replies continue the same Claude Code session.',
                '/new — start a fresh session',
                '/stop — cancel the running task',
                '/status — what is going on'
            ].join('\n')
        )
    })

    bot.command('new', async (ctx) => {
        const state = stateFor(ctx.chat.id)
        state.sessionId = undefined
        await ctx.reply('Fresh session. Next message starts from scratch.')
    })

    bot.command('stop', async (ctx) => {
        const state = stateFor(ctx.chat.id)
        if (!state.active) {
            await ctx.reply('Nothing is running.')
            return
        }
        state.active.kill()
        await ctx.reply('Stopping…')
    })

    bot.command('status', async (ctx) => {
        const state = stateFor(ctx.chat.id)
        await ctx.reply(
            [
                `Running task: ${state.active ? 'yes' : 'no'}`,
                `Session: ${state.sessionId ?? 'none'}`,
                `Workspaces: ${config.paths.workspacesRoot}`,
                `Model: ${config.claude.model ?? 'CLI default'}`
            ].join('\n')
        )
    })

    // Anything else that looks like a command is a typo, not a task for the agent.
    bot.on('message:entities:bot_command', async (ctx) => {
        await ctx.reply(`Unknown command ${ctx.message.text.split(/\s/)[0]}. See /start.`)
    })

    bot.on('message:text', async (ctx) => {
        const state = stateFor(ctx.chat.id)
        if (state.active) {
            await ctx.reply('A task is already running. Send /stop first, or wait for it to finish.')
            return
        }

        const prompt = ctx.message.text
        log.info(`task from ${ctx.from.id}: ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`)

        const handle = runClaude({
            prompt,
            cwd: config.paths.workspacesRoot,
            resumeSessionId: state.sessionId,
            model: config.claude.model,
            maxTurns: config.claude.maxTurns,
            maxBudgetUsd: config.claude.maxBudgetUsd,
            permissionMode: config.claude.permissionMode,
            env: config.claude.configDir ? { CLAUDE_CONFIG_DIR: config.claude.configDir } : undefined
        })
        state.active = handle

        await ctx.reply(state.sessionId ? '▶️ Continuing…' : '▶️ Working…')

        try {
            const result = await handle.result
            state.sessionId = result.sessionId || state.sessionId
            // Cost is the CLI's list-price estimate; on a subscription it is quota, not money.
            const footer = `— ${result.numTurns} turns · ≈$${result.costUsd.toFixed(2)} · ${Math.round(result.durationMs / 1000)}s`
            await reply(ctx, `${result.isError ? '⚠️ ' : ''}${result.text}\n\n${footer}`)
            log.info(`task done: ${footer}`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log.error(`task failed: ${message}`)
            await ctx.reply(`❌ ${message}`)
        } finally {
            state.active = undefined
        }
    })

    bot.catch((err) => {
        log.error('unhandled bot error', err.error)
    })

    return bot
}
