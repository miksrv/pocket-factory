import type { Bot } from 'grammy'
import { describe, expect, it, vi } from 'vitest'

import { editView, footer, renderPlain, renderRich, richButtonRows, row, sendView, text, type View } from './view.js'

const view: View = [
    text('<b>Routines</b> · 2, 1 on'),
    text('🟢 <b>daily</b> — writer\n<i>every day</i>\n\nA second paragraph'),
    row(
        { text: '▶️ Run', data: 'r|run|daily', style: 'success' },
        { text: '⏸ Off', data: 'r|off|daily|l' },
        { text: '✓ current', disabled: true },
        { text: '🌐 Web', url: 'https://f.example/routines?a=1&b=2', style: 'primary' }
    ),
    footer(['project: work', 'windows: 5h 12% & week 3%'])
]

describe('renderRich', () => {
    it('puts the buttons inside the message as a tg-button-row where the block sits', () => {
        expect(renderRich(view)).toBe(
            '<p><b>Routines</b> · 2, 1 on</p>' +
                '<p>🟢 <b>daily</b> — writer<br><i>every day</i></p><p>A second paragraph</p>' +
                '<tg-button-row>' +
                '<tg-button type="callback_data" style="success" data="r|run|daily">▶️ Run</tg-button>' +
                '<tg-button type="callback_data" data="r|off|daily|l">⏸ Off</tg-button>' +
                '<tg-button type="disabled">✓ current</tg-button>' +
                '<tg-button type="url" style="primary" url="https://f.example/routines?a=1&amp;b=2">🌐 Web</tg-button>' +
                '</tg-button-row>' +
                '<footer>project: work<br>windows: 5h 12% &amp; week 3%</footer>'
        )
    })

    it('keeps a pre block whole and splits a row of more than eight buttons', () => {
        expect(renderRich([text('run:\n<pre>a\n\nb</pre>')])).toBe('<p>run:</p><pre>a\n\nb</pre>')
        const many = row(...Array.from({ length: 10 }, (_, i) => ({ text: `b${i}`, data: `d${i}` })))
        expect(renderRich([many]).match(/<tg-button-row>/g)).toHaveLength(2)
    })

    it('escapes button labels and attributes, and allows the link style on callback buttons only', () => {
        expect(renderRich([row({ text: 'a <b> & "c"', data: 'x|<y>', style: 'link' })])).toBe(
            '<tg-button-row><tg-button type="callback_data" style="link" data="x|&lt;y&gt;">a &lt;b&gt; &amp; &quot;c&quot;</tg-button></tg-button-row>'
        )
        expect(renderRich([row({ text: 'u', url: 'https://x', style: 'link' })])).toBe(
            '<tg-button-row><tg-button type="url" url="https://x">u</tg-button></tg-button-row>'
        )
    })

    it('renders the rows under a Markdown reply', () => {
        expect(
            richButtonRows([[{ text: 'Open', url: 'https://x/t/1' }], [], [{ text: 'Again', data: 'r|fire|d' }]])
        ).toBe(
            '<tg-button-row><tg-button type="url" url="https://x/t/1">Open</tg-button></tg-button-row>\n' +
                '<tg-button-row><tg-button type="callback_data" data="r|fire|d">Again</tg-button></tg-button-row>'
        )
    })
})

describe('renderPlain', () => {
    it('is classic HTML with every button in a keyboard under it', () => {
        const { html, markup } = renderPlain(view)
        expect(html).toBe(
            '<b>Routines</b> · 2, 1 on\n\n🟢 <b>daily</b> — writer\n<i>every day</i>\n\nA second paragraph\n\n— project: work\n— windows: 5h 12% &amp; week 3%'
        )
        expect(markup).toEqual({
            inline_keyboard: [
                [
                    { text: '▶️ Run', callback_data: 'r|run|daily', style: 'success' },
                    { text: '⏸ Off', callback_data: 'r|off|daily|l' },
                    { text: '✓ current', disabled: {} },
                    { text: '🌐 Web', url: 'https://f.example/routines?a=1&b=2', style: 'primary' }
                ]
            ]
        })
        expect(renderPlain([text('x')]).markup).toBeUndefined()
    })
})

describe('sendView and editView', () => {
    const fakeBot = (rich: 'ok' | 'fail') => {
        const sendRichMessage = vi
            .fn()
            .mockImplementation(() =>
                rich === 'ok'
                    ? Promise.resolve({ message_id: 7 })
                    : Promise.reject(new Error("Bad Request: can't parse"))
            )
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 8 })
        const editMessageText = vi
            .fn()
            .mockImplementation((args: { rich_message?: unknown }) =>
                rich === 'ok' || !args.rich_message ? Promise.resolve(true) : Promise.reject(new Error('Bad Request'))
            )
        const bot = { api: { raw: { sendRichMessage, sendMessage, editMessageText } } } as unknown as Bot
        return { bot, sendRichMessage, sendMessage, editMessageText }
    }

    it('sends the rich message, with a force reply when asked', async () => {
        const { bot, sendRichMessage, sendMessage } = fakeBot('ok')
        expect(await sendView(bot, 42, view, { replyTo: 3, forceReply: true })).toBe(7)
        expect(sendRichMessage).toHaveBeenCalledWith({
            chat_id: 42,
            reply_parameters: { message_id: 3, allow_sending_without_reply: true },
            message_effect_id: undefined,
            rich_message: { html: renderRich(view) },
            reply_markup: { force_reply: true }
        })
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('falls back to HTML with a keyboard when Telegram refuses the rich message', async () => {
        const { bot, sendMessage } = fakeBot('fail')
        expect(await sendView(bot, 42, view, { forceReply: true })).toBe(8)
        expect(sendMessage).toHaveBeenCalledTimes(1)
        const args = sendMessage.mock.calls[0][0] as unknown as {
            text: string
            parse_mode: string
            reply_markup: unknown
        }
        expect(args.parse_mode).toBe('HTML')
        expect(args.text).toContain('<b>Routines</b>')
        const markup = args.reply_markup as { force_reply?: boolean; inline_keyboard?: unknown[] }
        // One kind of markup per message: the buttons, the text already asks for a reply.
        expect(markup.force_reply).toBeUndefined()
        expect(markup.inline_keyboard).toHaveLength(1)
    })

    it('does not fall back on a failure that may have delivered the message', async () => {
        const { bot, sendRichMessage, sendMessage } = fakeBot('ok')
        sendRichMessage.mockRejectedValue(new Error('socket hang up'))
        await expect(sendView(bot, 42, view)).rejects.toThrow('socket hang up')
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('edits in place, rich first and HTML second, and ignores "not modified"', async () => {
        const ok = fakeBot('ok')
        await editView(ok.bot, 42, 7, view)
        expect(ok.editMessageText).toHaveBeenCalledTimes(1)
        expect(ok.editMessageText.mock.calls[0][0]).toMatchObject({ chat_id: 42, message_id: 7 })
        const bad = fakeBot('fail')
        await editView(bad.bot, 42, 7, view)
        expect(bad.editMessageText).toHaveBeenCalledTimes(2)
        expect(bad.editMessageText.mock.calls[1][0]).toMatchObject({ parse_mode: 'HTML' })
        const same = fakeBot('ok')
        same.editMessageText.mockRejectedValue(new Error('Bad Request: message is not modified'))
        await expect(editView(same.bot, 42, 7, view)).resolves.toBeUndefined()
    })
})
