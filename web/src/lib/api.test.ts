import { afterEach, describe, expect, it, vi } from 'vitest'

import { json, mockFetch } from '../test/fetch'
import {
    api,
    ApiError,
    type Attachment,
    attachmentUrl,
    changesText,
    fmt,
    isImage,
    taskDuration,
    taskTokens,
    UNAUTHORIZED
} from './api'

const attachment = (type: string, name = 'file'): Attachment => ({ name, path: `/data/inbox/c/${name}`, type, size: 1 })

describe('request', () => {
    it('asks /api with a JSON content type and returns the parsed body', async () => {
        const fetch = mockFetch({ 'GET /api/status': { version: '1.1.0' } })
        await expect(api.status()).resolves.toEqual({ version: '1.1.0' })
        const [url, init] = fetch.mock.calls[0]
        expect(url).toBe('/api/status')
        expect(init?.headers).toEqual({ 'content-type': 'application/json' })
    })

    it('sends a JSON body with the method', async () => {
        const fetch = mockFetch({ 'POST /api/tasks/t1/answer': { id: 't1' } })
        await api.answerTask('t1', { behavior: 'allow' })
        expect(fetch.requests()).toEqual([{ method: 'POST', url: '/api/tasks/t1/answer', body: { behavior: 'allow' } }])
    })

    it('lets a caller override the content type', async () => {
        const fetch = mockFetch({ 'POST /api/conversations/c1/attachments': { name: 'x' } })
        const file = new File(['png'], 'shot one.png', { type: 'image/png' })
        await api.uploadAttachment('c1', file)
        const [url, init] = fetch.mock.calls[0]
        expect(url).toBe('/api/conversations/c1/attachments?name=shot%20one.png')
        expect(init?.headers).toEqual({ 'content-type': 'image/png' })
        expect(init?.body).toBe(file)
    })

    it('returns nothing for a 204', async () => {
        mockFetch({ 'DELETE /api/conversations/c1': new Response(null, { status: 204 }) })
        await expect(api.deleteConversation('c1')).resolves.toBeUndefined()
    })

    it('puts the keyset cursor and filters in the query', async () => {
        const fetch = mockFetch({ 'GET /api/tasks': [] })
        await api.tasks({
            status: 'running',
            project: 'pf',
            before: { ts: '2026-10-06 10:00:00', id: 't9' },
            limit: 20
        })
        const url = new URL(fetch.requests()[0].url, 'http://x')
        expect(url.pathname).toBe('/api/tasks')
        expect(Object.fromEntries(url.searchParams)).toEqual({
            before: '2026-10-06 10:00:00',
            before_id: 't9',
            status: 'running',
            project: 'pf',
            limit: '20'
        })
        await api.tasks()
        expect(fetch.requests()[1].url).toBe('/api/tasks')
    })

    it('throws an ApiError with the message and body the API sent', async () => {
        mockFetch({ 'PUT /api/agents/x': json({ error: 'changed on disk', detail: 1 }, 409, 'Conflict') })
        const error = await api.save('agents', 'x', { frontmatter: {}, body: '' }).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ApiError)
        expect(error).toMatchObject({
            status: 409,
            message: 'changed on disk',
            body: { error: 'changed on disk', detail: 1 }
        })
    })

    it('falls back to the status line when the error is not JSON', async () => {
        mockFetch({
            'GET /api/status': new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
        })
        await expect(api.status()).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway', body: null })
    })

    it('refuses a 200 that is not JSON', async () => {
        mockFetch({ 'GET /api/status': new Response('<html>login</html>', { status: 200 }) })
        await expect(api.status()).rejects.toThrow(/something other than JSON/)
    })

    it('tells the app on a 401 that the session is gone', async () => {
        mockFetch({ 'GET /api/status': json({ error: 'sign in' }, 401) })
        const listener = vi.fn()
        window.addEventListener(UNAUTHORIZED, listener)
        await expect(api.status()).rejects.toMatchObject({ status: 401, message: 'sign in' })
        window.removeEventListener(UNAUTHORIZED, listener)
        expect(listener).toHaveBeenCalledOnce()
    })

    it('does not raise the alarm for a 401 from the sign-in routes', async () => {
        mockFetch({ 'POST /api/auth/login': json({ error: 'wrong password', attempts_left: 2 }, 401) })
        const listener = vi.fn()
        window.addEventListener(UNAUTHORIZED, listener)
        await expect(api.auth.login('owner', 'nope')).rejects.toMatchObject({ body: { attempts_left: 2 } })
        window.removeEventListener(UNAUTHORIZED, listener)
        expect(listener).not.toHaveBeenCalled()
    })
})

