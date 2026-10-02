import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

import type { Env } from './context.js'

/**
 * The client's address. The socket's by default; behind a reverse proxy
 * (`WEB_TRUST_PROXY=1`) the one the proxy wrote: `X-Real-IP`, else the last
 * entry of `X-Forwarded-For` (the one the trusted proxy appended; earlier
 * entries are whatever the client sent). Without the flag those headers are
 * ignored, since anyone can send them and a spoofed address would dodge the
 * per-address lockout.
 */
export function clientIp(c: Context<Env>): string {
    if (c.get('app').config.web.trustProxy) {
        const real = c.req.header('x-real-ip')?.trim()
        if (real) return normalize(real)
        const forwarded = c.req.header('x-forwarded-for')
        if (forwarded) {
            const last = forwarded.split(',').pop()?.trim()
            if (last) return normalize(last)
        }
    }
    try {
        return normalize(getConnInfo(c).remote.address ?? 'unknown')
    } catch {
        return 'unknown'
    }
}

/** The user agent, cut to a sane length for the store. */
export function userAgent(c: Context<Env>): string | null {
    const ua = c.req.header('user-agent')?.trim()
    return ua ? ua.slice(0, 300) : null
}

export function clientOf(c: Context<Env>): { ip: string; userAgent: string | null } {
    return { ip: clientIp(c), userAgent: userAgent(c) }
}

/**
 * Did the request arrive over https? The server itself speaks plain http; a
 * proxy in front says so in `X-Forwarded-Proto`. Honoured whether or not the
 * proxy is trusted: a forged `https` on a plain-http deployment only gives
 * the forger a Secure cookie the browser will not send back, which is their
 * own loss.
 */
export function isSecure(c: Context<Env>): boolean {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    return proto === 'https' || new URL(c.req.url).protocol === 'https:'
}

/** `::ffff:1.2.3.4` is IPv4 on a dual-stack socket. */
function normalize(address: string): string {
    const trimmed = address.replace(/^\[|\]$/g, '')
    return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed
}
