import fs from 'node:fs'
import path from 'node:path'

import YAML from 'yaml'

import { BadName, type Catalog, NotFound } from './catalog.js'

/**
 * Shared SSH hosts — `<config>/hosts.yaml`, one entry per server, the way an
 * IDE keeps SSH configurations once and lets every project pick one. A shared
 * host is the connection only: name, target, key. A project's `hosts:` list
 * refers to one by name (`- host: <name>`) and carries everything that is
 * about the project on that server: its path and its notes. A host written
 * out inside a project file still works (the form before 2026-09-30 wrote
 * them that way) and shows up here as "inline", with a way to move it into
 * the shared list.
 */
export interface SharedHost {
    name: string
    /** user@host or user@host:port. */
    ssh: string
    /** File name of the private key in data/secrets/ssh; empty = ssh's own defaults. */
    key?: string
}

/** A project's entry under `hosts:`: a reference to a shared host plus project-specific facts. */
export interface HostRef {
    host: string
    path?: string
    notes?: string
}

/** A host written out inside a project file (before the shared list existed). */
export interface InlineHost {
    name?: string
    ssh?: string
    key?: string
    path?: string
    notes?: string
}

export type ProjectHost = HostRef | InlineHost

export const isHostRef = (h: ProjectHost): h is HostRef => typeof (h as HostRef).host === 'string'

export interface HostUsage {
    project: string
    path?: string
    notes?: string
}

export interface HostView extends SharedHost {
    /** Projects that refer to this host, with what they add to it. */
    projects: HostUsage[]
}

export interface InlineHostView {
    project: string
    /** Position in the project's `hosts:` list. */
    index: number
    host: InlineHost
    /** The shared host with the same target and key, if there is one: the entry can link to it instead of duplicating it. */
    same_as: string | null
}

export interface HostsOverview {
    file: string
    hosts: HostView[]
    inline: InlineHostView[]
    /** The file on disk is not valid YAML; saving would replace it. */
    error: string | null
}

