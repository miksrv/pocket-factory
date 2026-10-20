import type { Bot } from 'grammy'

import { createLogger } from '../logger.js'
import { markdownToTelegramHtml } from './format.js'
import { RICH_MAX_LENGTH, richMarkdown } from './rich.js'
import {
    type Button,
    errorText,
    escapeHtml,
    inlineKeyboard,
    refused,
    replyParameters,
    richButtonRows,
    withRetry
} from './view.js'

export { retryAfter, withRetry } from './view.js'

const log = createLogger('telegram')

export const TELEGRAM_MAX_LENGTH = 4000

/** Message effects (private chats only): the ids are Telegram's own. */
export const EFFECT = { party: '5046509860389126442', thumbsUp: '5107584321108051014' } as const

const FENCE_CLOSE = '\n```'

/**
 * Split long replies so every chunk fits Telegram's message limit. Cuts fall
 * on line breaks, and a fenced code block that straddles a cut is closed at
 * the end of one chunk and reopened at the start of the next, so the fence
 * markers stay balanced in every message. Every cut leaves room for that
 * closing fence, and never splits a surrogate pair (an emoji).
 */
export function chunk(text: string, limit = TELEGRAM_MAX_LENGTH): string[] {
    const parts: string[] = []
    let rest = text
    while (rest.length > limit) {
        const budget = limit - FENCE_CLOSE.length
        let cut = rest.lastIndexOf('\n', budget)
        if (cut < budget / 2) cut = budget
        const code = rest.charCodeAt(cut - 1)
        if (code >= 0xd800 && code <= 0xdbff) cut--
        let head = rest.slice(0, cut)
        rest = rest.slice(cut).trimStart()
        // Which fence is open at the end of this chunk? The head already
        // starts with the re-opened fence when one carried over, so the
        // scan starts from a clean state.
        let openFence: string | null = null
        for (const line of head.split('\n')) {
            const fence = line.match(/^\s*```(\S*)/)
            if (fence) openFence = openFence === null ? fence[1] : null
        }
        if (openFence !== null) {
            head += FENCE_CLOSE
            rest = `\`\`\`${openFence}\n${rest}`
        }
        parts.push(head)
    }
    parts.push(rest)
    return parts
}

export interface SendOptions {
    /** Lines under the reply (project, changes, windows): a footer block in a rich message, dashed lines in HTML. */
    footer?: string[]
    /** The owner's message this answers: Telegram shows it quoted above the reply. */
    replyTo?: number
    /** Buttons under the last message: inside a rich message, a keyboard under an HTML one. */
    buttons?: Button[][]
    /** A message effect (`EFFECT`), private chats only. */
    effect?: string
}

/** The footer lines as a rich message's footer block (small type under the text). */
export const richFooter = (lines: string[]): string => `<footer>${lines.map(escapeHtml).join('<br>')}</footer>`

/** Sends one HTML message, plain text when Telegram rejects the markup; returns its id. */
async function sendOne(bot: Bot, chatId: number, part: string, options: SendOptions): Promise<number> {
    const other = {
        reply_parameters: replyParameters(options.replyTo),
        reply_markup: options.buttons ? inlineKeyboard(options.buttons) : undefined,
        message_effect_id: options.effect,
        link_preview_options: { is_disabled: true }
    }
    try {
        const sent = await withRetry(() =>
            bot.api.sendMessage(chatId, markdownToTelegramHtml(part), { ...other, parse_mode: 'HTML' })
        )
        return sent.message_id
    } catch (error) {
        // Only a refusal of the markup: after a timeout or a 5xx the message may have arrived, a 429 says wait.
        if (!refused(error)) throw error
        // Telegram rejected the markup — better a plain message than none.
        log.warn(`html reply rejected, falling back to plain text: ${errorText(error)}`)
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
    // The footer goes under the last part, so every part leaves room for it.
    const footer = options.footer?.length ? `\n\n${options.footer.map((line) => `— ${line}`).join('\n')}` : ''
    const parts = chunk(text || '(empty reply)', TELEGRAM_MAX_LENGTH - footer.length)
    parts[parts.length - 1] += footer
    for (const [i, part] of parts.entries()) {
        try {
            ids.push(
                await sendOne(bot, chatId, part, {
                    replyTo: i === 0 ? options.replyTo : undefined,
                    buttons: i === parts.length - 1 ? options.buttons : undefined,
                    effect: i === 0 ? options.effect : undefined
                })
            )
        } catch (error) {
            failed++
            log.error(`chunk to chat ${chatId} failed: ${errorText(error)}`)
        }
    }
    if (failed) throw new Error(`${failed} chunk(s) not delivered`)
    return ids
}

/**
 * An agent's reply: a rich message, which Telegram renders from the Markdown
 * itself (headings, tables, lists, code with a language, quotes), 30k
 * characters at a time, with the footer in small type and the buttons inside
 * the message. A rich message Telegram refuses (a construct its parser
 * dislikes) goes as the HTML chunks with a keyboard instead, so the reply
 * always arrives. Returns the ids of the messages sent.
 */
export async function sendReply(
    bot: Bot,
    chatId: number,
    markdown: string,
    options: SendOptions = {}
): Promise<number[]> {
    const parts = chunk(markdown || '(empty reply)', RICH_MAX_LENGTH)
    const ids: number[] = []
    let failed = 0
    for (const [i, part] of parts.entries()) {
        const last = i === parts.length - 1
        const footer = last && options.footer?.length ? options.footer : undefined
        const buttons = last && options.buttons?.length ? richButtonRows(options.buttons) : ''
        try {
            const sent = await withRetry(() =>
                bot.api.sendRichMessage(
                    chatId,
                    {
                        markdown: [richMarkdown(part), footer ? richFooter(footer) : '', buttons]
                            .filter(Boolean)
                            .join('\n\n')
                    },
                    {
                        reply_parameters: replyParameters(i === 0 ? options.replyTo : undefined),
                        message_effect_id: i === 0 ? options.effect : undefined
                    }
                )
            )
            ids.push(sent.message_id)
        } catch (error) {
            // A timeout or a 5xx may have delivered it, a 429 says wait: a second form would only duplicate it.
            if (!refused(error)) throw new DeliveryError(errorText(error), ids)
            log.warn(`rich message rejected, sending HTML instead: ${errorText(error)}`)
            try {
                ids.push(
                    ...(await sendMarkdown(bot, chatId, part, {
                        footer,
                        replyTo: i === 0 ? options.replyTo : undefined,
                        buttons: last ? options.buttons : undefined
                    }))
                )
            } catch (fallback) {
                // The rest still goes; what arrived is remembered by the caller, so a reply to it continues the chat.
                failed++
                log.error(`part ${i + 1} to chat ${chatId} failed: ${errorText(fallback)}`)
            }
        }
    }
    if (failed) throw new DeliveryError(`${failed} part(s) not delivered`, ids)
    return ids
}

/** A reply that arrived only in part: `ids` are the messages that did. */
export class DeliveryError extends Error {
    constructor(
        message: string,
        readonly ids: number[]
    ) {
        super(message)
    }
}
