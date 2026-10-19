import { execFile } from 'node:child_process'

/**
 * A typed wrapper over the Docker Sandboxes CLI (`sbx`), run as a client of the host's daemon.
 * The supervisor's container mounts `/usr/bin/sbx` and three directories of the host user's
 * home at the same paths (the daemon's socket, the settings store, the file-based secret store):
 * `home` is that home, set as `HOME` for every call. Verified against sbx 0.48.0 (2026-10-19).
 */

/** One sandbox as `sbx ls --json` lists it. */
export interface SandboxInfo {
    name: string
    status: 'running' | 'stopped' | (string & {})
    workspaces: string[]
    ports: PortBinding[]
    last_used_at: string | null
    created_at: string | null
}

export interface PortBinding {
    host_ip: string
    host_port: number
    sandbox_port: number
    protocol: string
}

/** A network rule as `sbx policy ls <sandbox> --json` reports it. */
export interface PolicyRule {
    id: string
    scope: string
    decision: string
    resources: string[]
    created_via: string | null
}

/** A request the policy held back ("Approval required for <host>"), from `sbx policy approval ls`. */
export interface Approval {
    id: string
    sandbox: string
    /** What was asked for: `host:port`, a domain, or an address. */
    resource: string
    detail: string
    options: string[]
}

/** One line of `sbx diagnose --json`. */
export interface DiagnoseCheck {
    name: string
    status: 'pass' | 'warn' | 'fail' | (string & {})
    message: string
}

export class SbxError extends Error {
    /** What the command printed before it failed: some report on stdout and still exit non-zero. */
    stdout = ''
}

