import { Hono } from 'hono'

import type { AuditQuery } from '../../store/index.js'
import type { Env } from '../context.js'

const PERIODS: Record<string, number> = {
    '1h': 3_600_000,
    '24h': 86_400_000,
    '7d': 7 * 86_400_000,
    '30d': 30 * 86_400_000
}
const KINDS = new Set<NonNullable<AuditQuery['kind']>>(['all', 'llm', 'tools', 'files', 'agents', 'sessions', 'limits'])

/**
 * Audit log: every model call, tool call, sub-agent, task lifecycle and
 * rate-limit reading, attributed to the agent that produced it and the
 * project it worked in. Built from the events the runner streams; nothing
 * is parsed from transcripts after the fact.
 */
export function auditRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', (c) => {
        const { store } = c.get('app')
        const period = c.req.query('period') ?? '24h'
        const since = PERIODS[period] ? new Date(Date.now() - PERIODS[period]).toISOString() : undefined
        const kind = c.req.query('kind') as AuditQuery['kind'] | undefined
        const query: AuditQuery = {
            since,
            kind: kind && KINDS.has(kind) ? kind : 'all',
            agent: c.req.query('agent') || undefined,
            project: c.req.query('project') || undefined,
            before: Number(c.req.query('before')) || undefined,
            limit: Math.min(Number(c.req.query('limit')) || 200, 1000)
        }
        // One row past the page says whether there is another page; the count
        // alone cannot, since events keep arriving while the client scrolls.
        const page = store.listAudit({ ...query, limit: query.limit! + 1 })
        return c.json({
            events: page.slice(0, query.limit),
            has_more: page.length > query.limit!,
            stats: store.auditStats({ since, kind: query.kind, agent: query.agent, project: query.project }),
            facets: store.auditFacets(since)
        })
    })

    return app
}
