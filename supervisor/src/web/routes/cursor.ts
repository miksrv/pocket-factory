import type { Context } from 'hono'

import type { Cursor } from '../../store/index.js'

/** The keyset cursor of a list request: `before` (a timestamp) plus `before_id`. */
export function cursorOf(c: Pick<Context, 'req'>): Cursor | undefined {
    const ts = c.req.query('before')
    if (!ts) return undefined
    return { ts, id: c.req.query('before_id') || undefined }
}
