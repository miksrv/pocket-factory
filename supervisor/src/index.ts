import { createBot } from './bot.js'
import { loadConfig } from './config.js'
import { createLogger, setLogLevel } from './logger.js'

const log = createLogger('supervisor')

async function main(): Promise<void> {
    const config = loadConfig()
    setLogLevel(config.logLevel)

    log.info(`workspaces: ${config.paths.workspacesRoot}`)
    log.info(`claude: model=${config.claude.model ?? 'default'} permission=${config.claude.permissionMode} maxTurns=${config.claude.maxTurns} budget=$${config.claude.maxBudgetUsd}`)

    const bot = createBot(config)

    // Registers the command menu in Telegram, so the client autocompletes them.
    await bot.api.setMyCommands([
        { command: 'new', description: 'Start a fresh session' },
        { command: 'stop', description: 'Cancel the running task' },
        { command: 'status', description: 'What is going on' }
    ])

    const shutdown = (signal: string) => {
        log.info(`${signal} received, stopping bot`)
        void bot.stop()
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
