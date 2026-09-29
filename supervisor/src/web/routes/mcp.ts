import fs from 'node:fs'
import path from 'node:path'

import { Hono } from 'hono'

import type { Env } from '../context.js'

/**
 * MCP servers as the factory sees them: the owner's own in
 * `data/config/mcp.json` (passed to every session with --mcp-config) and the
 * ones each project's checkout declares in `.mcp.json`. Secrets never leave
 * the server: for `${VAR}` references only "set" / "missing" is reported,
 * literal header / env values are withheld from the editor, and the status
 * listing blanks URL query values and secret-looking command arguments.
 * The editor still shows `url` and `args` as written: keep secrets in
 * `${VAR}` references, never in those fields.
 */

interface McpServer {
    type?: string
    url?: string
    command?: string
    args?: string[]
    headers?: Record<string, string>
    env?: Record<string, string>
}

const VAR = /\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}/g

function readServers(file: string): { servers: Record<string, McpServer>; error: string | null } {
    if (!fs.existsSync(file)) return { servers: {}, error: null }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, McpServer> }
        return { servers: parsed.mcpServers ?? {}, error: null }
    } catch (error) {
        return { servers: {}, error: (error as Error).message }
    }
}

/** Every `${VAR}` the server's config references, and whether the variable is set for the supervisor. */
function variablesOf(server: McpServer): Array<{ name: string; set: boolean }> {
    const text = JSON.stringify(server)
    const names = new Set<string>()
    for (const match of text.matchAll(VAR)) names.add(match[1])
    return [...names].sort().map((name) => ({ name, set: Boolean(process.env[name]) }))
}

/** Marks a header / env value the API withheld; a PUT that sends it back keeps the stored value. */
const KEPT = '<kept>'
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
/** A value that takes its secret from the environment ("Bearer ${TOKEN}") is safe to show; one without any reference is a literal and is withheld. */
const isRef = (value: string) => /\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/.test(value)

/** The config for the editor: literal secrets (anything in headers / env that is not a `${VAR}` reference) are withheld. */
function masked(server: McpServer): McpServer {
    const hide = (record?: Record<string, string>) => (record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, isRef(v) ? v : KEPT])) : undefined)
    return { ...server, headers: hide(server.headers), env: hide(server.env) }
}

/** Validate an editor submission and restore withheld values from what is on disk. */
function normalise(name: string, input: McpServer, previous: McpServer | undefined): McpServer {
    if (!NAME.test(name)) throw new Error(`server name "${name}": letters, digits, dot, dash, underscore`)
    const type = input.type ?? (input.command ? 'stdio' : 'http')
    if (!['http', 'sse', 'stdio'].includes(type)) throw new Error(`${name}: type must be http, sse or stdio`)
    const out: McpServer = { type }
    if (type === 'stdio') {
        if (!input.command?.trim()) throw new Error(`${name}: a stdio server needs a command`)
        out.command = input.command.trim()
        const args = (input.args ?? []).map(String).filter((a) => a.length)
        if (args.length) out.args = args
    } else {
        if (!/^https?:\/\//.test(input.url ?? '')) throw new Error(`${name}: an ${type} server needs an http(s) url`)
        out.url = input.url!.trim()
    }
    const restore = (record: Record<string, string> | undefined, stored: Record<string, string> | undefined) => {
        if (!record) return undefined
        const entries = Object.entries(record)
            .filter(([k]) => k.trim())
            .map(([k, v]) => {
                if (v === KEPT) {
                    if (stored?.[k] === undefined) throw new Error(`${name}: "${k}" has no stored value to keep`)
                    return [k.trim(), stored[k]]
                }
                return [k.trim(), String(v)]
            })
        return entries.length ? Object.fromEntries(entries) : undefined
    }
    const headers = restore(input.headers, previous?.headers)
    const env = restore(input.env, previous?.env)
    if (headers) out.headers = headers
    if (env) out.env = env
    return out
}

/** Query values in a URL and secret-looking command arguments, withheld from the status listing. */
const SECRET_FLAG = /(key|token|secret|password|bearer|auth)/i
const SECRET_LITERAL = /^(sk-|ghp_|github_pat_|gho_|xox[abp]-|glpat-)[A-Za-z0-9_-]{8,}/
function targetOf(server: McpServer): string {
    if (server.url) return server.url.replace(/([?&][^=&#]+=)[^&#]*/g, '$1…')
    const args = (server.args ?? []).map((arg, i, all) => {
        if (isRef(arg)) return arg
        if (SECRET_LITERAL.test(arg)) return '…'
        if (i > 0 && all[i - 1].startsWith('-') && SECRET_FLAG.test(all[i - 1])) return '…'
        return arg.replace(/^(--?[^=]*(?:key|token|secret|password)[^=]*=).+$/i, '$1…')
    })
    return [server.command, ...args].filter(Boolean).join(' ')
}

function describe(name: string, server: McpServer) {
    return {
        name,
        type: server.type ?? (server.command ? 'stdio' : 'http'),
        target: targetOf(server),
        variables: variablesOf(server)
    }
}

export function mcpRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', (c) => {
        const { config, catalog, tasks } = c.get('app')
        const file = path.join(config.paths.configRoot, 'mcp.json')
        const global = readServers(file)
        const status = tasks.mcpStatus()
        const projects = catalog.list('projects').map((entry) => {
            const dir = typeof entry.frontmatter.path === 'string' && entry.frontmatter.path ? entry.frontmatter.path : path.join(config.paths.workspacesRoot, entry.name)
            const declared = readServers(path.join(dir, '.mcp.json'))
            const allowed = Array.isArray(entry.frontmatter.mcp) ? entry.frontmatter.mcp.map(String) : null
            return {
                slug: entry.name,
                path: dir,
                checkout: fs.existsSync(dir),
                servers: Object.entries(declared.servers).map(([name, server]) => ({ ...describe(name, server), enabled: !allowed || allowed.includes(name) })),
                allowed,
                error: declared.error,
                last_session: status[entry.name] ?? null
            }
        })
        return c.json({
            global: {
                file,
                servers: Object.entries(global.servers).map(([name, server]) => describe(name, server)),
                config: Object.fromEntries(Object.entries(global.servers).map(([name, server]) => [name, masked(server)])),
                error: global.error,
                last_session: status['.'] ?? null
            },
            projects
        })
    })

    /** Replace the factory's servers. Other top-level keys of the file are kept; withheld values come back from disk. */
    app.put('/global', async (c) => {
        const { config } = c.get('app')
        const file = path.join(config.paths.configRoot, 'mcp.json')
        const body = (await c.req.json().catch(() => null)) as { mcpServers?: Record<string, McpServer> } | null
        if (!body || typeof body.mcpServers !== 'object' || body.mcpServers === null || Array.isArray(body.mcpServers)) return c.json({ error: 'mcpServers object required' }, 400)
        let current: Record<string, unknown> = {}
        if (fs.existsSync(file)) {
            try {
                current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
            } catch {
                current = {}
            }
        }
        const previous = (current.mcpServers ?? {}) as Record<string, McpServer>
        const servers: Record<string, McpServer> = {}
        try {
            for (const [name, server] of Object.entries(body.mcpServers)) servers[name] = normalise(name, server ?? {}, previous[name])
        } catch (error) {
            return c.json({ error: (error as Error).message }, 400)
        }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`)
        return c.json({ saved: Object.keys(servers).length })
    })

    return app
}
