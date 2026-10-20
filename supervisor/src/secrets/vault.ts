import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { tokenVarProblem } from '../files/providers.js'
import { createLogger } from '../logger.js'
import { hostOnly } from '../sandbox/executor.js'

const log = createLogger('vault')

/**
 * Secrets and variables the owner sets in the UI (Settings → Secrets and
 * variables), as GitHub Actions has them: a **secret** is written and never
 * read back (the API lists its name, scope and date, never the value) and is
 * masked in everything the factory stores; a **variable** is plain
 * configuration whose value shows (a Trac URL, a counter id). Both reach the
 * environment of the steps, the sources and the agent's CLI of the runs in
 * their scope. One JSON file, mode 0600, in its own directory outside
 * `config/` (which gets copied around); a name here wins over `.env`.
 *
 * A **provider key** (`provider: true`, access "model providers only") is a
 * secret no run gets: a provider names it as its `token` and only the gateway
 * reads it (keys never reach an agent). Like secret / variable, a name stays
 * a provider key or a run's entry for life.
 */

export type Scope = { all: true } | { all: false; routines: string[]; projects: string[] }

interface Stored {
    value: string
    secret: boolean
    scope: Scope
    /** A provider's key: the gateway's only, never a run's. */
    provider?: true
    created_at: string
    updated_at: string
}

/** What the API shows: a secret's value never leaves the vault. */
export interface VaultEntry {
    name: string
    secret: boolean
    /** Only for a variable. */
    value?: string
    scope: Scope
    /** A provider's key (set in Settings → Providers): it reaches no run. */
    provider?: true
    created_at: string
    updated_at: string
}

/** Where a run's values may go: the routine it belongs to and the project it works on. */
export interface ScopeContext {
    routine?: string | null
    project?: string | null
}

export class VaultError extends Error {}

/** A change the owner hears about in Telegram, like a sign-in. */
export interface VaultChange {
    action: 'added' | 'updated' | 'deleted'
    name: string
    secret: boolean
    /** The address the change came from. */
    from: string | null
}

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/

/**
 * Names the vault refuses: the factory's own (they belong to the supervisor), the ones it
 * sets for a run itself, and those that change how a shell or a runtime starts (a value
 * there runs code before the script does).
 */
const RESERVED = new Set([
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'PWD',
    'TERM',
    'LANG',
    'TZ',
    'ENV',
    'BASH_ENV',
    'IFS',
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PERL5OPT',
    'RUBYOPT',
    'GIT_SSH_COMMAND',
    'GIT_SSH',
    'GIT_ASKPASS',
    'GIT_EXEC_PATH',
    'GIT_PROXY_COMMAND',
    'GIT_EXTERNAL_DIFF',
    'GIT_PAGER',
    'GIT_EDITOR',
    'SSH_ASKPASS',
    'SSH_AUTH_SOCK',
    'PROMPT_COMMAND',
    'PS4',
    'SHELLOPTS',
    'BASHOPTS',
    'PAGER',
    'EDITOR',
    'VISUAL',
    'JAVA_TOOL_OPTIONS',
    'PERL5LIB',
    'RUBYLIB',
    'GCONV_PATH',
    'OPENSSL_CONF',
    'TMPDIR',
    'ROUTINE',
    'ROUTINE_FILE',
    'ROUTINE_DIR',
    'PROJECT',
    'PROJECT_DIR',
    'SKILL_DIR',
    'DATA_ROOT',
    'WORKSPACES_ROOT',
    'WORKSPACES_DIR',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ALLOWED_USER_IDS',
    'WEB_AUTH_USER',
    'WEB_AUTH_PASSWORD',
    'GROQ_API_KEY'
])
const RESERVED_PREFIXES = [
    'LD_',
    'DYLD_',
    'CLAUDE_',
    'ANTHROPIC_',
    'MISE_',
    'DOCKER_',
    'WEB_',
    'TELEGRAM_',
    'NPM_CONFIG_',
    'GIT_CONFIG'
]

/** Values shorter than this are not masked: "on", "1", a port would turn every log into dots. */
const MASK_MIN = 6
export const MASK = '••••'

export class Vault extends EventEmitter<{ change: [change: VaultChange] }> {
    private cache: { mtime: number; data: Record<string, Stored> } | null = null
    private masks: { data: Record<string, Stored>; values: string[] } | null = null

    /** `extraReserved`: names a run's entry must not take (the ones providers name as their keys). */
    constructor(
        readonly file: string,
        private readonly extraReserved: () => string[] = () => []
    ) {
        super()
    }

