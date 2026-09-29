import { Hono } from 'hono'

import type { Env } from '../context.js'

/** Ready-made bundles of agents + skills + project templates shipped in the repo. */
export function presetRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', (c) => {
        const { presets, catalog } = c.get('app')
        return c.json(
            presets.list().map((preset) => {
                // Per file, since presets share files: a file another preset already put on the volume is installed too.
                const files = preset.files.map((file) => ({ ...file, installed: catalog.exists(file.kind, file.name) }))
                return { ...preset, files, installed: files.every((file) => file.installed) }
            })
        )
    })

    app.get('/:name', (c) => {
        const { presets } = c.get('app')
        const preset = presets.get(c.req.param('name'))
        if (!preset) return c.json({ error: 'preset not found' }, 404)
        return c.json(preset)
    })

    app.post('/:name/install', async (c) => {
        const { presets, catalog } = c.get('app')
        const preset = presets.get(c.req.param('name'))
        if (!preset) return c.json({ error: 'preset not found' }, 404)
        const body = (await c.req.json().catch(() => ({}))) as { overwrite?: boolean }
        const installed = presets.install(preset, catalog, Boolean(body.overwrite))
        return c.json({ installed })
    })

    return app
}
