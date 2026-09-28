import path from 'node:path'

export interface Config {
    telegram: {
        botToken: string
        allowedUserIds: Set<number>
    }
    claude: {
        configDir: string | undefined
        model: string | undefined
        maxTurns: number
        maxBudgetUsd: number
        permissionMode: string
    }
    paths: {
        dataRoot: string
        workspacesRoot: string
    }
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
    const allowedUserIds = new Set(
        required('TELEGRAM_ALLOWED_USER_IDS')
            .split(',')
            .map((id) => Number(id.trim()))
            .filter((id) => Number.isInteger(id) && id > 0)
    )
    if (allowedUserIds.size === 0) {
        throw new Error('TELEGRAM_ALLOWED_USER_IDS must contain at least one numeric Telegram user id')
    }

    const dataRoot = optional('DATA_ROOT') ?? path.resolve(process.cwd(), 'data')

    return {
        telegram: {
            botToken: required('TELEGRAM_BOT_TOKEN'),
            allowedUserIds
        },
        claude: {
            configDir: optional('CLAUDE_CONFIG_DIR'),
            model: optional('CLAUDE_MODEL'),
            maxTurns: number('CLAUDE_MAX_TURNS', 50),
            maxBudgetUsd: number('CLAUDE_MAX_BUDGET_USD', 5),
            permissionMode: optional('CLAUDE_PERMISSION_MODE') ?? 'acceptEdits'
        },
        paths: {
            dataRoot,
            workspacesRoot: optional('WORKSPACES_ROOT') ?? path.join(dataRoot, 'workspaces')
        },
        logLevel: (optional('LOG_LEVEL') as Config['logLevel']) ?? 'info'
    }
}