/** What runs one `sbx` command: injectable so tests drive a fake. */
export type SbxRunner = (
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<{ stdout: string; stderr: string }>

const defaultRunner =
    (bin: string): SbxRunner =>
    (args, { env, timeoutMs }) =>
        new Promise((resolve, reject) => {
            execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
                if (!error) return resolve({ stdout, stderr })
                const said = cleanError(stderr) || cleanError(stdout)
                const why = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${bin} is not installed` : said
                const failed = new SbxError(`sbx ${args[0] ?? ''}: ${why || error.message}`)
                failed.stdout = stdout
                reject(failed)
            })
        })

/** The CLI's own complaint without its warnings (`WARN: tls …` when a store is read-only) and hints. */
export function cleanError(text: string): string {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('WARN') && !line.startsWith('try:'))
        .map((line) => line.replace(/^error:\s*/i, ''))
        .join(' ')
}

/** Names sbx accepts: letters, digits, hyphens and periods, starting with a letter or digit. */
export const SANDBOX_NAME = /^[a-z0-9][a-z0-9.-]{1,62}$/

/** The default timeouts: a create pulls an image the first time (38 s seen), a start takes ~2 s. */
const SHORT_MS = 30_000
const LONG_MS = 5 * 60_000

export class Sbx {
    readonly bin: string
    private readonly home: string | undefined
    private readonly runner: SbxRunner

    constructor(options: { bin?: string; home?: string; runner?: SbxRunner } = {}) {
        this.bin = options.bin ?? 'sbx'
        this.home = options.home
        this.runner = options.runner ?? defaultRunner(this.bin)
    }

    /** The environment of every sbx process: the host user's home, no telemetry; `extra` for `exec -e NAME`. */
    env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
        return {
            PATH: process.env.PATH,
            ...(this.home ? { HOME: this.home } : { HOME: process.env.HOME }),
            SBX_NO_TELEMETRY: '1',
            ...extra
        }
    }

    run(args: string[], timeoutMs = SHORT_MS): Promise<{ stdout: string; stderr: string }> {
        return this.runner(args, { env: this.env(), timeoutMs })
    }

    async version(): Promise<string> {
        const { stdout } = await this.run(['version'])
        return /v?\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim()
    }

    async ls(): Promise<SandboxInfo[]> {
        const { stdout } = await this.run(['ls', '--json'])
        const raw = parseJson<Array<Partial<SandboxInfo>>>(stdout, 'ls') ?? []
        return raw
            .filter((s) => typeof s.name === 'string')
            .map((s) => ({
                name: s.name!,
                status: s.status ?? 'unknown',
                workspaces: Array.isArray(s.workspaces) ? s.workspaces : [],
                ports: Array.isArray(s.ports) ? s.ports : [],
                last_used_at: s.last_used_at ?? null,
                created_at: s.created_at ?? null
            }))
    }

    /** A sandbox for Claude Code with `workspaces` bind-mounted read-write at their own paths. */
    async create(name: string, workspaces: string[], options: { memory?: string; cpus?: number } = {}): Promise<void> {
        const args = ['create', '--name', name, '--no-progress']
        if (options.memory) args.push('--memory', options.memory)
        if (options.cpus) args.push('--cpus', String(options.cpus))
        await this.run([...args, 'claude', ...workspaces], LONG_MS)
    }

    async stop(name: string): Promise<void> {
        await this.run(['stop', name], LONG_MS)
    }

    async rm(name: string): Promise<void> {
        await this.run(['rm', '--force', name], LONG_MS)
    }

    /**
     * The argv of `sbx exec` for one command in the sandbox: stdin kept open when `interactive`,
     * the working directory, and the environment by name only (`-e NAME`): the values travel in
     * the client's own environment, never on a command line another process could read.
     */
    execArgs(
        name: string,
        argv: string[],
        options: { cwd?: string; env?: string[]; interactive?: boolean; tty?: boolean; user?: string } = {}
    ): string[] {
        const args = ['exec']
        if (options.interactive) args.push('-i')
        if (options.tty) args.push('-t')
        if (options.user) args.push('-u', options.user)
        if (options.cwd) args.push('-w', options.cwd)
        for (const key of options.env ?? []) args.push('-e', key)
        return [...args, name, ...argv]
    }

    /** A short command in the sandbox (setup, a signal), to its end. */
    async exec(name: string, argv: string[], options: { user?: string; timeoutMs?: number } = {}): Promise<string> {
        const { stdout } = await this.run(
            this.execArgs(name, argv, { user: options.user }),
            options.timeoutMs ?? LONG_MS
        )
        return stdout
    }

    async cp(source: string, target: string): Promise<void> {
        await this.run(['cp', source, target])
    }

    async ports(name: string): Promise<PortBinding[]> {
        const { stdout } = await this.run(['ports', name, '--json'])
        return parseJson<PortBinding[]>(stdout, 'ports') ?? []
    }

    /** Publish `sandboxPort` on `hostIp:hostPort` of the host; starts a stopped sandbox. */
    async publish(name: string, hostIp: string, hostPort: number, sandboxPort: number): Promise<void> {
        await this.run(['ports', name, '--publish', `${hostIp}:${hostPort}:${sandboxPort}`])
    }

    async unpublish(name: string, hostIp: string, hostPort: number, sandboxPort: number): Promise<void> {
        await this.run(['ports', name, '--unpublish', `${hostIp}:${hostPort}:${sandboxPort}`])
    }

    /** Allow one resource (`host`, `host:port`, `*.domain`) for this sandbox only; the rule's id. */
    async policyAllow(name: string, resource: string): Promise<string | null> {
        const { stdout } = await this.run(['policy', 'allow', 'network', '--sandbox', name, resource])
        return /Added rule ([0-9a-f-]{8,})/i.exec(stdout)?.[1] ?? null
    }

    async policyRemove(name: string, id: string): Promise<void> {
        await this.run(['policy', 'rm', 'network', '--sandbox', name, '--id', id, '--force'])
    }

    async policyList(name: string): Promise<PolicyRule[]> {
        const { stdout } = await this.run(['policy', 'ls', name, '--json'])
        const raw = parseJson<{ rules?: Array<Record<string, unknown>> }>(stdout, 'policy ls')
        return (raw?.rules ?? []).map((r) => ({
            id: String(r.id ?? ''),
            scope: String(r.scope ?? ''),
            decision: String(r.decision ?? ''),
            resources: Array.isArray(r.resources) ? r.resources.map(String) : [],
            created_via: (r.provenance as { created_via?: string } | undefined)?.created_via ?? null
        }))
    }

    /** Pending approvals; the CLI has no JSON for them, so the table is read by its column offsets. */
    async approvals(): Promise<Approval[]> {
        const { stdout } = await this.run(['policy', 'approval', 'ls'])
        return parseApprovals(stdout)
    }

    async respond(id: string, option: 'allow' | 'dismiss'): Promise<void> {
        await this.run(['policy', 'approval', 'respond', id, '--option', option])
    }

    /** Whether the Claude login is stored with the daemon (`anthropic (oauth configured)`). */
    async claudeLogin(): Promise<boolean> {
        const { stdout } = await this.run(['secret', 'ls', '--json'])
        const raw = parseJson<{ secrets?: Array<{ name?: string; secret?: string }> }>(stdout, 'secret ls')
        return (raw?.secrets ?? []).some((s) => s.name === 'anthropic')
    }

    async diagnose(): Promise<DiagnoseCheck[]> {
        // diagnose exits non-zero when a check fails (no KVM inside the container): the report is still on stdout.
        const { stdout } = await this.run(['diagnose', '--json'], LONG_MS).catch((error: unknown) => {
            if (error instanceof SbxError && error.stdout.trim()) return { stdout: error.stdout, stderr: '' }
            if (error instanceof SbxError) throw error
            throw new SbxError(String(error))
        })
        const raw = parseJson<{ checks?: Array<Partial<DiagnoseCheck>> }>(stdout, 'diagnose')
        return (raw?.checks ?? []).map((c) => ({
            name: c.name ?? '?',
            status: c.status ?? '?',
            message: c.message ?? ''
        }))
    }
}

function parseJson<T>(text: string, what: string): T | null {
    const start = text.search(/[[{]/)
    if (start < 0) return null
    try {
        return JSON.parse(text.slice(start)) as T
    } catch {
        throw new SbxError(`sbx ${what}: unreadable output`)
    }
}

/** `sbx policy approval ls`: a header line, then one row per approval in the header's columns. */
export function parseApprovals(text: string): Approval[] {
    const lines = text.split('\n').filter((line) => line.trim() && !line.startsWith('WARN'))
    const header = lines.findIndex((line) => /^APPROVAL\s/.test(line))
    if (header < 0) return []
    const head = lines[header]
    const columns = ['APPROVAL', 'SANDBOX', 'TITLE', 'DETAIL', 'OPTIONS'].map((name) => head.indexOf(name))
    if (columns.some((at) => at < 0)) return []
    return lines.slice(header + 1).map((line) => {
        const cell = (i: number) => line.slice(columns[i], columns[i + 1] ?? undefined).trim()
        return {
            id: cell(0),
            sandbox: cell(1),
            resource: cell(2),
            detail: cell(3),
            options: [...cell(4).matchAll(/(\w+) \(/g)].map((m) => m[1])
        }
    })
}
