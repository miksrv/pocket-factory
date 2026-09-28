import fs from 'node:fs'
import path from 'node:path'

import { type MarkdownDoc, parseMarkdown, serializeMarkdown } from './markdown.js'

/**
 * The factory's editable files, all Markdown with frontmatter:
 *   agents   → <claude>/agents/<name>.md          (Claude Code sub-agents)
 *   skills   → <claude>/skills/<name>/SKILL.md    (Claude Code skills)
 *   projects → <config>/projects/<slug>.md        (knowledge base)
 * The UI, the owner and the agent itself edit the same files.
 */
export type Kind = 'agents' | 'skills' | 'projects'

export interface CatalogEntry {
    kind: Kind
    name: string
    path: string
    frontmatter: Record<string, unknown>
    body: string
    updated_at: string
    size: number
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

export class BadName extends Error {}
export class NotFound extends Error {}

export class Catalog {
    /** Called after every save/remove with a commit-style message. */

    constructor(
        private readonly claudeDir: string,
        private readonly configDir: string
    ) {}

    dirFor(kind: Kind): string {
        switch (kind) {
            case 'agents':
                return path.join(this.claudeDir, 'agents')
            case 'skills':
                return path.join(this.claudeDir, 'skills')
            case 'projects':
                return path.join(this.configDir, 'projects')
        }
    }

    fileFor(kind: Kind, name: string): string {
        if (!NAME.test(name)) throw new BadName(`Invalid ${kind} name "${name}": use a-z, 0-9, dot, dash, underscore`)
        return kind === 'skills' ? path.join(this.dirFor(kind), name, 'SKILL.md') : path.join(this.dirFor(kind), `${name}.md`)
    }

    list(kind: Kind): CatalogEntry[] {
        const dir = this.dirFor(kind)
        if (!fs.existsSync(dir)) return []
        const names = fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap((entry) => {
                if (kind === 'skills') return entry.isDirectory() ? [entry.name] : []
                return entry.isFile() && entry.name.endsWith('.md') ? [entry.name.slice(0, -3)] : []
            })
            .filter((name) => NAME.test(name))
            .sort()
        return names.flatMap((name) => {
            try {
                return [this.get(kind, name)]
            } catch {
                return []
            }
        })
    }

    get(kind: Kind, name: string): CatalogEntry {
        const file = this.fileFor(kind, name)
        if (!fs.existsSync(file)) throw new NotFound(`${kind}/${name} not found`)
        const stat = fs.statSync(file)
        const doc = parseMarkdown(fs.readFileSync(file, 'utf8'))
        return {
            kind,
            name,
            path: file,
            frontmatter: doc.frontmatter,
            body: doc.body,
            updated_at: stat.mtime.toISOString(),
            size: stat.size
        }
    }

    save(kind: Kind, name: string, doc: MarkdownDoc<Record<string, unknown>>): CatalogEntry {
        const file = this.fileFor(kind, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const frontmatter = { ...doc.frontmatter }
        // Claude Code requires `name` in agent and skill frontmatter and it must match the file.
        if (kind !== 'projects') frontmatter.name = name
        if (kind === 'projects' && !frontmatter.slug) frontmatter.slug = name
        const existed = fs.existsSync(file)
        fs.writeFileSync(file, serializeMarkdown({ frontmatter, body: doc.body }))
        return this.get(kind, name)
    }

    remove(kind: Kind, name: string): void {
        const file = this.fileFor(kind, name)
        if (!fs.existsSync(file)) throw new NotFound(`${kind}/${name} not found`)
        if (kind === 'skills') fs.rmSync(path.dirname(file), { recursive: true, force: true })
        else fs.rmSync(file)
    }

    exists(kind: Kind, name: string): boolean {
        try {
            return fs.existsSync(this.fileFor(kind, name))
        } catch {
            return false
        }
    }
}