    /** Why a name cannot be stored, or null. */
    refusal(name: string): string | null {
        if (!NAME.test(name)) return 'use capital letters, digits and _, not starting with a digit (up to 64)'
        if (RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p)))
            return `${name} is reserved: the factory sets it or owns it`
        if (hostOnly(name)) return `${name} is reserved: it stays with the supervisor and never reaches a sandbox`
        if (this.extraReserved().includes(name) || this.read()[name]?.provider)
            return `${name} is a provider's key: its access is "model providers only"`
        return null
    }

    /** Why a name cannot hold a provider's key, or null: the key-name rules, and no run's entry of that name. */
    providerRefusal(name: string): string | null {
        const problem = tokenVarProblem(name)
        if (problem) return problem
        const current = this.read()[name]
        if (current && !current.provider)
            return `${name} is a ${current.secret ? 'secret' : 'variable'} for runs, not a provider key`
        return null
    }

    /** A provider's key held here; null when the vault has none of that name. */
    providerKey(name: string): string | null {
        const s = this.read()[name]
        return s?.provider ? s.value || null : null
    }

    list(): VaultEntry[] {
        return Object.entries(this.read())
            .map(([name, s]) => view(name, s))
            .sort((a, b) => a.name.localeCompare(b.name))
    }

    get(name: string): VaultEntry | null {
        const s = this.read()[name]
        return s ? view(name, s) : null
    }

    has(name: string): boolean {
        return name in this.read()
    }

    /**
     * Create or change an entry. A new one needs a value; an existing secret keeps its value
     * when none is given (only the scope changes). A name stays a secret or a variable for life:
     * turning a secret into a variable would show its value.
     */
    set(
        name: string,
        patch: { value?: string; secret?: boolean; scope?: Scope; provider?: boolean },
        from: string | null = null
    ): VaultEntry {
        const data = { ...this.read() }
        const current = data[name]
        const provider = current ? Boolean(current.provider) : Boolean(patch.provider)
        if (current && patch.provider !== undefined && patch.provider !== provider)
            throw new VaultError(
                provider
                    ? `${name} is a provider key: delete it and add a secret for runs`
                    : `${name} is a ${current.secret ? 'secret' : 'variable'} for runs: delete it and add a provider key`
            )
        const refused = provider ? this.providerRefusal(name) : this.refusal(name)
        if (refused) throw new VaultError(refused)
        if (!current && patch.value === undefined) throw new VaultError('a value is required')
        if (current && patch.secret !== undefined && patch.secret !== current.secret)
            throw new VaultError(
                current.secret
                    ? `${name} is a secret: delete it and add a variable to make the value visible`
                    : `${name} is a variable: delete it and add a secret`
            )
        if (patch.value !== undefined) {
            if (patch.value.length > 64 * 1024) throw new VaultError('the value is larger than 64 KB')
            if (patch.value.includes('\0')) throw new VaultError('the value contains a NUL byte')
            if (provider && /[\r\n]/.test(patch.value.trim())) throw new VaultError("a provider's key is one line")
        }
        const at = new Date().toISOString()
        data[name] = {
            value: provider && patch.value !== undefined ? patch.value.trim() : (patch.value ?? current.value),
            // A provider key is a secret with no run in its scope: the gateway is its only reader.
            secret: provider || (current?.secret ?? patch.secret ?? true),
            scope: provider
                ? { all: false, routines: [], projects: [] }
                : normalizeScope(patch.scope ?? current?.scope ?? { all: true }),
            ...(provider ? { provider: true as const } : {}),
            created_at: current?.created_at ?? at,
            updated_at: at
        }
        this.write(data)
        this.emit('change', { action: current ? 'updated' : 'added', name, secret: data[name].secret, from })
        return view(name, data[name])
    }

    remove(name: string, from: string | null = null): boolean {
        const data = { ...this.read() }
        const current = data[name]
        if (!current) return false
        delete data[name]
        this.write(data)
        this.emit('change', { action: 'deleted', name, secret: current.secret, from })
        return true
    }

    /** The values for a run: everything scoped to all, plus what names its routine or project. */
    envFor(ctx: ScopeContext = {}): Record<string, string> {
        const out: Record<string, string> = {}
        for (const [name, s] of Object.entries(this.read()))
            if (!s.provider && inScope(s.scope, ctx)) out[name] = s.value
        return out
    }

    /** Whether a name reaches a run of that routine / project. */
    reaches(name: string, ctx: ScopeContext): boolean {
        const s = this.read()[name]
        return Boolean(s && !s.provider && inScope(s.scope, ctx))
    }

    /** Every secret value long enough to mask, longest first (a value inside another is masked by the longer one). */
    private maskValues(): string[] {
        const data = this.read()
        // Built once per version of the file: the store masks every string of every event.
        if (this.masks?.data === data) return this.masks.values
        const values = Object.values(data)
            .filter((s) => s.secret && s.value.trim().length >= MASK_MIN)
            .flatMap((s) => {
                // A value pasted with a trailing newline (or CRLF) is printed without it: mask the bare value
                // too. A multi-line value (a key file) is also masked line by line: a script may print one line.
                const lines = s.value
                    .split('\n')
                    .map((l) => l.replace(/\r$/, ''))
                    .filter((l) => l.trim().length >= MASK_MIN)
                return [s.value, s.value.trim(), ...(lines.length > 1 ? lines : [])]
            })
        const unique = [...new Set(values)].sort((a, b) => b.length - a.length)
        this.masks = { data, values: unique }
        return unique
    }

    /** The text with every secret value replaced by the mask, as CI logs do. */
    redact(text: string): string {
        if (!text) return text
        let out = text
        for (const value of this.maskValues()) if (out.includes(value)) out = out.split(value).join(MASK)
        return out
    }

    /** Whether there is anything to mask at all (the store skips the work otherwise). */
    hasSecrets(): boolean {
        return this.maskValues().length > 0
    }

    // ---- the file -----------------------------------------------------------

    private read(): Record<string, Stored> {
        let fd: number
        try {
            fd = fs.openSync(this.file, 'r')
        } catch {
            this.cache = { mtime: 0, data: {} }
            return this.cache.data
        }
        try {
            // The descriptor's own stat: the version compared is the version read.
            const stat = fs.fstatSync(fd)
            if (this.cache && this.cache.mtime === stat.mtimeMs) return this.cache.data
            let parsed: { entries?: Record<string, Stored> }
            try {
                parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as { entries?: Record<string, Stored> }
            } catch (error) {
                // Nothing is masked without the file, so nothing goes on: the error names the file to fix.
                throw new Error(
                    `${this.file} is not valid JSON (${error instanceof Error ? error.message : String(error)}): fix or remove it`,
                    { cause: error }
                )
            }
            this.cache = { mtime: stat.mtimeMs, data: parsed.entries ?? {} }
            return this.cache.data
        } finally {
            fs.closeSync(fd)
        }
    }

    /** Atomically, owner-only: a temporary file in the same directory, renamed over the old one. */
    private write(data: Record<string, Stored>): void {
        const dir = path.dirname(this.file)
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        try {
            fs.chmodSync(dir, 0o700)
        } catch {
            // a directory we do not own keeps its mode; the file's own mode still holds
        }
        const tmp = `${this.file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: data }, null, 2)}\n`, { mode: 0o600 })
        fs.renameSync(tmp, this.file)
        this.cache = null
    }
}

