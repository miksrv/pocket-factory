import { type Bot, GrammyError } from 'grammy'
import type { InlineKeyboardButton, InlineKeyboardMarkup, ReplyParameters } from 'grammy/types'

import { createLogger } from '../logger.js'

const log = createLogger('telegram')

/**
 * A message of the bot with its buttons *inside* the text: a rich message
 * (Bot API 10.3, `<tg-button-row>`), so a list of routines carries each
 * routine's buttons under its own line instead of a keyboard under the whole
 * message. The same view also renders as classic Telegram HTML with an
 * inline keyboard, for the retry when Telegram refuses the rich one.
 */

export type ButtonStyle = 'primary' | 'success' | 'danger' | 'link'

export interface Button {
    text: string
    /** Callback data, 1-64 bytes; one of `data`, `url` or `disabled`. */
    data?: string
    url?: string
    style?: ButtonStyle
    /** Shown but inert: the current value, the answer already given. */
    disabled?: boolean
    /** The label in the classic form, where every row sits in one keyboard under the text (a list's row names its item). */
    plain?: string
}

export type Block =
    /** Telegram HTML (`b`, `i`, `code`, `pre`, `a`, `s`, `u`); a blank line separates paragraphs. */
    | { kind: 'text'; html: string }
    | { kind: 'buttons'; buttons: Button[]; align?: 'left' | 'center' | 'right' }
    /** Small type under the text (project, changes, windows). */
    | { kind: 'footer'; lines: string[] }

export type View = Block[]

export const text = (html: string): Block => ({ kind: 'text', html })
export const row = (...buttons: Array<Button | null | undefined | false>): Block => ({
    kind: 'buttons',
    buttons: buttons.filter((b): b is Button => Boolean(b))
})
export const footer = (lines: string[]): Block => ({ kind: 'footer', lines })

export const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Telegram allows 1-8 buttons in a rich row; a longer row is split. */
const ROW_MAX = 8

const rows = (buttons: Button[]): Button[][] => {
    const out: Button[][] = []
    for (let i = 0; i < buttons.length; i += ROW_MAX) out.push(buttons.slice(i, i + ROW_MAX))
    return out
}

function richButton(b: Button): string {
    const label = escapeHtml(b.text)
    if (b.disabled || (!b.data && !b.url))
        return `<tg-button type="disabled"${b.style && b.style !== 'link' ? ` style="${b.style}"` : ''}>${label}</tg-button>`
    if (b.url) {
        const style = b.style && b.style !== 'link' ? ` style="${b.style}"` : ''
        return `<tg-button type="url"${style} url="${escapeHtml(b.url)}">${label}</tg-button>`
    }
    const style = b.style ? ` style="${b.style}"` : ''
    return `<tg-button type="callback_data"${style} data="${escapeHtml(b.data!)}">${label}</tg-button>`
}

/** A text block's paragraphs as rich HTML: a blank line opens a new `<p>`, a line break is `<br>`, a `<pre>` stays as it is. */
function richText(html: string): string {
    const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/)
    return parts
        .map((part, i) => {
            if (i % 2) return part
            return part
                .split(/\n{2,}/)
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
                .join('')
        })
        .join('')
}

/** The view as rich HTML (`sendRichMessage({ html })`). */
export function renderRich(view: View): string {
    return view
        .map((block) => {
            switch (block.kind) {
                case 'text':
                    return richText(block.html)
                case 'buttons':
                    return rows(block.buttons)
                        .map(
                            (r) =>
                                `<tg-button-row${block.align ? ` align="${block.align}"` : ''}>${r.map(richButton).join('')}</tg-button-row>`
                        )
                        .join('')
                case 'footer':
                    return block.lines.length ? `<footer>${block.lines.map(escapeHtml).join('<br>')}</footer>` : ''
            }
        })
        .join('')
}

/** The buttons of a rich *Markdown* message (the agent's reply): the rows as HTML to append to the text. */
export function richButtonRows(buttonRows: Button[][]): string {
    return buttonRows
        .filter((r) => r.length)
        .flatMap(rows)
        .map((r) => `<tg-button-row>${r.map(richButton).join('')}</tg-button-row>`)
        .join('\n')
}

/**
 * The factory's address as Telegram takes it in a button, or null: Telegram refuses a URL whose host
 * has no dot (`https://mikserver`, `http://localhost:8080`) and with it the whole message.
 */
export function buttonBaseUrl(url: string | null): string | null {
    if (!url) return null
    try {
        return new URL(url).hostname.includes('.') ? url : null
    } catch {
        return null
    }
}

