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
        const [claude, gh, git] = await Promise.all([
            version('claude', ['--version']),
            version('gh', ['--version']),
            version('git', ['--version'])
        ])
        return c.json({
            stats: store.stats(),
            running: tasks.runningTaskIds(),
            claude: {
                version: claude,
                model: config.claude.model ?? null,
                permission_mode: config.claude.permissionMode,
                max_turns: config.claude.maxTurns,
                max_budget_usd: config.claude.maxBudgetUsd,
                config_dir: config.claude.configDir,
                logged_in: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) || fs.existsSync(path.join(config.claude.configDir, '.credentials.json'))
            },
            github: { cli: gh, token: Boolean(process.env.GH_TOKEN) },
            git: { version: git },
            telegram: { allowed_user_ids: [...config.telegram.allowedUserIds] },
            stt: { enabled: Boolean(config.stt.groqApiKey), model: config.stt.model, language: config.stt.language ?? null },
            paths: { data: config.paths.dataRoot, workspaces: config.paths.workspacesRoot, config: config.paths.configRoot },
            max_concurrent_sessions: config.maxConcurrentSessions,
            workspaces
        })
    })

    return app
}
