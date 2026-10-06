import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { BadName } from './catalog.js'

/**
 * The factory's `known_hosts` — `<config>/known_hosts`, next to hosts.yaml, so
 * that trusting a server is part of adding a host and never a shell command on
 * the box that runs the factory. The file is the one ssh consults for the
 * connection test (`UserKnownHostsFile`) and, in the image, for every ssh an
 * agent runs (`/etc/ssh/ssh_config.d/pocket-factory.conf`). `data/secrets` is
 * mounted read-only, so the file cannot live with the keys; a `known_hosts`
 * that is still there from before is copied over once.
 *
 * Trust is explicit: the UI scans the server's keys, shows the fingerprints,
 * and only the owner's confirmation writes them. Forgetting happens when the
 * last host on a server is deleted or moved elsewhere.
 */
export interface HostKey {
    /** ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, … */
    type: string
    /** `SHA256:…`, the way `ssh-keygen -lf` prints it. */
    fingerprint: string
    /** The known_hosts line: `<host spec> <type> <base64>`. */
    line: string
}

const KEY_TYPE =
    /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The host as known_hosts names it: `host` on the default port, `[host]:port` otherwise. */
export function hostSpec(host: string, port?: string): string {
    const h = host.toLowerCase()
    return port && port !== '22' ? `[${h}]:${port}` : h
}

export class KnownHosts {
    constructor(
        readonly file: string,
        legacy?: string
    ) {
        if (legacy && !fs.existsSync(file) && fs.existsSync(legacy)) {
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.copyFileSync(legacy, file)
        }
    }

    /** `ssh-keyscan` the server: every key it offers, with fingerprints for the owner to compare. */
    scan(host: string, port?: string): Promise<HostKey[]> {
        const args = ['-T', '10']
        if (port) args.push('-p', port)
        args.push(host)
        return new Promise((resolve, reject) => {
            execFile('ssh-keyscan', args, { timeout: 20_000 }, (error, stdout, stderr) => {
                const keys = stdout
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l && !l.startsWith('#'))
                    .flatMap((line) => {
                        const parsed = parseLine(line)
                        return parsed
                            ? [{ ...parsed, line: `${hostSpec(host, port)} ${parsed.type} ${parsed.key}` }]
                            : []
                    })
                    .map(({ type, key, line }) => ({ type, fingerprint: fingerprint(key), line }))
                if (keys.length) return resolve(keys)
                const detail =
                    stderr
                        .trim()
                        .split('\n')
                        .filter((l) => l && !l.startsWith('#'))
                        .at(-1) ?? ''
                reject(
                    new Error(
                        `no host key from ${hostSpec(host, port)}: ${detail || 'no answer within 10 s — wrong host or port, or a firewall in between'}`
                    )
                )
            })
        })
    }

    /** Whether the file has an entry for the server (hashed or plain). */
    async has(host: string, port?: string): Promise<boolean> {
        if (!fs.existsSync(this.file)) return false
        const { code } = await keygen(['-F', hostSpec(host, port), '-f', this.file])
        return code === 0
    }

    /**
     * Write the keys the owner confirmed. Each line must name this very
     * server: what was shown is what is written. `replace` first drops the
     * entries the file already has for it (a reinstalled server).
     */
    async trust(host: string, port: string | undefined, lines: string[], replace: boolean): Promise<void> {
        const spec = hostSpec(host, port)
        const accepted: string[] = []
        for (const raw of lines) {
            const line = raw.trim()
            const parsed = parseLine(line)
            if (!parsed || parsed.host.toLowerCase() !== spec)
                throw new BadName(`not a host key line for ${spec}: "${line.slice(0, 40)}"`)
            accepted.push(`${spec} ${parsed.type} ${parsed.key}`)
        }
        if (!accepted.length) throw new BadName('no host keys to trust')
        if (replace) await this.forget(host, port)
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const current = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : ''
        const fresh = accepted.filter((l) => !current.split('\n').some((c) => c.trim() === l))
        if (!fresh.length) return
        fs.appendFileSync(this.file, `${current && !current.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`, {
            mode: 0o644
        })
    }

    /** Drop every entry for the server (`ssh-keygen -R`); nothing to do when the file has none. */
    async forget(host: string, port?: string): Promise<void> {
        if (!(await this.has(host, port))) return
        const { code, stderr } = await keygen(['-R', hostSpec(host, port), '-f', this.file])
        if (code !== 0) throw new Error(`ssh-keygen -R failed: ${stderr.trim() || code}`)
        fs.rmSync(`${this.file}.old`, { force: true })
    }
}

function parseLine(line: string): { host: string; type: string; key: string } | null {
    const parts = line.split(/\s+/)
    if (parts.length < 3) return null
    const [host, type, key] = parts
    if (!KEY_TYPE.test(type) || !BASE64.test(key) || host.startsWith('@')) return null
    return { host, type, key }
}

/** `SHA256:` + base64 of the key blob's digest, unpadded — what `ssh-keygen -lf` shows and what a server prints for itself. */
function fingerprint(key: string): string {
    return `SHA256:${crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`
}

function keygen(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile('ssh-keygen', args, { timeout: 10_000 }, (error, stdout, stderr) => {
            const code = (error as { code?: unknown } | null)?.code
            resolve({ code: error ? (typeof code === 'number' ? code : 1) : 0, stdout, stderr })
        })
    })
}
