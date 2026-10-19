import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { Hono } from 'hono'

import { startOfDay } from '../../routines/cron.js'
import { VERSION } from '../../version.js'
import type { AppContext, Env } from '../context.js'

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
        versions = {
            at: Date.now(),
            value: Promise.all([
                version('claude', ['--version']),
                version('gh', ['--version']),
                version('git', ['--version'])
            ])
        }
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
        const creds = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')) as {
            claudeAiOauth?: { subscriptionType?: string; scopes?: string[] }
        }
        const oauth = creds.claudeAiOauth
        if (!oauth) return 'none'
        return `claude.ai (${[oauth.subscriptionType ?? 'subscription', oauth.scopes?.includes('user:mcp_servers') ? 'connectors' : 'no connectors'].join(', ')})`
    } catch {
        return 'none'
    }
}

/** The Overview's Models card: tokens per backend and each provider's state. */
function modelsOverview({ store, tasks }: AppContext, dayStart: string) {
    const usage = store.usageByProvider(dayStart)
    const empty = { tasks_today: 0, tokens_today: 0, tokens_total: 0, delegated_total: 0, last_task_at: null }
    const of = (provider: string | null) => {
        const { provider: _p, ...rest } = usage.find((u) => u.provider === provider) ?? { provider, ...empty }
        return rest
    }
    const providers = tasks.providerStatus().map((p) => ({
        name: p.name,
        kind: p.kind,
        url: p.url,
        model: p.default ?? p.models[0] ?? null,
        concurrency: p.concurrency,
        running: p.running,
        reach: tasks.providerReach(p),
        // What the gateway saw on the last forwarded request (a model call), if any since start.
        last_request: p.health?.at ? { at: p.health.at, ok: p.health.ok, error: p.health.error } : null,
        ...of(p.name)
    }))
    // Providers removed from providers.yaml still carry their tokens.
    const gone = usage.filter((u) => u.provider && !providers.some((p) => p.name === u.provider))
    return {
        subscription: { model: tasks.model(), ...of(null) },
        providers,
        removed: gone.map((u) => ({ name: u.provider!, tokens_today: u.tokens_today, tokens_total: u.tokens_total }))
    }
}

export function statusRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.get('/', async (c) => {
        const { config, store, tasks, sandboxes, previews, providers } = c.get('app')
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
        // Answered from the manager's cache; a dead daemon is refreshed in the background, never awaited here.
        const sandbox = sandboxes.status()
        const sandboxed = sandbox.mode === 'sbx'
        const mcpServers = tasks.mcpRegistry()
        const mcp = {
            total: mcpServers.length,
            connected: mcpServers.filter((s) => s.status === 'connected').length,
            needs_auth: mcpServers.filter((s) => s.status === 'needs-auth').map((s) => s.label),
            failed: mcpServers.filter((s) => s.status === 'failed').map((s) => s.label)
        }
        const routines = c.get('app').routines.list()
        const upcoming = routines.filter((s) => s.next_run).sort((a, b) => a.next_run!.localeCompare(b.next_run!))[0]
        return c.json({
            version: VERSION,
            stats: {
                ...store.stats(startOfDay(new Date(), config.timezone).toISOString()),
                routines: {
                    total: routines.length,
                    on: routines.filter((s) => s.enabled && !s.errors.length).length,
                    // What needs the owner: an invalid file, a step that fails, a run the factory slept through.
                    invalid: routines.filter((s) => s.errors.length).length,
                    failing: routines
                        .filter((s) => !s.errors.length && s.last_run?.status === 'error')
                        .map((s) => s.name),
                    missed: routines.filter((s) => s.last_run?.status === 'missed').map((s) => s.name),
                    next: upcoming ? { name: upcoming.name, at: upcoming.next_run } : null
                }
            },
            running: tasks.runningTaskIds(),
            // Every backend the tasks run on: the subscription first, then each provider with whether
            // it answers now (a cheap check, refreshed in the background), its load and its tokens.
            models: modelsOverview(c.get('app'), startOfDay(new Date(), config.timezone).toISOString()),
            limits: tasks.limits() ?? null,
            claude: {
                // In sandbox mode the CLI is Docker's, inside each sandbox: the supervisor has none.
                version: sandboxed ? null : claude,
                model: tasks.model(),
                permission_mode: config.claude.permissionMode,
                max_turns: config.claude.maxTurns,
                config_dir: config.claude.configDir,
                logged_in: sandboxed
                    ? sandbox.claude_login === true
                    : Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) || loginOf(config.claude.configDir) !== 'none',
                // `sandbox`: the login the sandboxes' proxy holds; `claude.ai`: a full login of this machine's CLI
                // (connectors available); `token`: CLAUDE_CODE_OAUTH_TOKEN (model calls only).
                login: sandboxed
                    ? sandbox.claude_login
                        ? 'sandbox'
                        : 'none'
                    : process.env.CLAUDE_CODE_OAUTH_TOKEN
                      ? 'token'
                      : loginOf(config.claude.configDir)
            },
            github: { cli: gh, token: Boolean(process.env.GH_TOKEN), owners: tokenOwners() },
            git: { version: git },
            telegram: {
                enabled: Boolean(config.telegram.botToken),
                allowed_user_ids: [...config.telegram.allowedUserIds]
            },
            stt: {
                enabled: Boolean(config.stt.groqApiKey),
                model: config.stt.model,
                language: config.stt.language ?? null
            },
            paths: {
                data: config.paths.dataRoot,
                workspaces: config.paths.workspacesRoot,
                config: config.paths.configRoot
            },
            max_concurrent_sessions: config.maxConcurrentSessions,
            workspaces,
            sandboxes: {
                mode: sandbox.mode,
                ok: sandbox.ok,
                error: sandbox.error,
                version: sandbox.version,
                docker_login: sandbox.docker_login,
                claude_login: sandbox.claude_login,
                total: sandbox.sandboxes.length,
                running: sandbox.sandboxes.filter((s) => s.status === 'running').length,
                approvals: sandbox.approvals.length,
                previews: previews.list().map((p) => ({ project: p.project, url: p.url }))
            },
            mcp,
            // Other model providers: what runs on each now and whether the gateway's last request got through.
            providers: tasks.providerStatus().map((p) => ({
                name: p.name,
                kind: p.kind,
                running: p.running,
                concurrency: p.concurrency,
                light: p.light,
                token_set: !p.token || providers.key(p) !== null,
                ok: p.health?.ok ?? null,
                error: p.health?.error ?? null
            }))
        })
    })

    return app
}
