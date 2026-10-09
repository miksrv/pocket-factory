import { Hono } from 'hono'

import type { Env } from '../context.js'

/**
 * Toolchains: what the agents build and test with. mise-installed runtimes,
 * the image's PHP, the dind sidecar's containers; Settings → Toolchains
 * lists them, the project form asks for a checkout's needs.
 */
export function toolchainRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', async (c) => c.json(await c.get('app').toolchains.overview()))

    /** A project's needs (from its checkout) and what the factory has for each. */
    app.get('/projects/:slug', async (c) => {
        const { tasks, toolchains } = c.get('app')
        const slug = c.req.param('slug')
        if (!tasks.hasProject(slug))
            return c.json({ error: `unknown project "${slug}" or its checkout is missing` }, 404)
        return c.json(await toolchains.project(slug))
    })

    app.post('/install', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { spec?: unknown }
        if (typeof body.spec !== 'string') return c.json({ error: 'spec must be a string like go@1.25.1' }, 400)
        try {
            const output = await c.get('app').toolchains.install(body.spec)
            return c.json({ installed: body.spec, output })
        } catch (error) {
            const message = (error as Error & { stderr?: string }).stderr?.trim() || (error as Error).message
            return c.json({ error: message.split('\n').slice(-5).join('\n') }, 400)
        }
    })

    app.delete('/tools/:tool/:version', async (c) => {
        try {
            const output = await c.get('app').toolchains.uninstall(c.req.param('tool'), c.req.param('version'))
            return c.json({ removed: true, output })
        } catch (error) {
            const message = (error as Error & { stderr?: string }).stderr?.trim() || (error as Error).message
            return c.json({ error: message.split('\n').slice(-5).join('\n') }, 400)
        }
    })

    app.post('/prune', async (c) => c.json(await c.get('app').toolchains.prune()))

    app.post('/docker/stop', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { id?: unknown }
        if (typeof body.id !== 'string') return c.json({ error: 'id must be a container id' }, 400)
        try {
            await c.get('app').toolchains.stopContainer(body.id)
            return c.json({ stopped: body.id })
        } catch (error) {
            return c.json({ error: (error as Error).message.split('\n')[0] }, 400)
        }
    })

    app.post('/docker/prune', async (c) => c.json({ reclaimed: await c.get('app').toolchains.dockerPrune() }))

    return app
}
