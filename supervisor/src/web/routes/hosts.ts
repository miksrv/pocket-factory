import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Hono } from 'hono'

import { BadName, NotFound } from '../../files/catalog.js'
import { type Hosts, InUse, isHostRef, KEY_NAME, SSH_TARGET } from '../../files/hosts.js'
import type { KnownHosts } from '../../files/knownHosts.js'
import type { Env } from '../context.js'

/**
 * Project hosts are reached over SSH with the keys the owner placed in
 * `data/secrets/ssh/` (mounted read-only, linked to ~/.ssh in the image).
 * The API never reads or returns key material: it lists key *names* so the
 * project form can pick one, and runs a connection test so access can be
 * checked without spending a task. The server's side of trust — its host key
 * — is the factory's `known_hosts` (`KnownHosts`): the test says when a
 * server is unknown or has changed, `keyscan` shows its fingerprints and
 * `trust` writes what the owner confirmed. Deleting the last host on a
 * server, or moving it to another address, forgets the key again.
 */

const NOT_KEYS = new Set(['config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'environment', 'rc'])

function keysDir(dataRoot: string): string {
    return path.join(dataRoot, 'secrets', 'ssh')
}

/** Private key files: regular files that are not the well-known ssh config files and not `*.pub`. */
function listKeys(dir: string): Array<{ name: string; public: boolean }> {
    if (!fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.pub') && !NOT_KEYS.has(entry.name) && KEY_NAME.test(entry.name))
        .map((entry) => ({ name: entry.name, public: fs.existsSync(path.join(dir, `${entry.name}.pub`)) }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

interface Target {
    user: string
    host: string
    port?: string
    key?: string
}

/** The `ssh` + `key` of the request, or of a shared host by `name`; null when the target is not user@host[:port]. */
function resolveTarget(hosts: Hosts, body: { ssh?: unknown; key?: unknown; name?: unknown }): Target | { error: string; status: 400 | 404 } {
    let ssh = body.ssh
    let key = body.key
    if (typeof body.name === 'string') {
        const shared = hosts.get(body.name)
        if (!shared) return { error: `unknown host "${body.name}"`, status: 404 }
        ssh = shared.ssh
        key = shared.key
    }
    const match = SSH_TARGET.exec(typeof ssh === 'string' ? ssh.trim() : '')
    if (!match) return { error: 'ssh target must look like user@host or user@host:port', status: 400 }
    if (key !== undefined && key !== null && key !== '' && (typeof key !== 'string' || !KEY_NAME.test(key))) return { error: 'unknown key', status: 400 }
    return { user: match[1], host: match[2], port: match[3] || undefined, key: typeof key === 'string' && key ? key : undefined }
}

/** Whether any shared or inline host still points at this server (host and port), other than the one being removed or moved. */
function serverStillUsed(hosts: Hosts, host: string, port: string | undefined, except?: string): boolean {
    const same = (ssh: string | undefined) => {
        const m = SSH_TARGET.exec((ssh ?? '').trim())
        return Boolean(m) && m![2].toLowerCase() === host.toLowerCase() && (m![3] || '22') === (port || '22')
    }
    const overview = hosts.list()
    return overview.hosts.some((h) => h.name !== except && same(h.ssh)) || overview.inline.some((i) => !isHostRef(i.host) && same(i.host.ssh))
}

/** After a host left a server: forget its key unless another host still uses it. Never fails the request that triggered it. */
async function forgetIfUnused(hosts: Hosts, knownHosts: KnownHosts, ssh: string | undefined, except?: string): Promise<void> {
    const m = SSH_TARGET.exec((ssh ?? '').trim())
    if (!m || serverStillUsed(hosts, m[2], m[3] || undefined, except)) return
    await knownHosts.forget(m[2], m[3] || undefined).catch(() => undefined)
}

/** What ssh's stderr says about the server's key under StrictHostKeyChecking=yes. */
function hostKeyProblem(stderr: string): 'unknown' | 'changed' | undefined {
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|has changed and you have requested strict checking/.test(stderr)) return 'changed'
    if (/No .* host key is known|Host key verification failed/.test(stderr)) return 'unknown'
    return undefined
}

export function hostRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    /** The shared hosts with the projects that use each, plus hosts still written inside project files. */
    app.get('/', (c) => c.json(c.get('app').hosts.list()))

    /** Create or update a shared host; a different `name` in the body renames it and the projects follow. */
    app.put('/:name', async (c) => {
        const { hosts } = c.get('app')
        const body = (await c.req.json().catch(() => null)) as { name?: unknown; ssh?: unknown; key?: unknown } | null
        if (!body || typeof body.ssh !== 'string') return c.json({ error: 'ssh is required' }, 400)
        for (const field of ['name', 'key'] as const) {
            if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') return c.json({ error: `${field} must be a string` }, 400)
        }
        const before = hosts.get(c.req.param('name'))
        try {
            const saved = hosts.save(c.req.param('name'), { name: body.name as string | undefined, ssh: body.ssh, key: (body.key as string) || undefined })
            if (before && before.ssh.trim() !== saved.ssh) await forgetIfUnused(hosts, c.get('app').knownHosts, before.ssh)
            return c.json(saved)
        } catch (error) {
            return c.json({ error: (error as Error).message }, error instanceof BadName ? 400 : 409)
        }
    })

    /** Remove a shared host; `?detach=1` also drops it from the projects that use it, otherwise a used host answers 409 with their names. */
    app.delete('/:name', async (c) => {
        const { hosts, knownHosts } = c.get('app')
        try {
            const gone = hosts.get(c.req.param('name'))
            hosts.remove(c.req.param('name'), c.req.query('detach') === '1')
            if (gone) await forgetIfUnused(hosts, knownHosts, gone.ssh)
            return c.body(null, 204)
        } catch (error) {
            if (error instanceof NotFound) return c.json({ error: error.message }, 404)
            if (error instanceof InUse) return c.json({ error: error.message, projects: error.projects }, 409)
            return c.json({ error: (error as Error).message }, 409)
        }
    })

    app.get('/keys', (c) => {
        const { config, knownHosts } = c.get('app')
        const dir = keysDir(config.paths.dataRoot)
        return c.json({ dir, keys: listKeys(dir), known_hosts: knownHosts.file })
    })

    /**
     * `ssh -o BatchMode=yes user@host echo ok` for a target + key, or for a
     * shared host by `name`: the exit code and the last lines of stderr say
     * what is wrong. `host_key` names the one failure the UI can settle
     * itself: the server is not in known_hosts yet, or its key changed.
     */
    app.post('/test', async (c) => {
        const { config, hosts, knownHosts } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as { ssh?: unknown; key?: unknown; name?: unknown }
        const target = resolveTarget(hosts, body)
        if ('error' in target) return c.json({ error: target.error }, target.status)
        const dir = keysDir(config.paths.dataRoot)
        const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts.file}`]
        if (target.key) {
            if (!listKeys(dir).some((k) => k.name === target.key)) return c.json({ error: 'unknown key' }, 400)
            args.push('-i', path.join(dir, target.key), '-o', 'IdentitiesOnly=yes')
        }
        if (target.port) args.push('-p', target.port)
        args.push(`${target.user}@${target.host}`, 'echo', 'ok')
        const started = Date.now()
        const result = await new Promise<{ ok: boolean; output: string; host_key?: 'unknown' | 'changed' }>((resolve) => {
            execFile('ssh', args, { timeout: 20_000 }, (error, stdout, stderr) => {
                const output = `${stdout}${stderr}`.trim().split('\n').slice(-6).join('\n')
                const ok = !error && stdout.trim() === 'ok'
                resolve({ ok, output: output || (error ? error.message : ''), host_key: ok ? undefined : hostKeyProblem(stderr) })
            })
        })
        return c.json({ ...result, ms: Date.now() - started })
    })

    /** The keys a server offers (`ssh-keyscan`), with fingerprints, so the owner can compare and then trust them. */
    app.post('/keyscan', async (c) => {
        const { hosts, knownHosts } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as { ssh?: unknown; name?: unknown }
        const target = resolveTarget(hosts, body)
        if ('error' in target) return c.json({ error: target.error }, target.status)
        try {
            const keys = await knownHosts.scan(target.host, target.port)
            return c.json({ host: target.host, port: target.port ?? null, known: await knownHosts.has(target.host, target.port), keys })
        } catch (error) {
            return c.json({ error: (error as Error).message }, 502)
        }
    })

    /** Write the lines the owner confirmed into known_hosts; `replace` drops what the file had for that server first. */
    app.post('/trust', async (c) => {
        const { hosts, knownHosts } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as { ssh?: unknown; name?: unknown; lines?: unknown; replace?: unknown }
        const target = resolveTarget(hosts, body)
        if ('error' in target) return c.json({ error: target.error }, target.status)
        if (!Array.isArray(body.lines) || !body.lines.every((l) => typeof l === 'string')) return c.json({ error: 'lines must be an array of strings' }, 400)
        try {
            await knownHosts.trust(target.host, target.port, body.lines as string[], body.replace === true)
            return c.json({ file: knownHosts.file })
        } catch (error) {
            return c.json({ error: (error as Error).message }, error instanceof BadName ? 400 : 500)
        }
    })

    return app
}
