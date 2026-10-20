import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger.js'
import type { SandboxManager } from './manager.js'
import type { Sbx } from './sbx.js'

const log = createLogger('executor')

/** One process the factory starts for an agent: the CLI, `claude mcp …`, a routine's script. */
export interface LaunchSpec {
    /** The command and its arguments: `['claude', '-p', …]`, `['bash', '-c', script]`. */
    argv: string[]
    cwd: string
    /** The whole environment the process would get on the supervisor (`agentEnv`). */
    env: NodeJS.ProcessEnv
    /** Whose sandbox: a project's, or null for the factory's own (project-less chats, side calls). */
    project: string | null
    /** `pipe`: the caller writes to stdin (stream-json, a pasted URL); `ignore`: nothing to read. */
    stdin: 'pipe' | 'ignore'
    /** A terminal inside the sandbox too (`sbx exec -t`), for a command run under a pseudo-terminal here. */
    tty?: boolean
    /** Aborted while the sandbox was being prepared (the task was stopped): nothing is started. */
    signal?: AbortSignal
    /** Wraps the final command (e.g. under a pseudo-terminal); gets the file and its arguments. */
    wrap?: (file: string, args: string[]) => { file: string; args: string[] }
}

/** A started process and how to signal everything it started. */
export interface Launched {
    child: ChildProcess
    /** TERM / KILL the process and its children, wherever they run. */
    signal: (sig: NodeJS.Signals) => void
}

/** The place of a run could not be prepared (the sandbox would not start): nothing ran, a retry would not help. */
export class LaunchError extends Error {}

export interface Executor {
    readonly kind: 'local' | 'sbx'
    /** Start the process; rejects when its place cannot be prepared (a sandbox that will not start). */
    launch(spec: LaunchSpec): Promise<Launched>
}

/**
 * Resolves once the process is running, rejects with the spawn error (no such program): the
 * caller's own listeners come later, and an `error` nobody listens to would end the supervisor.
 */
export function started(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        const failed = (error: Error) => reject(error)
        child.once('error', failed)
        child.once('spawn', () => {
            child.off('error', failed)
            resolve()
        })
    })
}

/**
 * Signal a process group started with `detached: true`; the child alone when that fails. A KILL
 * reaches the group even after its leader exited: a TERM ends bash first, and a child that
 * ignores TERM (`trap '' TERM`) is still in the group.
 */
export function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
    const exited = child.exitCode !== null || child.signalCode !== null
    if (exited && sig !== 'SIGKILL') return
    try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig)
        else if (!exited) child.kill(sig)
    } catch {
        // already gone (ESRCH: the group is empty)
    }
}

/**
 * On the supervisor itself, as before the sandboxes: `yarn dev` on a machine without sbx, the unit
 * tests and e2e. Each process in its own group, so a stop reaches the tools it spawned.
 */
export class LocalExecutor implements Executor {
    readonly kind = 'local'

    async launch(spec: LaunchSpec): Promise<Launched> {
        if (spec.signal?.aborted) throw new LaunchError('stopped before it started')
        const [command, ...args] = spec.argv
        const { file, args: final } = spec.wrap ? spec.wrap(command, args) : { file: command, args }
        const child = spawn(file, final, {
            cwd: spec.cwd,
            env: spec.env,
            stdio: [spec.stdin, 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        })
        await started(child)
        return { child, signal: (sig) => signalGroup(child, sig) }
    }
}

/**
 * Names of the supervisor's own environment that never go into a sandbox: the container's system
 * (paths, locale, its node), its configuration, and anything that would replace the VM's proxy,
 * certificates or home. Everything else in `agentEnv` (GitHub tokens, MCP `${VAR}` secrets, the
 * vault's values, provider and run variables) goes in by name.
 */
const HOST_ONLY = new Set([
    'PATH',
    'HOME',
    'HOSTNAME',
    'PWD',
    'OLDPWD',
    'SHLVL',
    'TERM',
    'USER',
    'LOGNAME',
    'SHELL',
    'MAIL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LANGUAGE',
    'NODE_ENV',
    'NODE_VERSION',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_USE_ENV_PROXY',
    'YARN_VERSION',
    'SSH_AUTH_SOCK',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'all_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'BASH_ENV',
    'ENV',
    'DATA_ROOT',
    'WORKSPACES_ROOT',
    'WORKSPACES_DIR',
    'DATA_DIR',
    'PRESETS_DIR',
    'MAX_CONCURRENT_SESSIONS',
    'LOG_LEVEL',
    'CONTAINER_MEMORY',
    'COMPOSE_PROFILES',
    'PREVIEW_PORTS',
    'PREVIEW_BIND',
    'PREVIEW_UPSTREAM',
    'PREVIEW_TTL_HOURS'
])
const HOST_ONLY_PREFIXES = [
    'LC_',
    'XDG_',
    'DBUS_',
    'npm_',
    'COREPACK_',
    'DOCKER_',
    'MISE_',
    'WEB_',
    'TELEGRAM_',
    'SBX_',
    'SANDBOX_',
    'ROUTINES_',
    'SCHEDULES_',
    'STT_'
]

/** A name that stays on the supervisor (the vault refuses it: it would never reach a sandbox). */
export const hostOnly = (name: string) =>
    HOST_ONLY.has(name) || HOST_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))