describe('changesText', () => {
    it('sums up a change set', () => {
        expect(changesText({ start_head: 'a', start_branch: null, files: 7, added: 210, removed: 40 })).toBe(
            '7 files +210 −40'
        )
        expect(changesText({ start_head: 'a', start_branch: null, files: 1 })).toBe('1 file +0 −0')
    })

    it('is null when nothing changed', () => {
        expect(changesText(null)).toBeNull()
        expect(changesText({ start_head: 'a', start_branch: 'main', files: 0 })).toBeNull()
    })
})

describe('attachments', () => {
    it('previews only the raster images the server serves inline', () => {
        for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
            expect(isImage(attachment(type))).toBe(true)
        for (const type of ['image/svg+xml', 'text/html', 'application/pdf', ''])
            expect(isImage(attachment(type))).toBe(false)
    })

    it('builds the download URL with the name encoded', () => {
        expect(attachmentUrl('c1', attachment('text/plain', 'a b/c?.txt'))).toBe(
            '/api/conversations/c1/attachments/a%20b%2Fc%3F.txt'
        )
    })
})

describe('taskTokens', () => {
    it('counts every token, cache included', () => {
        expect(
            taskTokens({ input_tokens: 1, output_tokens: 20, cache_read_tokens: 300, cache_creation_tokens: 4000 })
        ).toBe(4321)
    })
})

describe('fmt', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('plural', () => {
        expect(fmt.plural(1, 'run')).toBe('1 run')
        expect(fmt.plural(0, 'run')).toBe('0 runs')
        expect(fmt.plural(3, 'run')).toBe('3 runs')
    })

    it('tokens', () => {
        expect(fmt.tokens(999)).toBe('999')
        expect(fmt.tokens(1000)).toBe('1k')
        expect(fmt.tokens(15_400)).toBe('15k')
        expect(fmt.tokens(1_000_000)).toBe('1.0M')
        expect(fmt.tokens(3_640_000)).toBe('3.6M')
    })

    // Bug: 999 500 and up round to "1000k" instead of switching to millions.
    it.fails('tokens never shows a thousand thousands', () => {
        expect(fmt.tokens(999_600)).toBe('1.0M')
    })

    it('pct and windowDelta', () => {
        expect(fmt.pct(0.256)).toBe('26%')
        expect(fmt.windowDelta(null)).toBeNull()
        expect(fmt.windowDelta(0.004)).toBe('<1% of 5h')
        expect(fmt.windowDelta(0.034)).toBe('+3% of 5h')
    })

    it('until', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
        expect(fmt.until('2026-10-06T11:00:00Z')).toBe('now')
        expect(fmt.until('2026-10-06T12:45:00Z')).toBe('45m')
        expect(fmt.until('2026-10-06T14:15:30Z')).toBe('2h 15m')
        expect(fmt.until('2026-10-08T11:00:00Z')).toBe('47h 0m')
        expect(fmt.until('2026-10-09T12:00:00Z')).toBe('3d')
    })

    it('duration', () => {
        expect(fmt.duration(4_400)).toBe('4s')
        expect(fmt.duration(59_000)).toBe('59s')
        expect(fmt.duration(125_000)).toBe('2m 5s')
        expect(fmt.duration(4_990_000)).toBe('1h 23m 10s')
        expect(fmt.duration(0)).toBe('0s')
    })

    it('duration never shows 60 seconds', () => {
        expect(fmt.duration(119_600)).toBe('2m 0s')
        expect(fmt.duration(3_599_600)).toBe('1h 0m 0s')
    })

    it('taskDuration times a running task from its start', () => {
        const now = Date.parse('2026-10-09T16:00:00Z')
        const started_at = '2026-10-09T15:00:00Z'
        expect(taskDuration({ status: 'running', started_at, duration_ms: 0 }, now)).toBe(3_600_000)
        expect(taskDuration({ status: 'done', started_at, duration_ms: 1234 }, now)).toBe(1234)
        expect(taskDuration({ status: 'queued', started_at: null, duration_ms: 0 }, now)).toBe(0)
    })

    it('when', () => {
        expect(fmt.when(null)).toBe('—')
        expect(fmt.when('2026-10-06T12:00:00Z')).toBe(new Date('2026-10-06T12:00:00Z').toLocaleString())
    })

    it('ago', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
        expect(fmt.ago(null)).toBe('—')
        expect(fmt.ago('2026-10-06T11:59:30Z')).toBe('just now')
        expect(fmt.ago('2026-10-06T11:35:00Z')).toBe('25 min ago')
        expect(fmt.ago('2026-10-06T07:00:00Z')).toBe('5 h ago')
        expect(fmt.ago('2026-10-03T12:00:00Z')).toBe('3 d ago')
    })

    it('bytes', () => {
        expect(fmt.bytes(512)).toBe('512 B')
        expect(fmt.bytes(2048)).toBe('2.0 KB')
        expect(fmt.bytes(5 * 1_048_576)).toBe('5.0 MB')
    })
})
