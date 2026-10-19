import type { Catalog } from '../files/catalog.js'
import { type Hosts, isHostRef, type ProjectHost, SSH_TARGET } from '../files/hosts.js'

/**
 * What a project's sandbox may reach besides sbx's own `balanced` policy (package registries,
 * GitHub, the AI services): the hosts the project's file and routines name. Each is one
 * `sbx policy allow network --sandbox` rule; the manager adds and removes them.
 */

/** A `network:` entry as the owner writes it: a host, `host:port`, `*.domain`, an address. Null when it is none of those. */
export function normalizeResource(text: string): string | null {
    const value = text.trim().toLowerCase()
    if (!value || value.length > 253) return null
    if (/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(value)) return value
    if (/^\[[0-9a-f:]+\](:\d{1,5})?$/.test(value)) return value
    return null
}

/** `user@host[:port]` → `host:port` (22 without a port). */
export function sshResource(ssh: string): string | null {
    const match = SSH_TARGET.exec(ssh.trim())
    return match ? `${match[2].toLowerCase()}:${match[3] ?? '22'}` : null
}

/** An http(s) URL → `host:port` (443 / 80 without a port). */
export function urlResource(url: string): string | null {
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
        return `${parsed.hostname.toLowerCase()}:${port}`
    } catch {
        return null
    }
}

/** The `network:` list of a project file, as written (strings only). */
export function projectNetworkList(catalog: Catalog, slug: string): string[] {
    if (!catalog.exists('projects', slug)) return []
    const list = catalog.get('projects', slug).frontmatter.network
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
}

/** Add a host to a project file's `network:` list (an approval the owner allowed); false when it was there. */
export function addProjectNetwork(catalog: Catalog, slug: string, resource: string): boolean {
    const entry = catalog.get('projects', slug)
    const list = projectNetworkList(catalog, slug)
    if (list.map((v) => v.trim().toLowerCase()).includes(resource)) return false
    catalog.save('projects', slug, {
        frontmatter: { ...entry.frontmatter, network: [...list, resource] },
        body: entry.body
    })
    return true
}

function hostTargets(hosts: Hosts, list: unknown): string[] {
    const entries = (Array.isArray(list) ? list : []).filter(
        (h): h is ProjectHost => Boolean(h) && typeof h === 'object'
    )
    return entries.flatMap((h) => {
        const ssh = isHostRef(h) ? hosts.get(h.host)?.ssh : h.ssh
        const resource = ssh ? sshResource(ssh) : null
        return resource ? [resource] : []
    })
}

/** The Trac sites a routine's steps poll (`- trac: { url }`). */
function tracTargets(steps: unknown): string[] {
    return (Array.isArray(steps) ? steps : []).flatMap((step) => {
        const trac = step && typeof step === 'object' ? (step as { trac?: unknown }).trac : undefined
        const url = trac && typeof trac === 'object' ? (trac as { url?: unknown }).url : undefined
        const resource = typeof url === 'string' ? urlResource(url) : null
        return resource ? [resource] : []
    })
}

/**
 * Every host a sandbox needs open: for a project, its file's `network:` and `hosts:` and the Trac
 * sites and hosts of its routines; for the factory's own sandbox (project-less chats), every shared
 * host and what the project-less routines poll.
 */
export function sandboxNetwork(catalog: Catalog, hosts: Hosts, project: string | null): string[] {
    const found = new Set<string>()
    const add = (values: string[]) => {
        for (const value of values) {
            const resource = normalizeResource(value)
            if (resource) found.add(resource)
        }
    }
    if (project) {
        add(projectNetworkList(catalog, project))
        if (catalog.exists('projects', project))
            add(hostTargets(hosts, catalog.get('projects', project).frontmatter.hosts))
    } else {
        add(
            hosts
                .list()
                .hosts.map((h) => sshResource(h.ssh))
                .filter((r): r is string => Boolean(r))
        )
    }
    for (const routine of catalog.list('routines')) {
        const owner = typeof routine.frontmatter.project === 'string' && routine.frontmatter.project.trim()
        if ((owner || null) !== project) continue
        add(tracTargets(routine.frontmatter.steps))
        add(hostTargets(hosts, routine.frontmatter.hosts))
    }
    return [...found].sort()
}
