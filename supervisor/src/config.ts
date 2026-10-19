import path from 'node:path'

export interface Config {
    telegram: {
        /** Empty = Telegram disabled; the factory runs web-only. */
        botToken: string | undefined
        allowedUserIds: Set<number>
        /** A web task's reply unread (or its question unanswered) in the web this long goes to Telegram; 0 = never. */
        webNotifyAfterMs: number
    }
    claude: {
        configDir: string
        maxTurns: number
        permissionMode: string
        /** Wall-clock limit per task in ms; 0 = none. */
        taskTimeoutMs: number
        /** How long a task stopped by the subscription limit may wait for the window to reset (0 = it fails instead). */
        autoContinueMs: number
        /** A new web or Telegram chat is named by one small Haiku call (`CHAT_TITLES=haiku`); off = its first line. */
        chatTitles: boolean
    }
    paths: {
        dataRoot: string
        workspacesRoot: string
        configRoot: string
        dbFile: string
        vaultFile: string
    }
    stt: {
        groqApiKey: string | undefined
        model: string
        language: string | undefined
    }
    web: {
        host: string
        port: number
        authUser: string
        /** Empty = open mode: no sign-in, the API answers only to local host names (`allowedHosts`). */
        authPassword: string | undefined
        /** Host names the API answers to when no password is set (DNS-rebinding guard). */
        allowedHosts: Set<string>
        /** A browser session lives this long since it was last used. */
        sessionDays: number
        /** A session the owner has not used for this long ends; 0 = only `sessionDays`. */
        sessionIdleHours: number
        /** Failed sign-ins from one address within `loginLockMinutes` that lock sign-in for as long. */
        loginMaxFailures: number
        loginLockMinutes: number
        /** Behind a reverse proxy: take the client address from X-Real-IP / X-Forwarded-For. */
        trustProxy: boolean
        /** Where the owner opens the UI, without a trailing slash; null = Telegram reports carry no links. */
        publicUrl: string | null
        distDir: string
    }
    /** Where the agents run: a Docker Sandbox per project (`sbx`), or the supervisor itself (`local`: yarn dev, tests). */
    sandbox: {
        mode: 'sbx' | 'local'
        /** `--memory` of a new sandbox (`8g`); empty = sbx's default (half the host). */
        memory: string
        /** `--cpus` of a new sandbox; 0 = all of the host's. */
        cpus: number
        /** A sandbox nothing ran in for this long is stopped (its state stays); 0 = never. */
        idleMs: number
        /** The supervisor as a VM reaches it: the gateway and the factory's MCP server for tasks in a sandbox. */
        factoryUrl: string
        /** Where the git / gh wrappers live that every sandbox gets a copy of (the image's /usr/local/bin). */
        helpersDir: string | null
        /** The host user's home: sbx finds its daemon socket and its stores under it. */
        home: string | undefined
        /** git's identity inside the sandboxes (`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`). */
        gitIdentity: { name: string | undefined; email: string | undefined }
    }
    /** An app the agent runs, shown at `/preview/<project>/` through the factory. */
    preview: {
        /** Host ports a sandbox's app is published on, first and last. */
        ports: [number, number]
        /** The host address a published port binds to: reachable from the supervisor's container, not from the LAN. */
        bind: string
        /** How the supervisor reaches that address (the host gateway from inside its container). */
        upstreamHost: string
        /** A preview nobody stopped ends after this long; 0 = never. */
        ttlMs: number
    }
    presetsDir: string
    maxConcurrentSessions: number
    logLevel: 'debug' | 'info' | 'warn' | 'error'
    /** The owner's zone (`TIMEZONE`, UTC without it): cron expressions are read in it, and "today" starts at its midnight. */
    timezone: string
    routines: {
        /** Cron firings are skipped while the 5-hour or weekly window is at or above this share (0..1); 0 = never. */
        softStop: number
        /** A firing the factory slept through still runs when it is at most this many minutes late; older ones are recorded as missed. */
        lateMinutes: number
        /** A routine run's question or permission request unanswered for this long is answered for the owner (deny / "no answer"); 0 = wait forever. */
        askTimeoutMs: number
    }
}

