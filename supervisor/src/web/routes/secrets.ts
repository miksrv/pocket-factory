import fs from 'node:fs'
import path from 'node:path'

import { Hono } from 'hono'

import { folderNeeds } from '../../routines/scripts.js'
import { referencedNames, type Scope, VaultError } from '../../secrets/vault.js'
import type { Env } from '../context.js'
import { clientOf } from '../request.js'

/** Who reads a name: a routine's step (with the step's name), a config file that references it as `${NAME}`, a provider's key. */
interface Use {
    kind: 'routine' | 'config' | 'provider'
    name: string
    step?: string
}

/**
 * Secrets and variables (Settings → Secrets and variables). A secret's value
 * is written here and never read back; the list says where each name is used,
 * so the owner sees what a change affects. Every change is told in Telegram.
 */
export function secretRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', (c) => {
        const { vault, routines, catalog, config, providers } = c.get('app')
        const uses = new Map<string, Use[]>()
        // Once per reader: a provider's MCP servers often share one token.
        const add = (name: string, use: Use) => {
            const list = uses.get(name) ?? []
            if (!list.some((u) => u.kind === use.kind && u.name === use.name && u.step === use.step))
                uses.set(name, [...list, use])
        }
        for (const routine of routines.list())
            for (const step of routine.steps)
                for (const need of step.needs) add(need.name, { kind: 'routine', name: routine.name, step: step.name })
        // The config files that read the environment: MCP servers (`${VAR}`) and the providers' MCP.
        for (const file of ['mcp.json', 'providers.yaml']) {
            const full = path.join(config.paths.configRoot, file)
            if (!fs.existsSync(full)) continue
            for (const name of referencedNames(fs.readFileSync(full, 'utf8')))
                if (vault.has(name)) add(name, { kind: 'config', name: file })
        }
        for (const p of providers.all())
            for (const token of [p.token, ...(p.mcp ?? []).map((m) => m.token)])
                if (token && vault.has(token)) add(token, { kind: 'provider', name: p.name })
        return c.json({
            entries: vault.list().map((e) => ({ ...e, used_by: uses.get(e.name) ?? [] })),
            // What a scope can name.
            routines: catalog.list('routines').map((e) => e.name),
            projects: catalog.list('projects').map((e) => e.name)
        })
    })

    /**
     * What a skill's scripts read, for its page: each name with the files that read it, whether
     * the vault holds it (never the value) and which of the routines running the skill it reaches.
     */
    app.get('/skills/:name', (c) => {
        const { vault, routines, catalog } = c.get('app')
        const name = c.req.param('name')
        if (!catalog.exists('skills', name)) return c.json({ error: `skills/${name} not found` }, 404)
        const using = routines
            .list()
            .filter((r) => r.skill === name)
            .map((r) => ({ name: r.name, project: r.project }))
        const needs = folderNeeds(catalog.folderOf('skills', name))
            .filter((n) => n.declared || vault.has(n.name))
            .map((n) => {
                const entry = vault.get(n.name)
                return {
                    name: n.name,
                    kind: entry ? (entry.secret ? 'secret' : 'variable') : (n.declared ?? 'secret'),
                    files: n.files,
                    entry,
                    env: Boolean(process.env[n.name]),
                    reaches: using
                        .filter((r) => vault.reaches(n.name, { routine: r.name, project: r.project }))
                        .map((r) => r.name)
                }
            })
        return c.json({ needs, routines: using.map((r) => r.name) })
    })

    /**
     * Create or change: `value` (required for a new name; a secret keeps its value without one), `secret`, `scope`,
     * `provider` (a provider key: the gateway's only, no run gets it).
     */
    app.put('/:name', async (c) => {
        const { vault } = c.get('app')
        const name = c.req.param('name')
        const body = (await c.req.json().catch(() => ({}))) as {
            value?: unknown
            secret?: unknown
            scope?: unknown
            provider?: unknown
        }
        if (body.value !== undefined && typeof body.value !== 'string')
            return c.json({ error: 'value must be a string' }, 400)
        if (body.secret !== undefined && typeof body.secret !== 'boolean')
            return c.json({ error: 'secret must be a boolean' }, 400)
        if (body.provider !== undefined && typeof body.provider !== 'boolean')
            return c.json({ error: 'provider must be a boolean' }, 400)
        const scope = parseScope(body.scope)
        if (scope === false)
            return c.json({ error: 'scope must be { all: true } or { all: false, routines, projects }' }, 400)
        // `?create=1`: the "New secret" form, which must not replace a name that exists.
        if (c.req.query('create') && vault.has(name)) return c.json({ error: `${name} exists already` }, 409)
        try {
            const entry = vault.set(
                name,
                { value: body.value, secret: body.secret, scope: scope ?? undefined, provider: body.provider },
                clientOf(c).ip
            )
            return c.json(entry)
        } catch (error) {
            if (error instanceof VaultError) return c.json({ error: error.message }, 400)
            throw error
        }
    })

    app.delete('/:name', (c) => {
        const { vault } = c.get('app')
        const name = c.req.param('name')
        if (!vault.remove(name, clientOf(c).ip)) return c.json({ error: `${name} not found` }, 404)
        return c.body(null, 204)
    })

    return app
}

/** The scope a request sends; undefined = not given, false = malformed. */
function parseScope(raw: unknown): Scope | undefined | false {
    if (raw === undefined) return undefined
    if (!raw || typeof raw !== 'object') return false
    const o = raw as Record<string, unknown>
    if (o.all === true) return { all: true }
    if (o.all !== false) return false
    const list = (v: unknown) =>
        Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : v === undefined ? [] : null
    const routines = list(o.routines)
    const projects = list(o.projects)
    if (!routines || !projects) return false
    return { all: false, routines, projects }
}
