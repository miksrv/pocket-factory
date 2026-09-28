import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { createLogger } from '../logger.js'

const run = promisify(execFile)
const log = createLogger('history')

/**
 * "Everything is a file, and every change is a commit." Two git repositories
 * on the volume record who changed what: data/config (projects, .mcp.json)
 * and data/claude (only CLAUDE.md, agents/, skills/ — transcripts and
 * credentials are ignored). The UI commits on save; the supervisor commits
 * whatever the agent changed when a task finishes.
 */
export interface HistoryEntry {
    repo: string
    hash: string
    date: string
    message: string
    files: string[]
}

interface Repo {
    name: string
    dir: string
    ignore?: string
}

const IDENTITY = ['-c', 'user.name=Pocket Factory', '-c', 'user.email=factory@localhost']

export class History {
    private readonly repos: Repo[]

    constructor(claudeDir: string, configDir: string) {
        this.repos = [
            {
                name: 'claude',
                dir: claudeDir,
                ignore: ['*', '!.gitignore', '!CLAUDE.md', '!agents', '!agents/**', '!skills', '!skills/**', ''].join('\n')
            },
            { name: 'config', dir: configDir }
        ]
    }

    async init(): Promise<void> {
        for (const repo of this.repos) {
            fs.mkdirSync(repo.dir, { recursive: true })
            if (repo.ignore !== undefined) {
                const file = path.join(repo.dir, '.gitignore')
                if (!fs.existsSync(file)) fs.writeFileSync(file, repo.ignore)
            }
            if (!fs.existsSync(path.join(repo.dir, '.git'))) {
                await this.git(repo, ['init', '-q', '-b', 'main'])
                await this.commit(repo, 'initial state')
                log.info(`initialised git history in ${repo.dir}`)
            }
        }
    }

    /** Commit pending changes in every repo. Returns the number of commits made. */
    async commitAll(message: string): Promise<number> {
        let commits = 0
        for (const repo of this.repos) {
            try {
                if (await this.commit(repo, message)) commits++
            } catch (error) {
                log.warn(`commit in ${repo.dir} failed: ${error instanceof Error ? error.message : error}`)
            }
        }
        return commits
    }

    async log(limit = 50): Promise<HistoryEntry[]> {
        const entries: HistoryEntry[] = []
        for (const repo of this.repos) {
            if (!fs.existsSync(path.join(repo.dir, '.git'))) continue
            const { stdout } = await this.git(repo, ['log', `-n${limit}`, '--name-only', '--format=%x1e%H%x1f%aI%x1f%s'])
            for (const block of stdout.split('\x1e').slice(1)) {
                const [head, ...rest] = block.split('\n')
                const [hash, date, message] = head.split('\x1f')
                entries.push({ repo: repo.name, hash, date, message, files: rest.map((f) => f.trim()).filter(Boolean) })
            }
        }
        return entries.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit)
    }

    async show(repoName: string, hash: string): Promise<string | null> {
        const repo = this.repos.find((r) => r.name === repoName)
        if (!repo || !/^[0-9a-f]{7,40}$/.test(hash)) return null
        const { stdout } = await this.git(repo, ['show', '--format=%H%n%aI%n%s%n', '--stat', '-p', hash])
        return stdout
    }

    private async commit(repo: Repo, message: string): Promise<boolean> {
        await this.git(repo, ['add', '-A'])
        const { stdout } = await this.git(repo, ['status', '--porcelain'])
        if (!stdout.trim()) return false
        await this.git(repo, ['commit', '-q', '-m', message])
        return true
    }

    private git(repo: Repo, args: string[]) {
        return run('git', [...IDENTITY, ...args], { cwd: repo.dir, maxBuffer: 8 * 1024 * 1024 })
    }
}