/** The first of the names that is set in the environment (a renamed variable keeps its old name working), else the first. */
function either(name: string, ...older: string[]): string {
    return [name, ...older].find((n) => optional(n) !== undefined) ?? name
}

function optional(name: string): string | undefined {
    const value = process.env[name]?.trim()
    return value ? value : undefined
}

function number(name: string, fallback: number): number {
    const raw = optional(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
        throw new Error(`Environment variable ${name} must be a number, got "${raw}"`)
    }
    return parsed
}

export function loadConfig(): Config {
    const botToken = optional('TELEGRAM_BOT_TOKEN')
    const allowedUserIds = new Set(
        (optional('TELEGRAM_ALLOWED_USER_IDS') ?? '')
            .split(',')
            .map((id) => Number(id.trim()))
            .filter((id) => Number.isInteger(id) && id > 0)
    )
    if (botToken && allowedUserIds.size === 0) {
        throw new Error('TELEGRAM_ALLOWED_USER_IDS must contain at least one numeric Telegram user id')
    }

    const dataRoot = optional('DATA_ROOT') ?? path.resolve(process.cwd(), 'data')

    return {
        telegram: {
            botToken,
            allowedUserIds,
            webNotifyAfterMs: Math.max(0, number('TELEGRAM_WEB_NOTIFY_MIN', 2)) * 60_000
        },
        claude: {
            // Also used outside Docker: with CLAUDE_CODE_OAUTH_TOKEN in .env the
            // CLI is logged in there too, and the UI edits the same files.
            configDir: optional('CLAUDE_CONFIG_DIR') ?? path.join(dataRoot, 'claude'),
            maxTurns: number('CLAUDE_MAX_TURNS', 50),
            permissionMode: optional('CLAUDE_PERMISSION_MODE') ?? 'acceptEdits',
            taskTimeoutMs: number('CLAUDE_TASK_TIMEOUT_MIN', 0) * 60_000,
            // A task the subscription limit stopped waits in the queue for the window to reset and
            // continues, when the reset is at most this far away (the weekly window usually is not). 0 = off.
            autoContinueMs: Math.max(0, number('CLAUDE_AUTO_CONTINUE_HOURS', 6)) * 3_600_000,
            chatTitles: (optional('CHAT_TITLES') ?? 'haiku').toLowerCase() !== 'off'
        },
        paths: {
            dataRoot,
            // WORKSPACES_ROOT is set by the image; WORKSPACES_DIR is the host-side
            // .env value, reused here so `yarn dev` sees the same repositories.
            workspacesRoot:
                optional('WORKSPACES_ROOT') ?? optional('WORKSPACES_DIR') ?? path.join(dataRoot, 'workspaces'),
            configRoot: path.join(dataRoot, 'config'),
            // Secrets and variables set in the UI: owner-only, outside config/ (which gets copied around).
            vaultFile: path.join(dataRoot, 'vault', 'secrets.json'),
            dbFile: path.join(dataRoot, 'db', 'factory.sqlite')
        },
        stt: {
            groqApiKey: optional('GROQ_API_KEY'),
            model: optional('STT_MODEL') ?? 'whisper-large-v3-turbo',
            language: optional('STT_LANGUAGE')
        },
        web: {
            host: optional('WEB_HOST') ?? '0.0.0.0',
            port: number('WEB_PORT', 8080),
            authUser: optional('WEB_AUTH_USER') ?? 'factory',
            authPassword: optional('WEB_AUTH_PASSWORD'),
            allowedHosts: new Set(
                (optional('WEB_ALLOWED_HOSTS') ?? '')
                    .split(',')
                    .map((h) => h.trim().toLowerCase())
                    .filter(Boolean)
            ),
            sessionDays: Math.max(1, number('WEB_SESSION_DAYS', 30)),
            // A session the owner has not used for this long signs itself out; 0 = only the days above.
            sessionIdleHours: Math.max(0, number('WEB_SESSION_IDLE_HOURS', 8)),
            loginMaxFailures: Math.max(1, Math.floor(number('WEB_LOGIN_MAX_FAILURES', 5))),
            loginLockMinutes: Math.max(1, number('WEB_LOGIN_LOCK_MIN', 10)),
            trustProxy: flag('WEB_TRUST_PROXY'),
            // The address the owner opens the UI at (https://factory.example.com): Telegram reports link to the task page then.
            publicUrl: optional('WEB_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
            distDir: optional('WEB_DIST') ?? path.resolve(process.cwd(), 'web', 'dist')
        },
        sandbox: {
            mode: sandboxMode(optional('SANDBOX')),
            memory: optional('SANDBOX_MEMORY') ?? '8g',
            cpus: Math.max(0, Math.floor(number('SANDBOX_CPUS', 0))),
            idleMs: Math.max(0, number('SANDBOX_IDLE_MIN', 60)) * 60_000,
            factoryUrl: (
                optional('SANDBOX_FACTORY_URL') ?? `http://host.docker.internal:${number('WEB_PORT', 8080)}`
            ).replace(/\/+$/, ''),
            helpersDir: optional('SANDBOX_HELPERS_DIR') ?? null,
            home: optional('SBX_HOME'),
            gitIdentity: { name: optional('GIT_AUTHOR_NAME'), email: optional('GIT_AUTHOR_EMAIL') }
        },
        preview: {
            ports: portRange(optional('PREVIEW_PORTS') ?? '18100-18199'),
            bind: optional('PREVIEW_BIND') ?? '172.17.0.1',
            upstreamHost: optional('PREVIEW_UPSTREAM') ?? 'host.docker.internal',
            ttlMs: Math.max(0, number('PREVIEW_TTL_HOURS', 24)) * 3_600_000
        },
        presetsDir: optional('PRESETS_DIR') ?? path.resolve(process.cwd(), 'presets'),
        maxConcurrentSessions: Math.max(1, Math.floor(number('MAX_CONCURRENT_SESSIONS', 2))),
        logLevel: logLevel(optional('LOG_LEVEL')),
        timezone: timeZone(optional('TIMEZONE') ?? 'UTC'),
        // ROUTINES_* since 1.5.0; the SCHEDULES_* names of a .env written before still count.
        routines: {
            softStop: share(either('ROUTINES_SOFT_STOP', 'SCHEDULES_SOFT_STOP'), 0.85),
            lateMinutes: Math.max(0, Math.floor(number(either('ROUTINES_LATE_MIN', 'SCHEDULES_LATE_MIN'), 5))),
            askTimeoutMs:
                Math.max(0, number(either('ROUTINES_ASK_TIMEOUT_MIN', 'SCHEDULES_ASK_TIMEOUT_MIN'), 120)) * 60_000
        }
    }
}

function sandboxMode(raw: string | undefined): Config['sandbox']['mode'] {
    if (raw === undefined) return 'local'
    if (raw === 'sbx' || raw === 'local') return raw
    throw new Error(`SANDBOX must be sbx or local, got "${raw}"`)
}

/** `18100-18199`: the first and the last port, inclusive. */
function portRange(raw: string): [number, number] {
    const match = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(raw)
    const [first, last] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN]
    if (!(first >= 1024 && last <= 65535 && first <= last))
        throw new Error(`PREVIEW_PORTS must be a range like 18100-18199, got "${raw}"`)
    return [first, last]
}

/** A boolean switch: 1 / true / yes / on. */
function flag(name: string): boolean {
    const raw = optional(name)?.toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function timeZone(tz: string): string {
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz })
        return tz
    } catch {
        throw new Error(`TIMEZONE must be an IANA time zone name (Europe/Warsaw), got "${tz}"`)
    }
}

/** A share 0..1, also accepted as a percentage (85 → 0.85). */
function share(name: string, fallback: number): number {
    const value = number(name, fallback)
    const normalized = value > 1 ? value / 100 : value
    if (normalized < 0 || normalized > 1)
        throw new Error(`${name} must be between 0 and 1 (or 0 and 100), got "${value}"`)
    return normalized
}

function logLevel(raw: string | undefined): Config['logLevel'] {
    if (raw === undefined) return 'info'
    if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
    throw new Error(`LOG_LEVEL must be debug, info, warn or error, got "${raw}"`)
}
