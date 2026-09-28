import path from 'node:path'

export interface Config {
    telegram: {
        /** Empty = Telegram disabled; the factory runs web-only. */
        botToken: string | undefined
        allowedUserIds: Set<number>
    }
    claude: {
        configDir: string
        model: string | undefined
        maxTurns: number
        maxBudgetUsd: number
        permissionMode: string
        /** Wall-clock limit per task in ms; 0 = none. */
        taskTimeoutMs: number
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
        authPassword: string | undefined
        /** Host names the API answers to when no password is set (DNS-rebinding guard). */
        allowedHosts: Set<string>
        distDir: string
    }
    presetsDir: string
    maxConcurrentSessions: number
    logLevel: 'debug' | 'info' | 'warn' | 'error'
}

function required(name: string): string {
    const value = process.env[name]?.trim()
    if (!value) {
        throw new Error(`Missing required environment variable ${name}`)
    }
    return value
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
            model: optional('CLAUDE_MODEL'),
            maxTurns: number('CLAUDE_MAX_TURNS', 50),
            maxBudgetUsd: number('CLAUDE_MAX_BUDGET_USD', 5),
            permissionMode: optional('CLAUDE_PERMISSION_MODE') ?? 'acceptEdits',
            taskTimeoutMs: number('CLAUDE_TASK_TIMEOUT_MIN', 0) * 60_000
        },
        paths: {
            dataRoot,
            // WORKSPACES_ROOT is set by the image; WORKSPACES_DIR is the host-side
            // .env value, reused here so `yarn dev` sees the same repositories.
            workspacesRoot: optional('WORKSPACES_ROOT') ?? optional('WORKSPACES_DIR') ?? path.join(dataRoot, 'workspaces'),
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
            distDir: optional('WEB_DIST') ?? path.resolve(process.cwd(), 'web', 'dist')
        },
        presetsDir: optional('PRESETS_DIR') ?? path.resolve(process.cwd(), 'presets'),
        maxConcurrentSessions: number('MAX_CONCURRENT_SESSIONS', 2),
        logLevel: (optional('LOG_LEVEL') as Config['logLevel']) ?? 'info'
    }
}
