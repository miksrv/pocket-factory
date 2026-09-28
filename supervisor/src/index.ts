import { createBot } from './bot.js'
import { loadConfig } from './config.js'
import { createLogger, setLogLevel } from './logger.js'
import { openDatabase } from './store/db.js'
import { Store } from './store/index.js'
import { TaskService } from './tasks/service.js'

const log = createLogger('supervisor')

async function main(): Promise<void> {
    const config = loadConfig()
    setLogLevel(config.logLevel)

    log.info(`workspaces: ${config.paths.workspacesRoot}`)
    log.info(`claude: model=${config.claude.model ?? 'default'} permission=${config.claude.permissionMode} maxTurns=${config.claude.maxTurns} budget=$${config.claude.maxBudgetUsd}`)

    const store = new Store(openDatabase(config.paths.dbFile))
    const tasks = new TaskService(store, config)
    const bot = createBot(config, tasks)

    // Registers the command menu in Telegram, so the client autocompletes them.
    await bot.api.setMyCommands([
        { command: 'new', description: 'Start a fresh session' },
        { command: 'stop', description: 'Cancel the running task' },
        { command: 'status', description: 'What is going on' }
    ])

    const shutdown = (signal: string) => {
        log.info(`${signal} received, stopping`)
        void bot.stop()
        void tasks.shutdown().then(() => process.exit(0))
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))

    await bot.start({
        onStart: (info) => log.info(`polling as @${info.username}`)
    })
}

main().catch((error) => {
    log.error('fatal', error)
    process.exit(1)
})
