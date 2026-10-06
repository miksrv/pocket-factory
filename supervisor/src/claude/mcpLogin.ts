import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger.js'

/**
 * `claude mcp login <name> --no-browser` driven from the web UI instead of a
 * terminal. The CLI prints the authorization URL; what follows depends on the
 * server:
 *
 * - a claude.ai connector: the URL leads to claude.ai, the command exits at
 *   once and the connector is connected on the next `claude mcp list`;
 * - an OAuth server of the CLI's own (a project's `.mcp.json`): the CLI keeps
 *   a callback server on a random localhost port and, since the browser is on
 *   another machine, waits for the redirect URL to be pasted back on stdin.
 *
 * The CLI refuses the second flow without a terminal ("stdin isn't a
 * terminal"), so the command runs under a pseudo-terminal: util-linux `script`
 * in the container, `python3 -c pty.spawn` on macOS (`yarn dev`), where the
 * BSD `script` cannot take a pipe as stdin. Output is read with the terminal
 * escapes stripped; the pasted URL goes to the wrapper's stdin.
 */

const log = createLogger('mcp-login')

export type McpLoginState = 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled'

export interface McpLoginView {
    id: string
    name: string
    /** `connector`: sign in on claude.ai, nothing to paste; `redirect`: the CLI waits for the redirect URL; null until the CLI said which. */
    mode: 'connector' | 'redirect' | null
    /** `starting` → `waiting` (URL known) → `done` | `failed` | `cancelled`. */
    state: McpLoginState
    url: string | null
    /** What the CLI last said, for the dialog. */
    message: string | null
    started_at: string
}

interface Login extends McpLoginView {
    child: ChildProcess
    /** Everything the CLI printed, escapes stripped. */
    output: string
    /** Where the output stood when the last URL was pasted: a prompt after it is a rejection. */
    pasted_at: number
    pasted: string | null
    timers: NodeJS.Timeout[]
    /** Resolved on every change of state or output, for the waits below. */
    listeners: Set<() => void>
}

/** How long the CLI gets to print the URL before the UI is told to keep polling. */
const START_WAIT_MS = 30_000
/** How long a paste gets to be accepted or rejected. */
const COMPLETE_WAIT_MS = 60_000
/** A sign-in nobody finishes is cancelled after this. */
const LOGIN_TTL_MS = 10 * 60_000
/** Finished sign-ins stay readable for the dialog's last poll. */
const KEEP_DONE_MS = 5 * 60_000
const KILL_GRACE_MS = 5_000

const URL_LINE = /Visit this URL to authorize:\s*(https?:\/\/\S+)/
const PROMPT = /paste the redirect URL here/i
const CONNECTOR = /available the next time you start Claude Code/i

/** ANSI CSI / OSC sequences (the CLI wraps the URL in an OSC 8 hyperlink even with TERM=dumb) and carriage returns. */
/* eslint-disable no-control-regex -- matching terminal escapes is the point */
const strip = (text: string) =>
    text
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[()][A-Za-z0-9]/g, '')
        .replace(/\r/g, '')
/* eslint-enable no-control-regex */

const shellQuote = (argv: string[]) => argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')

/**
 * The macOS wrapper: `pty.spawn` would keep running after the CLI exits (its
 * copy loop waits for our stdin, which never closes), so this loop also
 * watches the child and forwards SIGTERM to it (the child sits in its own
 * session, out of reach of a kill on our process group).
 */
const PTY_PY = `
import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
fds = [fd, 0]
status = None
while status is None:
    r, _, _ = select.select(fds, [], [], 0.25)
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 4096)
        if not data:
            fds.remove(0)
        else:
            os.write(fd, data)
    p, st = os.waitpid(pid, os.WNOHANG)
    if p:
        status = st
if status is None:
    _, status = os.waitpid(pid, 0)
os.set_blocking(fd, False)
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    os.write(1, data)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`

/** The command that runs `argv` under a pseudo-terminal on this platform. */
function ptyCommand(argv: string[]): { command: string; args: string[] } {
    if (process.platform === 'linux') return { command: 'script', args: ['-qfec', shellQuote(argv), '/dev/null'] }
    return { command: 'python3', args: ['-c', PTY_PY, ...argv] }
}

export class McpLogins {
    private readonly logins = new Map<string, Login>()

    /** `onAuthorized` runs when a redirect-mode sign-in completes, so the registry can mark the server connected. */
    constructor(private readonly onAuthorized: (name: string) => void = () => {}) {}

