import fs from 'node:fs'
import path from 'node:path'

import type { Catalog, Kind } from '../files/catalog.js'
import { parseMarkdown } from '../files/markdown.js'

/**
 * A preset is a directory under presets/ with a preset.json and the same
 * agents/ skills/ projects/ layout as the volume. Installing copies the files
 * into the volume; from then on they are the owner's to edit.
 */
export interface PresetFile {
    kind: Kind
    name: string
    description: string | null
}

export interface Preset {
    name: string
    title: string
    description: string
    tags: string[]
    files: PresetFile[]
    readme: string | null
}

interface PresetManifest {
    title: string
    description: string
    tags?: string[]
}

export class Presets {
    constructor(private readonly dir: string) {}

    list(): Preset[] {
        if (!fs.existsSync(this.dir)) return []
        return fs
            .readdirSync(this.dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => this.get(entry.name))
            .filter((preset): preset is Preset => preset !== undefined)
            .sort((a, b) => a.title.localeCompare(b.title))
    }

    get(name: string): Preset | undefined {
        const root = path.join(this.dir, name)
        const manifestFile = path.join(root, 'preset.json')
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !fs.existsSync(manifestFile)) return undefined
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as PresetManifest
        const files: PresetFile[] = []
        for (const kind of ['agents', 'skills', 'projects'] as Kind[]) {
            for (const file of this.filesOf(root, kind)) {
                const doc = parseMarkdown(fs.readFileSync(file.path, 'utf8'))
                files.push({ kind, name: file.name, description: typeof doc.frontmatter.description === 'string' ? doc.frontmatter.description : null })
            }
        }
        const readme = path.join(root, 'README.md')
        return {
            name,
            title: manifest.title,
            description: manifest.description,
            tags: manifest.tags ?? [],
            files,
            readme: fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : null
        }
    }

    install(preset: Preset, catalog: Catalog, overwrite: boolean): PresetFile[] {
        const root = path.join(this.dir, preset.name)
        const installed: PresetFile[] = []
        for (const kind of ['agents', 'skills', 'projects'] as Kind[]) {
            for (const file of this.filesOf(root, kind)) {
                if (!overwrite && catalog.exists(kind, file.name)) continue
                const doc = parseMarkdown(fs.readFileSync(file.path, 'utf8'))
                catalog.save(kind, file.name, doc)
                installed.push({ kind, name: file.name, description: null })
            }
        }
        return installed
    }

    private filesOf(root: string, kind: Kind): Array<{ name: string; path: string }> {
        const dir = path.join(root, kind)
        if (!fs.existsSync(dir)) return []
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap((entry) => {
                if (kind === 'skills') {
                    const file = path.join(dir, entry.name, 'SKILL.md')
                    return entry.isDirectory() && fs.existsSync(file) ? [{ name: entry.name, path: file }] : []
                }
                return entry.isFile() && entry.name.endsWith('.md') ? [{ name: entry.name.slice(0, -3), path: path.join(dir, entry.name) }] : []
            })
            .sort((a, b) => a.name.localeCompare(b.name))
    }
}
