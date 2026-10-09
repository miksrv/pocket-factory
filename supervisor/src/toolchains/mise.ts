import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The `mise` CLI in the factory image: language runtimes per checkout,
 * installed under /data/tools (MISE_DATA_DIR). Every call shells out, so the
 * callers cache what the UI polls.
 */

export interface MiseInstall {
    tool: string
    version: string
    install_path: string
    /** Where the version was asked for: a checkout's file, the image's policy, or an explicit install. */
    source: string | null
    active: boolean
}

export interface MiseCurrent {
    tool: string
    /** The version the checkout asks for, as mise resolved it. */
    version: string
    requested: string
    installed: boolean
    source: string | null
}

interface MiseLsEntry {
    version: string
    requested_version?: string
    install_path: string
    installed?: boolean
    active?: boolean
    source?: { type?: string; path?: string }
}

export class Mise {
    constructor(private readonly command = 'mise') {}

    private async mise(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
        const { stdout } = await run(this.command, args, {
            cwd: options.cwd,
            timeout: options.timeoutMs ?? 60_000,
            maxBuffer: 4 << 20,
            env: process.env
        })
        return stdout
    }

    /** "2026.10.6 linux-x64 (2026-10-09)" or null when mise is not on PATH (yarn dev on a laptop). */
    async version(): Promise<string | null> {
        try {
            return (await this.mise(['--version'], { timeoutMs: 10_000 })).trim().split('\n')[0] || null
        } catch {
            return null
        }
    }

    /** Every version mise has installed, any tool. */
    async installed(): Promise<MiseInstall[]> {
        const parsed = JSON.parse(await this.mise(['ls', '--installed', '--json'])) as Record<string, MiseLsEntry[]>
        const out: MiseInstall[] = []
        for (const [tool, entries] of Object.entries(parsed)) {
            for (const e of entries) {
                if (e.installed === false) continue
                out.push({
                    tool,
                    version: e.version,
                    install_path: e.install_path,
                    source: e.source?.path ?? null,
                    active: Boolean(e.active)
                })
            }
        }
        return out.sort((a, b) => a.tool.localeCompare(b.tool) || b.version.localeCompare(a.version))
    }

    /** What a checkout resolves to (its own version files plus the image's policy), installed or not. */
    async current(cwd: string): Promise<MiseCurrent[]> {
        const parsed = JSON.parse(await this.mise(['ls', '--current', '--json'], { cwd })) as Record<
            string,
            MiseLsEntry[]
        >
        const out: MiseCurrent[] = []
        for (const [tool, entries] of Object.entries(parsed)) {
            for (const e of entries) {
                out.push({
                    tool,
                    version: e.version,
                    requested: e.requested_version ?? e.version,
                    installed: e.installed !== false,
                    source: e.source?.path ?? null
                })
            }
        }
        return out
    }

    /** `mise install <tool@version>`; a Go or Python download takes up to a minute or two. */
    async install(spec: string): Promise<string> {
        return this.mise(['install', spec], { timeoutMs: 15 * 60_000 })
    }

    async uninstall(spec: string): Promise<string> {
        return this.mise(['uninstall', spec], { timeoutMs: 5 * 60_000 })
    }

    /** Remove the versions no trusted config asks for any more; returns mise's own account of it. */
    async prune(): Promise<string> {
        return this.mise(['prune'], { timeoutMs: 10 * 60_000 })
    }
}

/** `tool` or `tool@version`, nothing a shell could read into. */
export const isMiseSpec = (spec: string) => /^[a-z][a-z0-9_-]{0,40}(@[A-Za-z0-9._-]{1,40})?$/.test(spec)
