import path from 'node:path'

import { createBot } from './bot.js'
import { loadConfig } from './config.js'
import { Catalog } from './files/catalog.js'
import { createLogger, setLogLevel } from './logger.js'
import { Presets } from './presets/index.js'
import { Transcripts } from './sessions/transcripts.js'
import { openDatabase } from './store/db.js'
import { Store } from './store/index.js'
import { TaskService, type Workspace } from './tasks/service.js'
import fs from 'node:fs'
import { startServer } from './web/server.js'

const log = createLogger('supervisor')

async function main(): Promise<void> {
    // Outside Docker, read .env from the repository root (Node's own parser;
    // variables already present in the environment win). The container gets
    // the same file through compose `env_file`.
    try {
        process.loadEnvFile(path.resolve(process.cwd(), '.env'))
    } catch {
        // no .env — everything must come from the environment
    }
    const config = loadConfig()
    setLogLevel(config.logLevel)

    log.info(`workspaces: ${config.paths.workspacesRoot}`)
    log.info(`claude: model=${config.claude.model ?? 'default'} permission=${config.claude.permissionMode} maxTurns=${config.claude.maxTurns} budget=$${config.claude.maxBudgetUsd}`)

    const store = new Store(openDatabase(config.paths.dbFile))
    const catalog = new Catalog(config.claude.configDir, config.paths.configRoot)
    const transcripts = new Transcripts(config.claude.configDir)
    // What the session manager needs from the project files and the transcript index.
    // A project is named by its file, but tasks name it by the checkout directory
    // (detected from tool calls): resolve by file name first, then by the
    // checkout the file points to, case-insensitively.
    const projectEntry = (slug: string) => {
        if (catalog.exists('projects', slug)) return catalog.get('projects', slug)
        const wanted = slug.toLowerCase()
        return catalog.list('projects').find((entry) => {
            const dir = typeof entry.frontmatter.path === 'string' && entry.frontmatter.path ? entry.frontmatter.path : path.join(config.paths.workspacesRoot, entry.name)
            return entry.name.toLowerCase() === wanted || path.basename(dir).toLowerCase() === wanted
        })
    }
    const workspace: Workspace = {
        projectPath: (slug) => {
            const entry = projectEntry(slug)
            if (!entry) return null
            const dir = typeof entry.frontmatter.path === 'string' && entry.frontmatter.path ? entry.frontmatter.path : path.join(config.paths.workspacesRoot, entry.name)
            return fs.existsSync(dir) ? dir : null
        },
        projectMcp: (slug) => {
            const dir = workspace.projectPath(slug)
            let declared: string[] = []
            try {
                if (dir) declared = Object.keys((JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})
            } catch {
                // no .mcp.json or not JSON
            }
            const mcp = projectEntry(slug)?.frontmatter.mcp
            return { declared, allowed: Array.isArray(mcp) ? mcp.map(String) : null }
        },
        sessionWorkspace: (sessionId) => transcripts.find(sessionId)?.workspace ?? null
    }
    const tasks = new TaskService(store, config, workspace)
    // Telegram is optional: without a token the factory is web-only (also
    // handy for a second dev instance next to the container, which would
    // otherwise fight over long polling).
    const bot = config.telegram.botToken ? createBot(config, tasks) : null
    if (!bot) log.warn('TELEGRAM_BOT_TOKEN not set — Telegram disabled, web UI only')

    startServer({
        config,
        store,
        tasks,
        catalog,
        transcripts,
        presets: new Presets(config.presetsDir)
    })

    const shutdown = (signal: string) => {
        log.info(`${signal} received, stopping`)
        void bot?.stop()
        void tasks.shutdown().then(() => process.exit(0))
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))

    // Now that the channels listen, tell them about tasks lost to the restart.
    tasks.announceOrphans()

    if (!bot) return

    // Telegram being down at boot (DNS not ready, 409 from a second poller)
    // must not take the web UI and the queue down with it: log and carry on
    // web-only; the container restart policy is not a retry loop for tasks.
    try {
        // Registers the command menu in Telegram, so the client autocompletes them.
        await bot.api.setMyCommands([
            { command: 'new', description: 'Start a fresh session, optionally in a project: /new <name>' },
            { command: 'project', description: 'Bind this chat to a project: /project <name>' },
            { command: 'stop', description: 'Cancel the running task' },
            { command: 'status', description: 'What is going on' },
            { command: 'usage', description: 'Subscription limits: 5-hour and weekly windows' }
        ])
    } catch (error) {
        log.warn(`could not register Telegram commands: ${error instanceof Error ? error.message : error}`)
    }
    bot.start({
        onStart: (info) => log.info(`polling as @${info.username}`)
    }).catch((error) => {
        log.error('Telegram polling stopped; the web UI keeps running', error)
    })
}

main().catch((error) => {
    log.error('fatal', error)
    process.exit(1)
})
