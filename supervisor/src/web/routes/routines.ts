import { Hono } from 'hono'

import { describeCron, isTimeZone, nextRun, parseCron } from '../../routines/cron.js'
import { PrefilterError } from '../../routines/prefilters.js'
import type { Env } from '../context.js'

/**
 * What the scheduler knows beyond the file: status, runs, run now, preview,
 * seen items. The file itself (frontmatter + body) is read and written
 * through the generic /routines/:name of the file routes, mounted after
 * these so /status and /:name/… win.
 */
export function routineRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/status', (c) => c.json(c.get('app').routines.list()))

    /** Read a cron expression back: valid or not, in words, and when it fires next in the factory's zone (or `tz`). */
    app.get('/cron', (c) => {
        const expr = (c.req.query('expr') ?? '').trim()
        const tz = (c.req.query('tz') ?? '').trim() || c.get('app').config.timezone
        if (!isTimeZone(tz)) return c.json({ ok: false, error: `unknown time zone "${tz}"`, tz }, 200)
        if (!expr) return c.json({ ok: false, error: 'empty', tz }, 200)
        try {
            const cron = parseCron(expr)
            return c.json({
                ok: true,
                text: describeCron(cron),
                next: nextRun(cron, {}, tz)?.toISOString() ?? null,
                tz
            })
        } catch (error) {
            return c.json({ ok: false, error: (error as Error).message, tz }, 200)
        }
    })

    app.get('/:name/status', (c) => {
        const view = c.get('app').routines.get(c.req.param('name'))
        return view ? c.json(view) : c.json({ error: 'routine not found' }, 404)
    })

    /** The firings that mattered (a task, an error, a missed minute); `all=1` adds the empty polls and the skips. */
    app.get('/:name/runs', (c) => {
        const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 30))
        return c.json(c.get('app').routines.runs(c.req.param('name'), limit, c.req.query('all') === '1'))
    })

    /** Fire now: ignores the cron, the window and the soft-stop; never overlaps a run in progress. */
    app.post('/:name/run', async (c) => {
        const { routines } = c.get('app')
        const name = c.req.param('name')
        if (!routines.get(name)) return c.json({ error: 'routine not found' }, 404)
        return c.json(await routines.fire(name, 'manual'))
    })

    /** Run the prefilter and show what it finds, marking nothing. */
    app.post('/:name/preview', async (c) => {
        const { routines } = c.get('app')
        const name = c.req.param('name')
        if (!routines.get(name)) return c.json({ error: 'routine not found' }, 404)
        try {
            return c.json(await routines.preview(name))
        } catch (error) {
            if (error instanceof PrefilterError) return c.json({ error: error.message }, 422)
            throw error
        }
    })

    /** Switch a routine on or off without touching the rest of its file. */
    app.put('/:name/enabled', async (c) => {
        const { routines } = c.get('app')
        const name = c.req.param('name')
        const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown }
        if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400)
        if (!routines.get(name)) return c.json({ error: 'routine not found' }, 404)
        try {
            return c.json(routines.setEnabled(name, body.enabled))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
        }
    })

    /** Forget the seen items: the next run treats everything the prefilter finds as new. */
    app.delete('/:name/seen', (c) => {
        const { routines } = c.get('app')
        const name = c.req.param('name')
        if (!routines.get(name)) return c.json({ error: 'routine not found' }, 404)
        return c.json({ forgotten: routines.forgetSeen(name) })
    })

    /** Delete the file and the store's memory of it (runs, seen items). Overrides the generic file delete. */
    app.delete('/:name', (c) => {
        const { catalog, routines } = c.get('app')
        const name = c.req.param('name')
        catalog.remove('routines', name)
        routines.forget(name)
        return c.body(null, 204)
    })

    return app
}
