import { vi } from 'vitest'

/** A JSON response the way the API sends one. */
export const json = (body: unknown, status = 200, statusText = '') =>
    new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } })

/** A handler gets the request and returns a Response or a value to send as JSON with 200, or a promise of either. */
export type Handler = (request: { method: string; url: string; body: unknown }) => unknown

/**
 * Stub `fetch` with a table of routes keyed `METHOD /path` (the path without
 * the query string). An unknown route answers 404 so a missing stub shows
 * up as an error on screen instead of a hang. Returns the spy; `requests()`
 * lists what was asked, bodies parsed as JSON where they are JSON.
 */
export function mockFetch(routes: Record<string, unknown>) {
    const log: Array<{ method: string; url: string; body: unknown }> = []
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const method = (init?.method ?? 'GET').toUpperCase()
        let body: unknown = init?.body
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body)
            } catch {
                // a plain string body
            }
        }
        const request = { method, url, body }
        log.push(request)
        await Promise.resolve()
        const key = `${method} ${url.split('?')[0]}`
        if (!(key in routes)) return json({ error: `no stub for ${key}` }, 404, 'Not Found')
        const route = routes[key]
        const result: unknown = await (typeof route === 'function' ? (route as Handler)(request) : route)
        return result instanceof Response ? result : json(result)
    })
    vi.stubGlobal('fetch', spy)
    return Object.assign(spy, { requests: () => log })
}
