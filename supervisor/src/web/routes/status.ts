import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { Hono } from 'hono'

import type { Env } from '../context.js'

const run = promisify(execFile)

async function version(cmd: string, args: string[]): Promise<string | null> {
    try {
        const { stdout } = await run(cmd, args, { timeout: 10_000 })
        return stdout.trim().split('\n')[0]
    } catch {
        return null
    }
}

/**
 * The CLI versions change only with the image, yet /status is polled by the
 * sidebar and the Overview every few seconds: spawn the three processes once
 * per TTL, not per request.
 */
const VERSIONS_TTL_MS = 10 * 60_000
let versions: { at: number; value: Promise<[string | null, string | null, string | null]> } | null = null

function toolVersions(): Promise<[string | null, string | null, string | null]> {
    if (!versions || Date.now() - versions.at > VERSIONS_TTL_MS) {
        versions = { at: Date.now(), value: Promise.all([version('claude', ['--version']), version('gh', ['--version']), version('git', ['--version'])]) }
    }
    return versions.value
}

/** Owners with a token of their own (GH_TOKEN_<OWNER>), as the env suffix lower-cased. */
function tokenOwners(): string[] {
    return Object.keys(process.env)
        .filter((key) => key.startsWith('GH_TOKEN_') && process.env[key])
        .map((key) => key.slice('GH_TOKEN_'.length).toLowerCase())
        .sort()
}

/** What `.credentials.json` holds: a claude.ai login (with its subscription type), or nothing usable. */
function loginOf(configDir: string): 'none' | `claude.ai (${string})` {
    try {
        const creds = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { subscriptionType?: string; scopes?: string[] } }
        const oauth = creds.claudeAiOauth
        if (!oauth) return 'none'
        return `claude.ai (${[oauth.subscriptionType ?? 'subscription', oauth.scopes?.includes('user:mcp_servers') ? 'connectors' : 'no connectors'].join(', ')})`
    } catch {
        return 'none'
    }
}

export function statusRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', async (c) => {
        const { config, store, tasks } = c.get('app')
        const workspaces = fs.existsSync(config.paths.workspacesRoot)
            ? fs
                  .readdirSync(config.paths.workspacesRoot, { withFileTypes: true })
                  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                  .map((entry) => ({
                      name: entry.name,
                      git: fs.existsSync(path.join(config.paths.workspacesRoot, entry.name, '.git'))
                  }))
            : []
        const [claude, gh, git] = await toolVersions()
        return c.json({
            stats: store.stats(),
            running: tasks.runningTaskIds(),
            limits: tasks.limits() ?? null,
            claude: {
                version: claude,
                model: config.claude.model ?? null,
                permission_mode: config.claude.permissionMode,
                max_turns: config.claude.maxTurns,
                max_budget_usd: config.claude.maxBudgetUsd,
                config_dir: config.claude.configDir,
                logged_in: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) || loginOf(config.claude.configDir) !== 'none',
                // `claude.ai`: a full login in the container (connectors available); `token`: CLAUDE_CODE_OAUTH_TOKEN (model calls only).
                login: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'token' : loginOf(config.claude.configDir)
            },
            github: { cli: gh, token: Boolean(process.env.GH_TOKEN), owners: tokenOwners() },
            git: { version: git },
            telegram: { enabled: Boolean(config.telegram.botToken), allowed_user_ids: [...config.telegram.allowedUserIds] },
            stt: { enabled: Boolean(config.stt.groqApiKey), model: config.stt.model, language: config.stt.language ?? null },
            paths: { data: config.paths.dataRoot, workspaces: config.paths.workspacesRoot, config: config.paths.configRoot },
            max_concurrent_sessions: config.maxConcurrentSessions,
            workspaces
        })
    })

    return app
}