/** Host names are shown everywhere and used as keys in project files: letters, digits, dot, dash, underscore. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** `user@host` or `user@host:port`. Nothing else reaches the ssh command line. */
export const SSH_TARGET = /^([a-z_][a-z0-9_.-]{0,31})@([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i
export const KEY_NAME = /^[A-Za-z0-9._-]{1,64}$/

const HEADER = `# Shared SSH hosts of the factory (edited in Settings → Hosts, or by hand): the connection only.
# A project refers to one under its \`hosts:\` as \`- host: <name>\` and keeps its own \`path\` and
# \`notes\` there. Keys are file names in /data/secrets/ssh; passwords are not supported.
`

export class Hosts {
    constructor(
        private readonly file: string,
        private readonly catalog: Catalog
    ) {}

    private read(): { hosts: SharedHost[]; error: string | null } {
        if (!fs.existsSync(this.file)) return { hosts: [], error: null }
        try {
            const doc = YAML.parse(fs.readFileSync(this.file, 'utf8')) as { hosts?: unknown } | null
            const raw = Array.isArray(doc?.hosts) ? doc!.hosts : []
            const hosts = raw
                .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === 'object')
                .filter((h) => typeof h.name === 'string' && typeof h.ssh === 'string')
                .map((h) => clean({ name: String(h.name), ssh: String(h.ssh), key: str(h.key) }))
            return { hosts, error: null }
        } catch (error) {
            return { hosts: [], error: (error as Error).message }
        }
    }

    private write(hosts: SharedHost[]): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const sorted = [...hosts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        fs.writeFileSync(this.file, HEADER + YAML.stringify({ hosts: sorted.map(clean) }, { lineWidth: 0 }))
    }

    /** The shared host of that name, if any. */
    get(name: string): SharedHost | undefined {
        return this.read().hosts.find((h) => h.name === name)
    }

    /** Every project's `hosts:` list, as written. */
    private projectHosts(): Array<{ slug: string; hosts: ProjectHost[] }> {
        return this.catalog.list('projects').map((entry) => ({
            slug: entry.name,
            hosts: (Array.isArray(entry.frontmatter.hosts) ? entry.frontmatter.hosts : []).filter((h): h is ProjectHost => Boolean(h) && typeof h === 'object')
        }))
    }

    list(): HostsOverview {
        const { hosts, error } = this.read()
        const views: HostView[] = hosts.map((h) => ({ ...h, projects: [] }))
        const inline: InlineHostView[] = []
        for (const { slug, hosts: list } of this.projectHosts()) {
            list.forEach((h, index) => {
                if (isHostRef(h)) {
                    const view = views.find((v) => v.name === h.host)
                    // A dangling reference still shows, so the owner sees the broken link and can fix it.
                    if (view) view.projects.push(clean({ project: slug, path: str(h.path), notes: str(h.notes) }))
                    else views.push({ name: h.host, ssh: '', projects: [{ project: slug }] })
                    return
                }
                const twin = hosts.find((s) => s.ssh === (h.ssh ?? '').trim() && (s.key ?? '') === (h.key ?? ''))
                inline.push({ project: slug, index, host: h, same_as: twin?.name ?? null })
            })
        }
        return { file: this.file, hosts: views, inline, error }
    }

    /**
     * Create or update a shared host. A different `name` in the body renames
     * it, and every project that refers to the old name follows.
     */
    save(name: string, host: Omit<SharedHost, 'name'> & { name?: string }): HostView {
        const target = host.name?.trim() || name
        for (const n of [name, target]) if (!NAME.test(n)) throw new BadName(`Invalid host name "${n}": use letters, digits, dot, dash, underscore`)
        const ssh = host.ssh.trim()
        if (!SSH_TARGET.test(ssh)) throw new BadName('ssh target must look like user@host or user@host:port')
        if (host.key && !KEY_NAME.test(host.key)) throw new BadName('invalid key name')
        const { hosts, error } = this.read()
        if (error) throw new Error(`hosts.yaml is not valid YAML (${error}); fix the file by hand first`)
        const index = hosts.findIndex((h) => h.name === name)
        if (target !== name && hosts.some((h) => h.name === target)) throw new BadName(`a host named "${target}" already exists`)
        const next = clean({ name: target, ssh, key: host.key?.trim() })
        if (index >= 0) hosts[index] = next
        else hosts.push(next)
        this.write(hosts)
        if (target !== name && index >= 0) this.rewriteRefs(name, (ref) => ({ ...ref, host: target }))
        return this.list().hosts.find((h) => h.name === target)!
    }

    /** Remove a shared host; with `detach` the projects referring to it lose the entry, otherwise a used host is refused. */
    remove(name: string, detach: boolean): void {
        const { hosts, error } = this.read()
        if (error) throw new Error(`hosts.yaml is not valid YAML (${error}); fix the file by hand first`)
        if (!hosts.some((h) => h.name === name)) throw new NotFound(`host "${name}" not found`)
        const used = this.list().hosts.find((h) => h.name === name)?.projects ?? []
        if (used.length && !detach) throw new InUse(`host "${name}" is used by ${used.map((u) => u.project).join(', ')}`, used.map((u) => u.project))
        if (used.length) this.rewriteRefs(name, () => null)
        this.write(hosts.filter((h) => h.name !== name))
    }

    /** Rewrite every project's reference to `name`: a replacement entry, or null to drop it. */
    private rewriteRefs(name: string, map: (ref: HostRef) => HostRef | null): void {
        for (const { slug, hosts } of this.projectHosts()) {
            if (!hosts.some((h) => isHostRef(h) && h.host === name)) continue
            const entry = this.catalog.get('projects', slug)
            if (entry.frontmatter_error) continue
            const next = hosts.flatMap((h) => {
                if (!isHostRef(h) || h.host !== name) return [h]
                const mapped = map(h)
                return mapped ? [mapped] : []
            })
            this.catalog.save('projects', slug, { frontmatter: { ...entry.frontmatter, hosts: next }, body: entry.body })
        }
    }
}

export class InUse extends Error {
    constructor(
        message: string,
        readonly projects: string[]
    ) {
        super(message)
    }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/** Drop empty optional fields so the YAML stays as short as the owner wrote it. */
function clean<T extends object>(obj: T): T {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== '')) as T
}
