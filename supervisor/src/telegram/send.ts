import type { Bot, InlineKeyboard } from 'grammy'
import type { ReplyParameters } from 'grammy/types'

import { createLogger } from '../logger.js'
import { markdownToTelegramHtml } from './format.js'
import { RICH_MAX_LENGTH, richMarkdown } from './rich.js'

const log = createLogger('telegram')

export const TELEGRAM_MAX_LENGTH = 4000

/** Message effects (private chats only): the ids are Telegram's own. */
export const EFFECT = { party: '5046509860389126442', thumbsUp: '5107584321108051014' } as const

/**
 * Split long replies so every chunk fits Telegram's message limit. Cuts fall
 * on line breaks, and a fenced code block that straddles a cut is closed at
 * the end of one chunk and reopened at the start of the next, so the fence
 * markers stay balanced in every message.
 */
export function chunk(text: string, limit = TELEGRAM_MAX_LENGTH): string[] {
    const parts: string[] = []
    let rest = text
    let openFence: string | null = null
    while (rest.length > limit) {
        const budget = limit - (openFence === null ? 0 : 4)
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

/** Runs one API call, waiting out Telegram's flood limit up to three times. */
export async function withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await call()
        } catch (error) {
            const wait = retryAfter(error)
            if (wait === null || attempt >= 3) throw error
            await sleep((wait + 1) * 1000)
        }
    }
}

export interface SendOptions {
    /** Lines under the reply (project, changes, windows): a footer block in a rich message, dashed lines in HTML. */
    footer?: string[]
    /** The owner's message this answers: Telegram shows it quoted above the reply. */
    replyTo?: number
    /** Buttons under the last message. */
    markup?: InlineKeyboard
    /** A message effect (`EFFECT`), private chats only. */
    effect?: string
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The footer lines as a rich message's footer block (small type under the text). */
export const richFooter = (lines: string[]): string => `<footer>${lines.map(escapeHtml).join('<br>')}</footer>`

const replyParameters = (id: number | undefined): ReplyParameters | undefined =>
    id ? { message_id: id, allow_sending_without_reply: true } : undefined

/** Sends one HTML message, plain text when Telegram rejects the markup; returns its id. */
async function sendOne(bot: Bot, chatId: number, part: string, options: SendOptions): Promise<number> {
    const other = {
        reply_parameters: replyParameters(options.replyTo),
        reply_markup: options.markup,
        message_effect_id: options.effect,
        link_preview_options: { is_disabled: true }
    }
    try {
        const sent = await withRetry(() =>
            bot.api.sendMessage(chatId, markdownToTelegramHtml(part), { ...other, parse_mode: 'HTML' })
        )
        return sent.message_id
    } catch (error) {
        if (retryAfter(error) !== null) throw error
        // Telegram rejected the markup — better a plain message than none.
        log.warn(
            `html reply rejected, falling back to plain text: ${error instanceof Error ? error.message : String(error)}`
        )
        const sent = await bot.api.sendMessage(chatId, part, other)
        return sent.message_id
    }
}

/**
 * Markdown as Telegram HTML, in as many messages as it takes. Every chunk is
 * attempted: one failed chunk is logged, the rest still arrive. Returns the
 * ids of the messages sent.
 */
export async function sendMarkdown(
    bot: Bot,
    chatId: number,
    text: string,
    options: SendOptions = {}
): Promise<number[]> {
    let failed = 0
    const ids: number[] = []
    const parts = chunk(text || '(empty reply)')
    if (options.footer?.length) parts[parts.length - 1] += `\n\n${options.footer.map((line) => `— ${line}`).join('\n')}`
    for (const [i, part] of parts.entries()) {
        try {
            ids.push(
                await sendOne(bot, chatId, part, {
                    replyTo: i === 0 ? options.replyTo : undefined,
                    markup: i === parts.length - 1 ? options.markup : undefined,
                    effect: i === 0 ? options.effect : undefined
                })
            )
        } catch (error) {
            failed++
            log.error(`chunk to chat ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    if (failed) throw new Error(`${failed} chunk(s) not delivered`)
    return ids
}

/**
 * An agent's reply: a rich message, which Telegram renders from the Markdown
 * itself (headings, tables, lists, code with a language, quotes), 30k
 * characters at a time. A rich message Telegram refuses (a construct its
 * parser dislikes) goes as the HTML chunks instead, so the reply always
 * arrives. Returns the ids of the messages sent.
 */
export async function sendReply(
    bot: Bot,
    chatId: number,
    markdown: string,
    options: SendOptions = {}
): Promise<number[]> {
    const parts = chunk(markdown || '(empty reply)', RICH_MAX_LENGTH)
    const ids: number[] = []
    for (const [i, part] of parts.entries()) {
        const last = i === parts.length - 1
        const footer = last && options.footer?.length ? options.footer : undefined
        try {
            const sent = await withRetry(() =>
                bot.api.sendRichMessage(
                    chatId,
                    { markdown: richMarkdown(part) + (footer ? `\n\n${richFooter(footer)}` : '') },
                    {
                        reply_parameters: replyParameters(i === 0 ? options.replyTo : undefined),
                        reply_markup: last ? options.markup : undefined,
                        message_effect_id: i === 0 ? options.effect : undefined
                    }
                )
            )
            ids.push(sent.message_id)
        } catch (error) {
            log.warn(
                `rich message rejected, sending HTML instead: ${error instanceof Error ? error.message : String(error)}`
            )
            ids.push(
                ...(await sendMarkdown(bot, chatId, part, {
                    footer,
                    replyTo: i === 0 ? options.replyTo : undefined,
                    markup: last ? options.markup : undefined
                }))
            )
        }
    }
    return ids
}
