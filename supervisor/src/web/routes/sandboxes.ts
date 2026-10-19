import { Hono } from 'hono'

import type { Env } from '../context.js'

/**
 * Settings → Sandboxes and the project page's sandbox card: the daemon, the logins, the
 * factory's `pf-*` sandboxes with Stop and Reset, the requests their network policy held back,
 * and the previews.
 */
export function sandboxRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    const overview = (c: { get: (key: 'app') => Env['Variables']['app'] }) => {
        const { sandboxes, previews } = c.get('app')
        return { ...sandboxes.status(), previews: previews.list() }
    }

    app.get('/', (c) => c.json(overview(c)))

    app.post('/refresh', async (c) => {
        const { sandboxes } = c.get('app')
        await Promise.all([sandboxes.refresh(), sandboxes.pollApprovals(true)])
        return c.json(overview(c))
    })

    /** One project's sandbox, preview and pending requests (the project page). */
    app.get('/projects/:slug', (c) => {
        const { sandboxes, previews, tasks } = c.get('app')
        const slug = c.req.param('slug')
        if (!tasks.projects().includes(slug)) return c.json({ error: `no project ${slug}` }, 404)
        const status = sandboxes.status()
        const name = sandboxes.nameFor(slug)
        return c.json({
            mode: status.mode,
            name,
            sandbox: status.sandboxes.find((s) => s.name === name) ?? null,
            preview: previews.get(slug),
            approvals: status.approvals.filter((a) => a.sandbox === name)
        })
    })

    app.post('/:name/stop', async (c) => {
        await c.get('app').sandboxes.stopSandbox(c.req.param('name'))
        return c.json(overview(c))
    })

    /** Remove one of the factory's sandboxes by name (a deleted project's too); the next task makes a fresh one. */
    app.post('/:name/reset', async (c) => {
        const { sandboxes, previews } = c.get('app')
        const name = c.req.param('name')
        if (!name.startsWith('pf-')) return c.json({ error: `${name} is not one of the factory's sandboxes` }, 400)
        if (sandboxes.activeRuns(name)) return c.json({ error: `${name} is running a task; stop the task first` }, 409)
        const project = sandboxes.projectOf(name)
        // The published port goes with the sandbox; addresses handed out before stop working.
        for (const preview of previews.list().filter((p) => p.sandbox === name))
            await previews.close(preview.project, 'its sandbox was reset')
        await sandboxes.reset(name)
        if (project) previews.rotate(project)
        return c.json(overview(c))
    })

    app.post('/approvals/:id', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { allow?: unknown }
        if (typeof body.allow !== 'boolean') return c.json({ error: '`allow` must be true or false' }, 400)
        try {
            await c.get('app').sandboxes.decide(c.req.param('id'), body.allow)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
        }
        return c.json(overview(c))
    })

    app.delete('/previews/:project', async (c) => {
        const closed = await c.get('app').previews.close(c.req.param('project'), 'stopped by the owner')
        return c.json({ closed })
    })

    return app
}
