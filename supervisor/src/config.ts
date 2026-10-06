import path from 'node:path'

export interface Config {
    telegram: {
        /** Empty = Telegram disabled; the factory runs web-only. */
        botToken: string | undefined
        allowedUserIds: Set<number>
    }
    claude: {
        configDir: string
        maxTurns: number
        permissionMode: string
        /** Wall-clock limit per task in ms; 0 = none. */
        taskTimeoutMs: number
        /** How long a task stopped by the subscription limit may wait for the window to reset (0 = it fails instead). */
        autoContinueMs: number
    }
    paths: {
        dataRoot: string
        workspacesRoot: string
        configRoot: string
        dbFile: string
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
        /** Failed sign-ins from one address within `loginLockMinutes` that lock sign-in for as long. */
        loginMaxFailures: number
        loginLockMinutes: number
        /** Behind a reverse proxy: take the client address from X-Real-IP / X-Forwarded-For. */
        trustProxy: boolean
        /** Where the owner opens the UI, without a trailing slash; null = Telegram reports carry no links. */
        publicUrl: string | null
        distDir: string
    }
    presetsDir: string
    maxConcurrentSessions: number
    logLevel: 'debug' | 'info' | 'warn' | 'error'
    /** The owner's zone (`TIMEZONE`, UTC without it): cron expressions are read in it, and "today" starts at its midnight. */
    timezone: string
    schedules: {
        /** Cron firings are skipped while the 5-hour or weekly window is at or above this share (0..1); 0 = never. */
        softStop: number
        /** A firing the factory slept through still runs when it is at most this many minutes late; older ones are recorded as missed. */
        lateMinutes: number
        /** A scheduled run's question or permission request unanswered for this long is answered for the owner (deny / "no answer"); 0 = wait forever. */
        askTimeoutMs: number
    }
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
            allowedUserIds
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
            autoContinueMs: Math.max(0, number('CLAUDE_AUTO_CONTINUE_HOURS', 6)) * 3_600_000
        },
        paths: {
            dataRoot,
            // WORKSPACES_ROOT is set by the image; WORKSPACES_DIR is the host-side
            // .env value, reused here so `yarn dev` sees the same repositories.
            workspacesRoot:
                optional('WORKSPACES_ROOT') ?? optional('WORKSPACES_DIR') ?? path.join(dataRoot, 'workspaces'),
            configRoot: path.join(dataRoot, 'config'),
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
            loginMaxFailures: Math.max(1, Math.floor(number('WEB_LOGIN_MAX_FAILURES', 5))),
            loginLockMinutes: Math.max(1, number('WEB_LOGIN_LOCK_MIN', 10)),
            trustProxy: flag('WEB_TRUST_PROXY'),
            // The address the owner opens the UI at (https://factory.example.com): Telegram reports link to the task page then.
            publicUrl: optional('WEB_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
            distDir: optional('WEB_DIST') ?? path.resolve(process.cwd(), 'web', 'dist')
        },
        presetsDir: optional('PRESETS_DIR') ?? path.resolve(process.cwd(), 'presets'),
        maxConcurrentSessions: Math.max(1, Math.floor(number('MAX_CONCURRENT_SESSIONS', 2))),
        logLevel: logLevel(optional('LOG_LEVEL')),
        timezone: timeZone(optional('TIMEZONE') ?? 'UTC'),
        schedules: {
            softStop: share('SCHEDULES_SOFT_STOP', 0.85),
            lateMinutes: Math.max(0, Math.floor(number('SCHEDULES_LATE_MIN', 5))),
            askTimeoutMs: Math.max(0, number('SCHEDULES_ASK_TIMEOUT_MIN', 120)) * 60_000
        }
    }
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
