import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Hono } from 'hono'

import type { Env } from '../context.js'

/**
 * Project hosts are reached over SSH with the keys the owner placed in
 * `data/secrets/ssh/` (mounted read-only, linked to ~/.ssh in the image).
 * The API never reads or returns key material: it lists key *names* so the
 * project form can pick one, and runs a connection test so access can be
 * checked without spending a task.
 */

/** `user@host` or `user@host:port`. Nothing else reaches the ssh command line. */
const TARGET = /^([a-z_][a-z0-9_.-]{0,31})@([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i
const KEY_NAME = /^[A-Za-z0-9._-]{1,64}$/
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

export function hostRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/keys', (c) => {
        const dir = keysDir(c.get('app').config.paths.dataRoot)
        return c.json({ dir, keys: listKeys(dir), known_hosts: fs.existsSync(path.join(dir, 'known_hosts')) })
    })

    /** `ssh -o BatchMode=yes user@host true`: the exit code and the last lines of stderr say what is wrong. */
    app.post('/test', async (c) => {
        const { config } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as { ssh?: string; key?: string }
        const target = (body.ssh ?? '').trim()
        const match = TARGET.exec(target)
        if (!match) return c.json({ error: 'ssh target must look like user@host or user@host:port' }, 400)
        const dir = keysDir(config.paths.dataRoot)
        const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`]
        if (body.key) {
            if (!KEY_NAME.test(body.key) || !listKeys(dir).some((k) => k.name === body.key)) return c.json({ error: 'unknown key' }, 400)
            args.push('-i', path.join(dir, body.key), '-o', 'IdentitiesOnly=yes')
        }
        if (match[3]) args.push('-p', match[3])
        args.push(`${match[1]}@${match[2]}`, 'echo', 'ok')
        const started = Date.now()
        const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
            execFile('ssh', args, { timeout: 20_000 }, (error, stdout, stderr) => {
                const output = `${stdout}${stderr}`.trim().split('\n').slice(-6).join('\n')
                resolve({ ok: !error && stdout.trim() === 'ok', output: output || (error ? error.message : '') })
            })
        })
        return c.json({ ...result, ms: Date.now() - started })
    })

    return app
}