/** The names of `env` that go into a sandbox run. */
export function sandboxEnvNames(env: NodeJS.ProcessEnv): string[] {
    return Object.keys(env).filter(
        (name) => env[name] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !hostOnly(name)
    )
}

/** The variable that marks every process of one run inside a VM (a stop finds them by it). */
export const RUN_MARK = 'PF_RUN'

/**
 * A shell line that sends `sig` to every process whose environment holds exactly `PF_RUN=<id>`
 * (`*` = any run). `cliOnly`: the `claude` processes alone, so what they left running on purpose
 * (a dev server behind a preview) stays.
 */
export function killByMark(id: string, sig: NodeJS.Signals, cliOnly = false): string {
    const pattern = id === '*' ? `^${RUN_MARK}=` : `^${RUN_MARK}=${id}$`
    const name = sig.replace(/^SIG/, '')
    const which = cliOnly ? ` && [ "$(cat "\${f%/environ}/comm" 2>/dev/null)" = claude ]` : ''
    return `for f in /proc/[0-9]*/environ; do grep -qzE '${pattern}' "$f" 2>/dev/null${which} && p=\${f%/environ} && kill -${name} "\${p#/proc/}" 2>/dev/null; done; true`
}

/**
 * In the project's Docker Sandbox (`sbx exec`): the paths are the same as on the supervisor, the
 * environment goes in by name, and every process of the run carries `PF_RUN=<id>`. Killing the
 * local `sbx exec` does not end the process in the VM (spike S5), so a signal goes in with a
 * second `sbx exec` that finds the run's processes by that mark.
 */
export class SbxExecutor implements Executor {
    readonly kind = 'sbx'

    constructor(
        private readonly sbx: Sbx,
        private readonly manager: SandboxManager
    ) {}

    async launch(spec: LaunchSpec): Promise<Launched> {
        let name: string
        try {
            name = await this.manager.ensure(spec.project, spec.cwd)
        } catch (error) {
            throw new LaunchError(error instanceof Error ? error.message : String(error), { cause: error })
        }
        // Stopped while the sandbox was made or started: the run never begins, nothing to find in the VM.
        if (spec.signal?.aborted) throw new LaunchError('stopped before it started')
        const runId = randomUUID()
        const env: NodeJS.ProcessEnv = { ...spec.env, [RUN_MARK]: runId }
        const names = sandboxEnvNames(env)
        const values = Object.fromEntries(names.map((n) => [n, env[n]]))
        const args = this.sbx.execArgs(name, spec.argv, {
            cwd: spec.cwd,
            env: names,
            interactive: spec.stdin === 'pipe',
            tty: spec.tty
        })
        const { file, args: final } = spec.wrap ? spec.wrap(this.sbx.bin, args) : { file: this.sbx.bin, args }
        const child = spawn(file, final, {
            cwd: '/',
            env: this.sbx.env(values),
            stdio: [spec.stdin, 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        })
        const release = this.manager.hold(name)
        child.once('close', release)
        // The client gone without a clean exit (a daemon restart, an OOM kill): the CLI may still run in
        // the VM, and a retry would put a second one on the same session. Its dev servers stay.
        child.once('close', (code) => {
            if (code === 0) return
            this.sbx
                .exec(name, ['sh', '-c', killByMark(runId, 'SIGKILL', true)], { timeoutMs: 30_000 })
                .catch((error: unknown) =>
                    log.warn(
                        `${name}: sweep after run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`
                    )
                )
        })
        child.once('error', release)
        try {
            await started(child)
        } catch (error) {
            throw new LaunchError(`${this.sbx.bin}: ${error instanceof Error ? error.message : String(error)}`, {
                cause: error
            })
        }
        const signal = (sig: NodeJS.Signals) => {
            // A KILL goes in even when the client is gone: what ignored the TERM still carries the mark.
            if (sig !== 'SIGKILL' && (child.exitCode !== null || child.signalCode !== null)) return
            this.sbx
                .exec(name, ['sh', '-c', killByMark(runId, sig)], { timeoutMs: 30_000 })
                .catch((error: unknown) =>
                    log.warn(
                        `${name}: ${sig} to run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`
                    )
                )
                .finally(() => {
                    // The client goes too once the VM's side had its signal; after KILL nothing is left to wait for.
                    if (sig === 'SIGKILL') signalGroup(child, 'SIGKILL')
                })
        }
        return { child, signal }
    }
}

/** Run a short command to its end through an executor: its exit code and output (bounded). */
export async function collect(
    executor: Executor,
    spec: Omit<LaunchSpec, 'stdin'>,
    timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { child, signal } = await executor.launch({ ...spec, stdin: 'ignore' })
    return new Promise((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            signal('SIGTERM')
            setTimeout(() => signal('SIGKILL'), 5_000).unref()
        }, timeoutMs)
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
            if (stdout.length < 1 << 20) stdout += chunk
        })
        child.stderr?.on('data', (chunk: string) => {
            if (stderr.length < 64_000) stderr += chunk
        })
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            resolve({ code, stdout, stderr })
        })
    })
}