    /** Start a sign-in; resolves once the CLI printed the URL and said what comes next, or gave up, or after 30 s. */
    async start(name: string, options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<McpLoginView> {
        for (const other of this.logins.values())
            if (other.name === name && (other.state === 'starting' || other.state === 'waiting')) this.cancel(other.id)
        const argv = ['claude', 'mcp', 'login', name, '--no-browser']
        const { command, args } = ptyCommand(argv)
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: { ...options.env, TERM: 'dumb', NO_COLOR: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        })
        const login: Login = {
            id: randomUUID(),
            name,
            mode: null,
            state: 'starting',
            url: null,
            message: null,
            started_at: new Date().toISOString(),
            child,
            output: '',
            pasted_at: 0,
            pasted: null,
            timers: [],
            listeners: new Set()
        }
        this.logins.set(login.id, login)
        log.info(`${login.id}: ${argv.join(' ')} (cwd ${options.cwd}, via ${command})`)

        const onData = (chunk: Buffer) => {
            login.output += strip(chunk.toString())
            this.digest(login)
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        child.on('error', (error) => {
            login.state = 'failed'
            login.message = error.message.includes('ENOENT')
                ? `${command} is not installed: the sign-in needs a pseudo-terminal`
                : error.message
            this.notify(login)
        })
        child.on('exit', (code, signal) => {
            if (login.state === 'cancelled') return this.notify(login)
            const rest = this.rest(login)
            if (code === 0 && !login.url) {
                login.state = 'failed'
                login.message = `The CLI printed no sign-in link: ${rest.at(-1) ?? 'no output'}`
            } else if (code === 0) {
                if (
                    login.url &&
                    login.mode !== 'redirect' &&
                    (CONNECTOR.test(login.output) || !PROMPT.test(login.output))
                ) {
                    login.mode = 'connector'
                    login.message =
                        'Sign in on claude.ai in that tab; the connector is available to the agents once the statuses are refreshed.'
                } else {
                    login.message = rest.at(-1) ?? 'Authorized.'
                    if (login.mode === 'redirect') this.onAuthorized(login.name)
                }
                login.state = 'done'
            } else {
                login.state = 'failed'
                login.message = rest.slice(-2).join(' ') || `claude mcp login exited with ${code ?? signal}`
            }
            log.info(`${login.id}: ${login.state} (${code ?? signal})`)
            this.notify(login)
            login.timers.push(setTimeout(() => this.logins.delete(login.id), KEEP_DONE_MS))
        })
        login.timers.push(setTimeout(() => this.cancel(login.id), LOGIN_TTL_MS))

        await this.until(login, () => login.state !== 'starting', START_WAIT_MS)
        return this.view(login)
    }

    get(id: string): McpLoginView | undefined {
        const login = this.logins.get(id)
        return login && this.view(login)
    }

    /** Paste the redirect URL back. Throws with the CLI's words when it rejects the URL; the sign-in then stays open for another try. */
    async complete(id: string, url: string): Promise<McpLoginView> {
        const login = this.logins.get(id)
        if (!login) throw new Error('This sign-in has expired: start it again')
        if (login.state !== 'waiting') throw new Error(`This sign-in is ${login.state}, nothing to paste`)
        let parsed: URL
        try {
            parsed = new URL(url.trim())
        } catch {
            throw new Error('Paste the whole address from the browser, starting with http://')
        }
        login.pasted = parsed.toString()
        login.pasted_at = login.output.length
        login.child.stdin?.write(`${login.pasted}\n`)
        await this.until(login, () => login.state !== 'waiting' || this.rejected(login), COMPLETE_WAIT_MS)
        if (login.state === 'waiting') {
            const rest = this.rest(login)
            throw new Error(
                this.rejected(login)
                    ? (rest.at(-1) ?? 'The CLI did not accept that URL')
                    : 'The CLI has not answered yet: wait a moment and try again'
            )
        }
        if (login.state === 'failed') throw new Error(login.message ?? 'The sign-in failed')
        return this.view(login)
    }

    cancel(id: string): void {
        const login = this.logins.get(id)
        if (!login) return
        if (login.state === 'starting' || login.state === 'waiting') {
            login.state = 'cancelled'
            login.message = 'Cancelled.'
            this.signal(login, 'SIGTERM')
            login.timers.push(setTimeout(() => this.signal(login, 'SIGKILL'), KILL_GRACE_MS))
            this.notify(login)
        }
        login.timers.push(setTimeout(() => this.logins.delete(login.id), KEEP_DONE_MS))
    }

    /** Cancel every open sign-in (supervisor shutdown). */
    close(): void {
        for (const login of this.logins.values()) this.cancel(login.id)
        for (const login of this.logins.values()) for (const timer of login.timers) clearTimeout(timer)
        this.logins.clear()
    }

    /** Read the URL and the paste prompt out of what the CLI has printed so far. */
    private digest(login: Login): void {
        if (!login.url) {
            const match = URL_LINE.exec(login.output)
            if (match) login.url = match[1]
        }
        if (login.url && login.state === 'starting' && PROMPT.test(login.output)) {
            login.mode = 'redirect'
            login.state = 'waiting'
            login.message = null
        }
        this.notify(login)
    }

    /** A paste prompt printed after the last paste: the CLI did not take it. */
    private rejected(login: Login): boolean {
        return login.pasted !== null && PROMPT.test(login.output.slice(login.pasted_at))
    }

    /** The CLI's own lines after the URL: no prompts, no echo of the paste, no blank lines. */
    private rest(login: Login): string[] {
        const after = login.url ? login.output.slice(login.output.indexOf(login.url) + login.url.length) : login.output
        return after
            .split('\n')
            .map((line) => line.replace(/^Or paste the redirect URL here:\s*/i, '').trim())
            .filter(
                (line) =>
                    line &&
                    !/^Waiting for authorization/i.test(line) &&
                    !line.startsWith('[mcp-sdk]') &&
                    !(login.pasted && line.includes(login.pasted))
            )
    }

    private signal(login: Login, sig: NodeJS.Signals): void {
        const pid = login.child.pid
        if (!pid || login.child.exitCode !== null || login.child.signalCode !== null) return
        try {
            if (process.platform !== 'win32') process.kill(-pid, sig)
            else login.child.kill(sig)
        } catch {
            login.child.kill(sig)
        }
    }

    private notify(login: Login): void {
        for (const listener of login.listeners) listener()
    }

    private until(login: Login, ready: () => boolean, timeoutMs: number): Promise<void> {
        if (ready()) return Promise.resolve()
        return new Promise((resolve) => {
            const finish = () => {
                login.listeners.delete(listener)
                clearTimeout(timer)
                resolve()
            }
            const listener = () => ready() && finish()
            const timer = setTimeout(finish, timeoutMs)
            login.listeners.add(listener)
        })
    }

    private view(login: Login): McpLoginView {
        const { id, name, mode, state, url, message, started_at } = login
        return { id, name, mode, state, url, message, started_at }
    }
}
