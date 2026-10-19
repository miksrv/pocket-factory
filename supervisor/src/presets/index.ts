import fs from 'node:fs'
import path from 'node:path'

import type { Catalog, Kind } from '../files/catalog.js'
import { createLogger } from '../logger.js'
import { installBundle, readBundle, readBundleDir } from '../sharing/bundle.js'

const log = createLogger('presets')

/**
 * A preset is a directory under presets/ with a preset.json and the bundle
 * layout (agents/ skills/ routines/ projects/, see sharing/bundle.ts), the
 * same an export writes. Installing copies the files into the volume; from
 * then on they are the owner's to edit.
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
        let manifest: PresetManifest
        try {
            manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as PresetManifest
        } catch (error) {
            log.warn(`preset ${name}: preset.json is not valid JSON (${error instanceof Error ? error.message : String(error)}); skipped`)
            return undefined
        }
        const files: PresetFile[] = readBundle(readBundleDir(root), name).items.map((item) => ({
            kind: item.kind,
            name: item.name,
            description: typeof item.doc.frontmatter.description === 'string' ? item.doc.frontmatter.description : null
        }))
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

    /** Copy the preset's files onto the volume: the missing ones, or all of them (Reinstall). */
    install(preset: Preset, catalog: Catalog, overwrite: boolean): PresetFile[] {
        const bundle = readBundle(readBundleDir(path.join(this.dir, preset.name)), preset.name)
        return installBundle(bundle, catalog, (item) => overwrite || !catalog.exists(item.kind, item.name)).map(
            (file) => ({ ...file, description: null })
        )
    }
}
