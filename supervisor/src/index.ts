import fs from 'node:fs'
import path from 'node:path'

import { createBot } from './bot.js'
import { loadConfig } from './config.js'
import { agentFile } from './files/agentFiles.js'
import { Catalog, migrateSchedulesDir } from './files/catalog.js'
import { delegateAgents, projectProviders } from './files/delegates.js'
import { Hosts } from './files/hosts.js'
import { KnownHosts } from './files/knownHosts.js'
import { Providers } from './files/providers.js'
import { createLogger, setLogLevel } from './logger.js'
import { Presets } from './presets/index.js'
import { Routines } from './routines/service.js'
import { Transcripts } from './sessions/transcripts.js'
import { openDatabase } from './store/db.js'
import { Store } from './store/index.js'
import { TaskService, type Workspace } from './tasks/service.js'
import { Toolchains } from './toolchains/service.js'
import { VERSION } from './version.js'
import { WebAuth } from './web/auth.js'
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

    log.info(`pocket-factory v${VERSION}`)
    log.info(`workspaces: ${config.paths.workspacesRoot}`)
    log.info(`claude: permission=${config.claude.permissionMode} maxTurns=${config.claude.maxTurns}`)

    const store = new Store(openDatabase(config.paths.dbFile))
    // Files of a factory from before 1.5.0 move from schedules/ to routines/, once.
    const migrated = migrateSchedulesDir(config.paths.configRoot)
    if (migrated.moved) log.info(`moved ${migrated.moved} file(s) from config/schedules to config/routines`)
    if (migrated.kept.length)
        log.warn(
            `config/schedules still has ${migrated.kept.join(', ')}: a routine of the same name exists; merge by hand and delete the old file`
        )
    const catalog = new Catalog(config.claude.configDir, config.paths.configRoot)
    const hosts = new Hosts(path.join(config.paths.configRoot, 'hosts.yaml'), catalog)
    const knownHosts = new KnownHosts(
        path.join(config.paths.configRoot, 'known_hosts'),
        path.join(config.paths.dataRoot, 'secrets', 'ssh', 'known_hosts')
    )
    const transcripts = new Transcripts(config.claude.configDir)
    // Model providers besides the subscription (self-hosted and cloud), chosen per task.
    const providers = new Providers(path.join(config.paths.configRoot, 'providers.yaml'))
    // What the session manager needs from the project files and the transcript index.
    // A project is named by its file, but tasks name it by the checkout directory
    // (detected from tool calls): resolve by file name first, then by the
    // checkout the file points to, case-insensitively.
    const projectEntry = (slug: string) => {
        if (catalog.exists('projects', slug)) return catalog.get('projects', slug)
        const wanted = slug.toLowerCase()
        return catalog.list('projects').find((entry) => {
            const dir =
                typeof entry.frontmatter.path === 'string' && entry.frontmatter.path
                    ? entry.frontmatter.path
                    : path.join(config.paths.workspacesRoot, entry.name)
            return entry.name.toLowerCase() === wanted || path.basename(dir).toLowerCase() === wanted
        })
    }
    const workspace: Workspace = {
        projects: () => catalog.list('projects').map((entry) => entry.name),
        projectPath: (slug) => {
            const entry = projectEntry(slug)
            if (!entry) return null
            const dir =
                typeof entry.frontmatter.path === 'string' && entry.frontmatter.path
                    ? entry.frontmatter.path
                    : path.join(config.paths.workspacesRoot, entry.name)
            return fs.existsSync(dir) ? dir : null
        },
        projectMcp: (slug) => {
            const dir = workspace.projectPath(slug)
            let declared: string[] = []
            try {
                if (dir)
                    declared = Object.keys(
                        (
                            JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')) as {
                                mcpServers?: Record<string, unknown>
                            }
                        ).mcpServers ?? {}
                    )
            } catch {
                // no .mcp.json or not JSON
            }
            const mcp = projectEntry(slug)?.frontmatter.mcp
            return { declared, allowed: Array.isArray(mcp) ? mcp.map(String) : null }
        },
        // `mcpServers:` in an agent file is a list: a name (a server defined elsewhere) or `- name: { … }` inline.
        agentMcp: () =>
            catalog.list('agents').flatMap((entry) => {
                const list = entry.frontmatter.mcpServers
                if (!Array.isArray(list)) return []
                return list.flatMap((item) =>
                    item && typeof item === 'object'
                        ? Object.keys(item as object)
                        : typeof item === 'string'
                          ? [item]
                          : []
                )
            }),
        sessionWorkspace: (sessionId) => transcripts.find(sessionId)?.workspace ?? null,
        agentFile: (name) => agentFile(catalog, name),
        // An agent file with `provider:` is a role the orchestrator delegates (`delegate`): it runs on that provider.
        delegates: () => delegateAgents(catalog),
        projectProviders: (slug) => {
            const entry = projectEntry(slug)
            return entry ? projectProviders(catalog, entry.name) : null
        }
    }
    const tasks = new TaskService(store, config, workspace, providers)
    // Routines: an agent's recurring work, files in data/config/routines, fired by their triggers through the same queue.
    const routines = new Routines(store, catalog, tasks, config, {
        projectExists: (slug) => workspace.projectPath(slug) !== null,
        projectPath: workspace.projectPath,
        projectRepo: (slug) => {
            const repo = projectEntry(slug)?.frontmatter.repo
            return typeof repo === 'string' && repo ? repo : null
        },
        hostExists: (name) => hosts.get(name) !== undefined,
        skillExists: (name) => catalog.exists('skills', name),
        agentExists: (name) => catalog.exists('agents', name),
        providerExists: (name) => providers.get(name) !== undefined,
        providerLight: (name) => providers.get(name)?.light ?? false,
        agentProvider: (name) => {
            const fm = catalog.exists('agents', name) ? catalog.get('agents', name).frontmatter : {}
            // `model:` stays the CLI's (an alias, read when the orchestrator spawns the agent); the provider's own id lives under `provider_model:`.
            return {
                provider: typeof fm.provider === 'string' && fm.provider.trim() ? fm.provider.trim() : null,
                model:
                    typeof fm.provider_model === 'string' && fm.provider_model.trim() ? fm.provider_model.trim() : null
            }
        },
        agentFile: (name) => agentFile(catalog, name),
        agentEnv: () => tasks.agentEnv()
    })
    // Telegram is optional: without a token the factory is web-only (also
    // handy for a second dev instance next to the container, which would
    // otherwise fight over long polling).
    // The web UI's sign-in: sessions and the lockout live in the store, failed attempts are told in Telegram.
    const auth = new WebAuth(store, config.web)
    // What the agents build with: mise runtimes on data/tools, the image's PHP, the dind sidecar.
    const toolchains = new Toolchains({
        root: config.paths.workspacesRoot,
        projectPath: workspace.projectPath,
        projects: () => catalog.list('projects').map((entry) => entry.name)
    })
    tasks.docker = toolchains.docker
    const bot = config.telegram.botToken ? createBot(config, tasks, store, routines, auth) : null
    if (!bot) log.warn('TELEGRAM_BOT_TOKEN not set — Telegram disabled, web UI only')

    startServer({
        config,
        store,
        tasks,
        catalog,
        hosts,
        knownHosts,
        providers,
        transcripts,
        presets: new Presets(config.presetsDir),
        routines,
        auth,
        toolchains
    })
    auth.start()

    const shutdown = (signal: string) => {
        log.info(`${signal} received, stopping`)
        routines.stop()
        auth.stop()
        void bot?.stop()
        void tasks.shutdown().then(() => process.exit(0))
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))

    // Now that the channels listen, tell them about tasks lost to the restart.
    tasks.announceOrphans()
    routines.start()

    if (!bot) return

    // Telegram being down at boot (DNS not ready, 409 from a second poller)
    // must not take the web UI and the queue down with it: log and carry on
    // web-only; the container restart policy is not a retry loop for tasks.
    try {
        // Registers the command menu in Telegram, so the client autocompletes them, and the
        // bot's profile text (what an empty chat and the profile page show).
        await bot.api.setMyCommands([
            { command: 'routines', description: 'The routines on buttons: run, switch on / off, preview, last runs' },
            { command: 'run', description: 'Fire a routine now: /run <name>' },
            { command: 'status', description: 'What is going on, with a Stop button' },
            { command: 'usage', description: 'Subscription limits: 5-hour and weekly windows' },
            { command: 'model', description: "The orchestrator's model on buttons; /model <provider>:<model>" },
            { command: 'new', description: 'Start a fresh session, optionally in a project: /new <name>' },
            { command: 'mode', description: 'A new chat per message, or one thread until /new' },
            { command: 'stop', description: 'Cancel the running task (reply /stop to a message: that chat)' },
            { command: 'help', description: 'How this bot works' }
        ])
        await bot.api.setMyShortDescription(
            `Pocket Factory v${VERSION}: Claude Code on your own server, from this chat.`
        )
        await bot.api.setMyDescription(
            'Send a task as text, voice, a photo or a file; the agent runs it in your checkouts and replies here. Routines, limits and the model are a command away.'
        )
    } catch (error) {
        log.warn(`could not register Telegram commands: ${error instanceof Error ? error.message : String(error)}`)
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