function inlineButton(b: Button): InlineKeyboardButton {
    const style = b.style && b.style !== 'link' ? { style: b.style } : {}
    const label = b.plain ?? b.text
    if (b.disabled || (!b.data && !b.url)) return { text: label, disabled: {}, ...style }
    if (b.url) return { text: label, url: b.url, ...style }
    return { text: label, callback_data: b.data!, ...style }
}

/** The buttons of a view (or of button rows) as an inline keyboard under the message; undefined without any. */
export function inlineKeyboard(buttonRows: Button[][]): InlineKeyboardMarkup | undefined {
    const keyboard = buttonRows.filter((r) => r.length).map((r) => r.map(inlineButton))
    return keyboard.length ? { inline_keyboard: keyboard } : undefined
}

/** The view as classic Telegram HTML plus a keyboard: the retry after Telegram rejected the rich message. */
export function renderPlain(view: View): { html: string; markup: InlineKeyboardMarkup | undefined } {
    const lines: string[] = []
    const buttonRows: Button[][] = []
    for (const block of view) {
        if (block.kind === 'text') lines.push(block.html.trim())
        else if (block.kind === 'buttons') buttonRows.push(block.buttons)
        else if (block.lines.length) lines.push(block.lines.map((line) => `— ${escapeHtml(line)}`).join('\n'))
    }
    return { html: lines.filter(Boolean).join('\n\n'), markup: inlineKeyboard(buttonRows) }
}

/** Telegram's "Too Many Requests: retry after N" as the seconds to wait, else null. */
export function retryAfter(error: unknown): number | null {
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

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const replyParameters = (id: number | undefined): ReplyParameters | undefined =>
    id ? { message_id: id, allow_sending_without_reply: true } : undefined

export interface ViewSendOptions {
    /** The owner's message this answers: Telegram shows it quoted above. */
    replyTo?: number
    /** Ask the client for a reply to this message (a question without buttons, free text as the answer). */
    forceReply?: boolean
    /** A message effect, private chats only. */
    effect?: string
}

/**
 * Telegram turned the rich form down (a 400 for markup it cannot parse, a 404 for a method it
 * does not know): the classic form is worth a try. A timeout or a 5xx may have delivered the
 * message, a 429 says wait, a 403 says nobody is there: a second send would only add noise.
 */
export function refused(error: unknown): boolean {
    if (error instanceof GrammyError) return error.error_code === 400 || error.error_code === 404
    return /bad request|not found/i.test(errorText(error))
}

/** Sends the view as a rich message, as HTML with a keyboard when Telegram refuses it; returns the message id. */
export async function sendView(bot: Bot, chatId: number, view: View, options: ViewSendOptions = {}): Promise<number> {
    const common = {
        chat_id: chatId,
        reply_parameters: replyParameters(options.replyTo),
        message_effect_id: options.effect
    }
    try {
        const sent = await withRetry(() =>
            bot.api.raw.sendRichMessage({
                ...common,
                rich_message: { html: renderRich(view) },
                reply_markup: options.forceReply ? { force_reply: true } : undefined
            })
        )
        return sent.message_id
    } catch (error) {
        if (!refused(error)) throw error
        log.warn(`rich message rejected, sending HTML instead: ${errorText(error)}`)
    }
    const plain = renderPlain(view)
    // A message carries one kind of markup: the buttons win, the text already asks for a reply.
    const markup = plain.markup ?? (options.forceReply ? { force_reply: true as const } : undefined)
    const sent = await withRetry(() =>
        bot.api.raw.sendMessage({
            ...common,
            text: plain.html,
            parse_mode: 'HTML',
            reply_markup: markup,
            link_preview_options: { is_disabled: true }
        })
    )
    return sent.message_id
}

/** Replaces a message of the bot with the view (rich, else HTML); a message that already says so is left alone. */
export async function editView(bot: Bot, chatId: number, messageId: number, view: View): Promise<void> {
    const notModified = (error: unknown) => /not modified/i.test(errorText(error))
    try {
        await withRetry(() =>
            bot.api.raw.editMessageText({
                chat_id: chatId,
                message_id: messageId,
                rich_message: { html: renderRich(view) }
            })
        )
        return
    } catch (error) {
        if (notModified(error)) return
        if (!refused(error)) throw error
        log.warn(`rich edit rejected, editing as HTML instead: ${errorText(error)}`)
    }
    const plain = renderPlain(view)
    try {
        await withRetry(() =>
            bot.api.raw.editMessageText({
                chat_id: chatId,
                message_id: messageId,
                text: plain.html,
                parse_mode: 'HTML',
                reply_markup: plain.markup,
                link_preview_options: { is_disabled: true }
            })
        )
    } catch (error) {
        if (!notModified(error)) throw error
    }
}
