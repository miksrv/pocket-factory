import type { Bot } from 'grammy'
import { describe, expect, it, vi } from 'vitest'

import { DeliveryError, sendMarkdown, sendReply, TELEGRAM_MAX_LENGTH } from './send.js'

const fakeBot = (opts: { rich?: 'ok' | 'fail' } = {}) => {
    let plain = 0
    const sendMessage = vi.fn().mockImplementation(() => Promise.resolve({ message_id: 100 + ++plain }))
    const sendRichMessage = vi
        .fn()
        .mockImplementation(() =>
            opts.rich === 'fail'
                ? Promise.reject(new Error("Bad Request: can't parse"))
                : Promise.resolve({ message_id: 7 })
        )
    const bot = { api: { sendMessage, sendRichMessage } } as unknown as Bot
    return { bot, sendMessage }
}

describe('sendMarkdown', () => {
    it('leaves room for the footer in every part', async () => {
        const { bot, sendMessage } = fakeBot()
        const text = Array.from({ length: 200 }, (_, i) => `line ${i} `.padEnd(40, '.')).join('\n')
        const footer = ['📁 shop', '🌿 feature/x · 3 files', '🔗 PR #12', '⏱ 5h 40% · 7d 12%', '👁 review']
        await sendMarkdown(bot, 1, text, { footer })
        const sent = sendMessage.mock.calls.map((call) => call[1] as string)
        expect(sent.length).toBeGreaterThan(1)
        for (const part of sent) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH)
        expect(sent.at(-1)).toContain('— 👁 review')
    })
})

describe('sendReply', () => {
    it('reports a reply that could not go as a DeliveryError with the messages that did arrive', async () => {
        const { bot, sendMessage } = fakeBot({ rich: 'fail' })
        sendMessage.mockRejectedValue(new Error('Bad Request: chat not found'))
        const error = await sendReply(bot, 1, 'short reply').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(DeliveryError)
        expect((error as DeliveryError).ids).toEqual([])
    })

    it('sends a rich reply once when Telegram takes it', async () => {
        const { bot, sendMessage } = fakeBot()
        expect(await sendReply(bot, 1, 'short reply')).toEqual([7])
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('does not send a second form after a timeout: the first may have arrived', async () => {
        const { bot, sendMessage } = fakeBot()
        ;(bot.api.sendRichMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network request timed out'))
        const error = await sendReply(bot, 1, 'short reply').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(DeliveryError)
        expect(sendMessage).not.toHaveBeenCalled()
    })
})

describe('sendMarkdown fallback', () => {
    it('sends plain text only when Telegram refuses the markup', async () => {
        const { bot, sendMessage } = fakeBot()
        sendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        expect(await sendMarkdown(bot, 1, 'a *b*')).toHaveLength(1)
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[1][2]).not.toHaveProperty('parse_mode')

        sendMessage.mockClear()
        sendMessage.mockRejectedValueOnce(new Error('Internal Server Error'))
        await expect(sendMarkdown(bot, 1, 'a *b*')).rejects.toThrow('1 chunk(s) not delivered')
        expect(sendMessage).toHaveBeenCalledTimes(1)
    })
})