function view(name: string, s: Stored): VaultEntry {
    return {
        name,
        secret: s.secret,
        ...(s.secret ? {} : { value: s.value }),
        scope: s.scope,
        ...(s.provider ? { provider: true as const } : {}),
        created_at: s.created_at,
        updated_at: s.updated_at
    }
}

function normalizeScope(scope: Scope): Scope {
    if (scope.all) return { all: true }
    const clean = (list: unknown) =>
        [...new Set((Array.isArray(list) ? list : []).filter((x): x is string => typeof x === 'string' && !!x))].sort()
    return { all: false, routines: clean(scope.routines), projects: clean(scope.projects) }
}

function inScope(scope: Scope, ctx: ScopeContext): boolean {
    if (scope.all) return true
    return (
        (Boolean(ctx.routine) && scope.routines.includes(ctx.routine!)) ||
        (Boolean(ctx.project) && scope.projects.includes(ctx.project!))
    )
}

/** `$NAME` and `${NAME}` in a text (a script, a command, a config): the variables it reads. */
export function referencedNames(text: string): string[] {
    const names = new Set<string>()
    for (const m of text.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) names.add(m[1])
    return [...names]
}

/**
 * Once, at start: a provider key still in `.env` (the way before 1.7.0) moves into the vault as a
 * provider key, so the line can go from `.env`. A name the vault holds already is left alone.
 */
export function migrateEnvKeys(vault: Vault, names: string[], env: NodeJS.ProcessEnv = process.env): string[] {
    const moved: string[] = []
    for (const name of new Set(names)) {
        const value = env[name]?.trim()
        if (!value || vault.has(name) || vault.providerRefusal(name)) continue
        // A value the vault refuses (a line break, too long) must not stop the supervisor starting.
        try {
            vault.set(name, { value, provider: true }, '.env')
            moved.push(name)
        } catch (error) {
            log.warn(
                `provider key ${name} not moved from .env: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
    return moved
}
