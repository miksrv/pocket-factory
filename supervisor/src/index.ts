import path from 'node:path'

import { createBot } from './bot.js'
import { loadConfig } from './config.js'
import { Catalog } from './files/catalog.js'
import { History } from './files/history.js'
import { createLogger, setLogLevel } from './logger.js'
import { Presets } from './presets/index.js'
import { Transcripts } from './sessions/transcripts.js'
import { openDatabase } from './store/db.js'
import { Store } from './store/index.js'
import { TaskService } from './tasks/service.js'
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
    const history = new History(config.claude.configDir, config.paths.configRoot)
    await history.init()

    const catalog = new Catalog(config.claude.configDir, config.paths.configRoot)
    catalog.onChange = (message) => void history.commitAll(message)

    const tasks = new TaskService(store, config)
    // Whatever the agent changed in its own agents/skills/projects during a
    // task becomes a commit, so self-edits can be audited and reverted.
    tasks.on('task', (task) => {
        if (task.status === 'done' || task.status === 'failed') {
            void history.commitAll(`agent: ${task.prompt.slice(0, 60).replace(/\s+/g, ' ')} (task ${task.id.slice(0, 8)})`)
        }
    })
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
        history,
        transcripts: new Transcripts(config.claude.configDir),
        presets: new Presets(config.presetsDir)
    })

    const shutdown = (signal: string) => {
        log.info(`${signal} received, stopping`)
        void bot?.stop()
        void tasks.shutdown().then(() => process.exit(0))
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))

    if (!bot) return

    // Registers the command menu in Telegram, so the client autocompletes them.
    await bot.api.setMyCommands([
        { command: 'new', description: 'Start a fresh session' },
        { command: 'stop', description: 'Cancel the running task' },
        { command: 'status', description: 'What is going on' }
    ])

    await bot.start({
        onStart: (info) => log.info(`polling as @${info.username}`)
    })
}

main().catch((error) => {
    log.error('fatal', error)
    process.exit(1)
})
