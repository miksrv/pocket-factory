import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Hono } from 'hono'
import { vi } from 'vitest'

import type { Config } from '../config.js'
import { Catalog } from '../files/catalog.js'
import { Hosts } from '../files/hosts.js'
import { KnownHosts } from '../files/knownHosts.js'
import { Presets } from '../presets/index.js'
import { Schedules } from '../schedules/service.js'
import { Transcripts } from '../sessions/transcripts.js'
import { openDatabase } from '../store/db.js'
import { Store } from '../store/index.js'
import { TaskService, type Workspace } from '../tasks/service.js'
import { WebAuth } from '../web/auth.js'
import type { AppContext, Env } from '../web/context.js'
import { createApp } from '../web/server.js'

export interface TestAppOptions {
    /** Overrides of the web section: `authPassword` switches on sign-in, `allowedHosts`, `trustProxy`, the lock policy… */
    web?: Partial<Config['web']>
    /** Any other change to the finished config (it is a fresh object per app). */
    config?: (config: Config) => void
    /** The body of the fake `claude` on PATH instead of the default one (a shell script; `--version` must answer). */
    claude?: string
}

export interface RequestOptions extends RequestInit {
    /** The socket address the request comes from (what `getConnInfo` reports); default 127.0.0.1. */
    ip?: string
}

export interface TestApp {
    app: Hono<Env>
    ctx: AppContext
    dataRoot: string
    /**
     * `app.request()` with what a browser or curl would send: a `Host` header
     * (localhost:8080 unless the caller sets one) and a socket address for the
     * client-IP helpers.
     */
    request: (url: string, init?: RequestOptions) => Promise<Response>
    /** Stops the services' timers, closes the database, removes the temp directory. */
    cleanup: () => Promise<void>
}

/** A `claude` that never reaches the network: `--version` answers, anything else ends with an empty successful result. */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.0.0 (Claude Code, fake)"; exit 0; fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"00000000-0000-0000-0000-000000000000","num_turns":1,"duration_ms":1,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}'
exit 0
`

/** The defaults of `loadConfig()` on an empty environment, rooted in `dataRoot`. */
export function testConfig(dataRoot: string): Config {
    return {
        telegram: { botToken: undefined, allowedUserIds: new Set(), webNotifyAfterMs: 2 * 60_000 },
        claude: {
            configDir: path.join(dataRoot, 'claude'),
            maxTurns: 50,
            permissionMode: 'acceptEdits',
            taskTimeoutMs: 0,
            autoContinueMs: 6 * 3_600_000
        },
        paths: {
            dataRoot,
            workspacesRoot: path.join(dataRoot, 'workspaces'),
            configRoot: path.join(dataRoot, 'config'),
            dbFile: path.join(dataRoot, 'db', 'factory.sqlite')
        },
        stt: { groqApiKey: undefined, model: 'whisper-large-v3-turbo', language: undefined },
        web: {
            host: '127.0.0.1',
            port: 0,
            authUser: 'factory',
            authPassword: undefined,
            allowedHosts: new Set(),
            sessionDays: 30,
            sessionIdleHours: 8,
            loginMaxFailures: 5,
            loginLockMinutes: 10,
            trustProxy: false,
            publicUrl: null,
            distDir: path.join(dataRoot, 'no-web-dist')
        },
        presetsDir: path.join(dataRoot, 'presets'),
        maxConcurrentSessions: 2,
        logLevel: 'error',
        timezone: 'UTC',
        schedules: { softStop: 0.85, lateMinutes: 5, askTimeoutMs: 120 * 60_000 }
    }
}

/**
 * The whole HTTP application on a fresh temporary DATA_ROOT, wired the way
 * index.ts wires it (real Store, Catalog, Hosts, TaskService, Schedules,
 * WebAuth…), minus the network listener and Telegram. A fake `claude` is put
 * first on PATH, so nothing a test triggers can start the real CLI. The
 * scheduler and the auth sweeper are not started; `cleanup` stops them anyway.
 */
export function createTestApp(options: TestAppOptions = {}): TestApp {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-app-'))
    const bin = path.join(dataRoot, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'claude'), options.claude ?? FAKE_CLAUDE, { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
    // The status route reports these from the environment; the developer's own must not leak into assertions.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')

    const config = testConfig(dataRoot)
    Object.assign(config.web, options.web)
    options.config?.(config)
    fs.mkdirSync(config.paths.workspacesRoot, { recursive: true })

    const db = openDatabase(config.paths.dbFile)
    const store = new Store(db)
    const catalog = new Catalog(config.claude.configDir, config.paths.configRoot)
    const hosts = new Hosts(path.join(config.paths.configRoot, 'hosts.yaml'), catalog)
    const knownHosts = new KnownHosts(path.join(config.paths.configRoot, 'known_hosts'))
    const transcripts = new Transcripts(config.claude.configDir)
    const projectPath = (slug: string): string | null => {
        if (!catalog.exists('projects', slug)) return null
        const entry = catalog.get('projects', slug)
        const dir =
            typeof entry.frontmatter.path === 'string' && entry.frontmatter.path
                ? entry.frontmatter.path
                : path.join(config.paths.workspacesRoot, entry.name)
        return fs.existsSync(dir) ? dir : null
    }
    const workspace: Workspace = {
        projectPath,
        projectMcp: () => ({ declared: [], allowed: null }),
        agentMcp: () => [],
        sessionWorkspace: (sessionId) => transcripts.find(sessionId)?.workspace ?? null
    }
    const tasks = new TaskService(store, config, workspace)
    const schedules = new Schedules(store, catalog, tasks, config, {
        projectExists: (slug) => projectPath(slug) !== null,
        projectPath,
        projectRepo: () => null,
        hostExists: (name) => hosts.get(name) !== undefined,
        skillExists: (name) => catalog.exists('skills', name),
        agentExists: (name) => catalog.exists('agents', name),
        agentEnv: () => tasks.agentEnv()
    })
    const auth = new WebAuth(store, config.web)
    const ctx: AppContext = {
        config,
        store,
        tasks,
        catalog,
        hosts,
        knownHosts,
        transcripts,
        presets: new Presets(config.presetsDir),
        schedules,
        auth
    }
    const app = createApp(ctx)

    const request = (url: string, init: RequestOptions = {}): Promise<Response> => {
        const { ip = '127.0.0.1', ...rest } = init
        const headers = new Headers(rest.headers)
        if (!headers.has('host')) headers.set('host', 'localhost:8080')
        const env = { incoming: { socket: { remoteAddress: ip, remotePort: 50000, remoteFamily: 'IPv4' } } }
        return Promise.resolve(app.request(url, { ...rest, headers }, env))
    }

    const cleanup = async () => {
        schedules.stop()
        auth.stop()
        await tasks.shutdown()
        db.close()
        fs.rmSync(dataRoot, { recursive: true, force: true })
    }

    return { app, ctx, dataRoot, request, cleanup }
}

/** A JSON request body with its content type. */
export function json(body: unknown, init: RequestOptions = {}): RequestOptions {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    return { method: 'POST', ...init, headers, body: JSON.stringify(body) }
}
