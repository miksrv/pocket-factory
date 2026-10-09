import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createLogger } from '../logger.js'

const run = promisify(execFile)
const log = createLogger('docker')

/**
 * The factory's own Docker daemon: the `docker:dind` sidecar of
 * docker-compose.yml, reached through DOCKER_HOST (set by compose when the
 * `docker` profile is on). The agents start a project's services on it; the
 * supervisor stops what a task started once the task ends, and the UI lists
 * and prunes it. Without DOCKER_HOST everything here answers "off".
 */

export interface DockerContainer {
    id: string
    name: string
    image: string
    /** running, exited, … */
    state: string
    status: string
    ports: string
    created: string
    /** From the compose labels: the directory `docker compose` ran in, the project name, the service. */
    compose: { working_dir: string | null; project: string | null; service: string | null }
}

export interface DockerDiskUsage {
    type: string
    total: number
    active: number
    size: string
    reclaimable: string
}

export interface DockerInfo {
    enabled: boolean
    host: string | null
    reachable: boolean
    version: string | null
    error: string | null
    containers: DockerContainer[]
    disk: DockerDiskUsage[]
}

interface PsLine {
    ID: string
    Names: string
    Image: string
    State: string
    Status: string
    Ports: string
    CreatedAt: string
    Labels: string
}

function labels(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const part of text.split(',')) {
        const eq = part.indexOf('=')
        if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1)
    }
    return out
}

function container(line: PsLine): DockerContainer {
    const l = labels(line.Labels ?? '')
    return {
        id: line.ID,
        name: line.Names,
        image: line.Image,
        state: line.State,
        status: line.Status,
        ports: line.Ports ?? '',
        created: line.CreatedAt ?? '',
        compose: {
            working_dir: l['com.docker.compose.project.working_dir'] ?? null,
            project: l['com.docker.compose.project'] ?? null,
            service: l['com.docker.compose.service'] ?? null
        }
    }
}

export class DockerSidecar {
    constructor(
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly command = 'docker'
    ) {}

    get enabled(): boolean {
        return Boolean(this.env.DOCKER_HOST)
    }

    private async docker(args: string[], timeoutMs = 30_000): Promise<string> {
        const { stdout } = await run(this.command, args, { timeout: timeoutMs, maxBuffer: 4 << 20, env: this.env })
        return stdout
    }

    private jsonLines<T>(text: string): T[] {
        return text
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as T)
    }

    async containers(all = true): Promise<DockerContainer[]> {
        if (!this.enabled) return []
        const args = ['ps', '--format', '{{json .}}', '--no-trunc']
        if (all) args.push('-a')
        return this.jsonLines<PsLine>(await this.docker(args)).map(container)
    }

    async info(): Promise<DockerInfo> {
        const off: DockerInfo = {
            enabled: this.enabled,
            host: this.env.DOCKER_HOST ?? null,
            reachable: false,
            version: null,
            error: null,
            containers: [],
            disk: []
        }
        if (!this.enabled) return off
        try {
            const version = (await this.docker(['version', '--format', '{{.Server.Version}}'], 10_000)).trim()
            const [containers, df] = await Promise.all([
                this.containers(),
                this.docker(['system', 'df', '--format', '{{json .}}'])
            ])
            const disk = this.jsonLines<{
                Type: string
                TotalCount: string
                Active: string
                Size: string
                Reclaimable: string
            }>(df).map((d) => ({
                type: d.Type,
                total: Number(d.TotalCount) || 0,
                active: Number(d.Active) || 0,
                size: d.Size,
                reclaimable: d.Reclaimable
            }))
            return { ...off, reachable: true, version, containers, disk }
        } catch (error) {
            return { ...off, error: (error as Error).message.split('\n')[0] }
        }
    }

    async stop(id: string): Promise<void> {
        await this.docker(['stop', id], 60_000)
    }

    /** `docker system prune -f`: stopped containers, dangling images, unused networks and build cache. */
    async prune(): Promise<string> {
        const out = await this.docker(['system', 'prune', '-f'], 5 * 60_000)
        return /Total reclaimed space: (.*)/.exec(out)?.[1] ?? out.trim().split('\n').pop() ?? ''
    }

    /** The ids of the containers running now, for `stopStartedSince`. */
    async snapshot(): Promise<Set<string>> {
        if (!this.enabled) return new Set()
        try {
            return new Set((await this.docker(['ps', '-q', '--no-trunc'], 10_000)).split('\n').filter(Boolean))
        } catch {
            return new Set()
        }
    }

    /**
     * Stop the containers that appeared since `before` (a task's services), except
     * the ones `keep` claims (another task's, still running). Returns their names.
     */
    async stopStartedSince(
        before: Set<string>,
        keep: (c: DockerContainer) => boolean = () => false
    ): Promise<string[]> {
        if (!this.enabled) return []
        let started: DockerContainer[]
        try {
            started = (await this.containers(false)).filter((c) => !before.has(c.id) && !keep(c))
        } catch (error) {
            log.warn(`could not list containers: ${(error as Error).message.split('\n')[0]}`)
            return []
        }
        if (!started.length) return []
        try {
            await this.docker(['stop', ...started.map((c) => c.id)], 120_000)
        } catch (error) {
            log.warn(
                `could not stop ${started.map((c) => c.name).join(', ')}: ${(error as Error).message.split('\n')[0]}`
            )
        }
        return started.map((c) => c.name)
    }
}
