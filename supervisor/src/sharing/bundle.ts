import fs from 'node:fs'
import path from 'node:path'

import { type Catalog, type FolderKind, isValidName, type Kind } from '../files/catalog.js'
import { type MarkdownDoc, parseMarkdown } from '../files/markdown.js'
import { describeScript, SCRIPT_EXT } from '../routines/scripts.js'
import { parseRoutine } from '../routines/spec.js'
import type { Vault } from '../secrets/vault.js'
import { VERSION } from '../version.js'
import { writeZip, ZIP_LIMITS, type ZipEntry } from './zip.js'

/**
 * A bundle is the preset layout, from a folder under presets/ or from a ZIP
 * a colleague exported:
 *
 *     preset.json                      { title, description, tags } (optional in a ZIP)
 *     agents/<name>.md
 *     skills/<name>/SKILL.md           + its scripts, references, data
 *     routines/<name>/ROUTINE.md       + scripts/ and, when exported with it, data/
 *     projects/<slug>.md               (templates; never exported)
 *
 * A ZIP that is one skill (`SKILL.md` at its root, a `.skill` file from
 * claude.ai) or one routine reads as that one item. Secrets and variables
 * live in the vault and never travel: a bundle names what its scripts read.
 */

export interface BundleItem {
    kind: Kind
    name: string
    doc: MarkdownDoc
    /** The folder's other files, relative to it (skills and routines only). */
    files: ZipEntry[]
    /** Why it cannot be installed; empty when it can. */
    errors: string[]
}

export interface Bundle {
    title: string | null
    description: string | null
    items: BundleItem[]
    /** Files that belong to no item (left out). */
    ignored: string[]
}

const MAIN: Record<FolderKind, string> = { skills: 'SKILL.md', routines: 'ROUTINE.md' }
/** Files at a bundle's root that are its own, not stray ones. */
const ROOT_FILES = new Set(['preset.json', 'README.md', 'LICENSE', 'LICENSE.md', 'CREDITS.md'])
const MARKERS = ['preset.json', 'SKILL.md', 'ROUTINE.md']
const LAYOUT_DIRS = ['agents', 'skills', 'routines', 'projects']

/** Never part of a bundle: dotfiles, a Mac's resource forks, dependencies and caches. */
const isJunk = (file: string) =>
    file
        .split('/')
        .some(
            (part) => part.startsWith('.') || part === '__MACOSX' || part === 'node_modules' || part === '__pycache__'
        )

/** A file's bytes as text when they are text (no NUL, valid UTF-8), else null. */
function asText(bytes: Buffer): string | null {
    if (bytes.includes(0)) return null
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return null
    }
}

const stem = (file: string) => path.basename(file).replace(/\.[^.]+$/, '')

function makeItem(kind: Kind, name: string, main: Buffer, files: ZipEntry[]): BundleItem {
    const errors: string[] = []
    const text = asText(main)
    const doc: MarkdownDoc = text === null ? { frontmatter: {}, body: '' } : parseMarkdown(text)
    if (!isValidName(name)) errors.push(`"${name}" is not a valid name (letters, digits, dot, dash, underscore)`)
    if (text === null) errors.push('the Markdown file is not text')
    else if (doc.frontmatter_error) errors.push(`frontmatter is not valid YAML: ${doc.frontmatter_error}`)
    else if ((kind === 'agents' || kind === 'skills') && typeof doc.frontmatter.description !== 'string')
        errors.push('no `description:` in the frontmatter: Claude Code would never pick it')
    return { kind, name, doc, files, errors }
}

/** The name of an agent or a skill: its own `name:` when valid, else its folder's (or file's), else the fallback. */
function soleName(main: Buffer, folder: string | null, fallback: string): string {
    const own = parseMarkdown(asText(main) ?? '').frontmatter.name
    if (typeof own === 'string' && isValidName(own)) return own
    return folder ?? fallback
}

/**
 * Read a bundle from its files. `fallback` names a one-item bundle that
 * says nothing else (the uploaded file's name).
 */
export function readBundle(entries: ZipEntry[], fallback: string): Bundle {
    let files = entries.filter((entry) => !isJunk(entry.path))
    // A folder zipped as a whole (`my-skill/SKILL.md`, a repository's `repo-main/…`): its contents are the bundle.
    let folder: string | null = null
    for (;;) {
        const roots = new Set(files.map((f) => f.path.split('/')[0]))
        const atRoot = (name: string) => files.some((f) => f.path === name || f.path.startsWith(`${name}/`))
        if (roots.size !== 1 || files.some((f) => !f.path.includes('/'))) break
        if (MARKERS.some(atRoot)) break
        folder = [...roots][0]
        files = files.map((f) => ({ ...f, path: f.path.slice(folder!.length + 1) }))
    }
    const byPath = new Map(files.map((f) => [f.path, f]))
    let manifest: { title?: unknown; description?: unknown } = {}
    const manifestFile = byPath.get('preset.json')
    if (manifestFile) {
        try {
            manifest = JSON.parse(manifestFile.bytes.toString('utf8')) as typeof manifest
        } catch {
            // a broken manifest only loses the title
        }
    }
    const bundle: Bundle = {
        title: typeof manifest.title === 'string' ? manifest.title : null,
        description: typeof manifest.description === 'string' ? manifest.description : null,
        items: [],
        ignored: []
    }

    // One skill or one routine: everything else in the archive is its files.
    for (const kind of ['skills', 'routines'] as const) {
        const main = byPath.get(MAIN[kind])
        if (!main) continue
        const name = soleName(main.bytes, folder, fallback)
        const rest = files.filter((f) => f !== main)
        bundle.items.push(makeItem(kind, name, main.bytes, rest))
        return bundle
    }

    const claimed = new Set<ZipEntry>()
    for (const kind of LAYOUT_DIRS as Kind[]) {
        if (kind === 'skills' || kind === 'routines') {
            const names = new Set(
                files
                    .filter((f) => f.path.startsWith(`${kind}/`) && f.path.split('/').length > 2)
                    .map((f) => f.path.split('/')[1])
            )
            for (const name of [...names].sort()) {
                const prefix = `${kind}/${name}/`
                const main = byPath.get(prefix + MAIN[kind])
                if (!main) continue
                const own = files.filter((f) => f.path.startsWith(prefix) && f !== main)
                for (const f of [main, ...own]) claimed.add(f)
                // A skill goes by its own `name:` (what Claude Code calls it), its folder only when it has none.
                bundle.items.push(
                    makeItem(
                        kind,
                        kind === 'skills' ? soleName(main.bytes, name, name) : name,
                        main.bytes,
                        own.map((f) => ({ ...f, path: f.path.slice(prefix.length) }))
                    )
                )
            }
            // A flat routine (`routines/<name>.md`, as before 1.6.0) reads too.
            if (kind === 'routines')
                for (const f of files.filter((f) => /^routines\/[^/]+\.md$/.test(f.path))) {
                    const name = stem(f.path)
                    if (bundle.items.some((i) => i.kind === 'routines' && i.name === name)) continue
                    claimed.add(f)
                    bundle.items.push(makeItem('routines', name, f.bytes, []))
                }
        } else {
            const flat = files.filter((f) => new RegExp(`^${kind}/[^/]+\\.md$`).test(f.path))
            for (const f of flat.sort((a, b) => a.path.localeCompare(b.path))) {
                claimed.add(f)
                const name = kind === 'agents' ? soleName(f.bytes, stem(f.path), stem(f.path)) : stem(f.path)
                bundle.items.push(makeItem(kind, name, f.bytes, []))
            }
        }
    }
    const seen = new Set<string>()
    for (const item of bundle.items) {
        if (seen.has(itemKey(item))) item.errors.push(`another ${item.kind.slice(0, -1)} in the file has this name`)
        seen.add(itemKey(item))
    }
    bundle.ignored = files.filter((f) => !claimed.has(f) && !ROOT_FILES.has(f.path)).map((f) => f.path)
    return bundle
}

/** One Markdown file as a skill or an agent (a skill from the internet is often only its SKILL.md). */
export function readMarkdownBundle(bytes: Buffer, fileName: string, kind: 'skills' | 'agents'): Bundle {
    const name = soleName(bytes, null, stem(fileName) === 'SKILL' ? 'skill' : stem(fileName))
    return { title: null, description: null, items: [makeItem(kind, name, bytes, [])], ignored: [] }
}

/** A folder on disk (a preset) as the files of a bundle. */
export function readBundleDir(root: string): ZipEntry[] {
    const out: ZipEntry[] = []
    const walk = (sub: string) => {
        for (const entry of fs.readdirSync(path.join(root, sub), { withFileTypes: true })) {
            const rel = sub ? `${sub}/${entry.name}` : entry.name
            if (isJunk(rel)) continue
            if (entry.isDirectory()) walk(rel)
            else if (entry.isFile()) {
                const full = path.join(root, rel)
                out.push({ path: rel, bytes: fs.readFileSync(full), exec: (fs.statSync(full).mode & 0o111) !== 0 })
            }
        }
    }
    walk('')
    return out
}

export const itemKey = (item: { kind: Kind; name: string }) => `${item.kind}/${item.name}`

/**
 * Put the chosen items on the volume. An item that exists is replaced
 * (its main file and the files the bundle brings; other files in its
 * folder, a routine's data, stay). A routine always arrives switched off.
 */
export function installBundle(
    bundle: Bundle,
    catalog: Catalog,
    pick: (item: BundleItem) => boolean
): Array<{ kind: Kind; name: string }> {
    const installed: Array<{ kind: Kind; name: string }> = []
    for (const item of bundle.items) {
        if (item.errors.length || !pick(item)) continue
        const frontmatter = { ...item.doc.frontmatter }
        if (item.kind === 'routines') frontmatter.enabled = false
        catalog.save(item.kind, item.name, { frontmatter, body: item.doc.body })
        if (item.kind === 'skills' || item.kind === 'routines')
            for (const file of item.files)
                catalog.writeFolderFile(item.kind, item.name, file.path, file.bytes, {
                    exec: file.exec,
                    max: ZIP_LIMITS.file
                })
        installed.push({ kind: item.kind, name: item.name })
    }
    return installed
}

/** A name a bundle's scripts read, as their headers declare it (`# secrets:` / `# vars:`). */
export interface BundleNeed {
    name: string
    secret: boolean
}

/** What the scripts of an item declare they read: a colleague sets these in Secrets and variables. */
export function itemNeeds(item: BundleItem): BundleNeed[] {
    const needs = new Map<string, BundleNeed>()
    for (const file of item.files) {
        const text = file.bytes.length <= 256 * 1024 ? asText(file.bytes) : null
        if (text === null || (!SCRIPT_EXT.test(file.path) && !text.startsWith('#!'))) continue
        const info = describeScript(text)
        for (const name of info.declared)
            if (!needs.has(name)) needs.set(name, { name, secret: !info.variables.includes(name) })
    }
    return [...needs.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The agent and the skill a routine's agent step names (null when it names none, or the file does not parse). */
export function routineRefs(item: { name: string; doc: MarkdownDoc }): {
    agent: string | null
    skill: string | null
    project: string | null
} {
    const yes = () => true
    const parsed = parseRoutine(
        {
            kind: 'routines',
            name: item.name,
            path: '',
            frontmatter: item.doc.frontmatter,
            body: item.doc.body,
            updated_at: '',
            size: 0
        },
        { tz: 'UTC' },
        {
            projectExists: yes,
            hostExists: yes,
            skillExists: yes,
            agentExists: yes,
            providerExists: yes,
            agentProvider: () => ({ provider: null, model: null })
        }
    )
    return {
        agent: parsed.spec?.agent ?? null,
        skill: parsed.spec?.skill ?? null,
        project: parsed.spec?.project ?? null
    }
}

export interface ExportRequest {
    agents: string[]
    skills: string[]
    routines: string[]
    /** A routine brings the agent and the skill its agent step names. */
    withDeps: boolean
    /** A routine brings its `data/` (what its runs keep: notes, CSVs); off by default, it may be personal. */
    withData: boolean
    title?: string
}

/**
 * Pack agents, skills and routines as a bundle another factory imports.
 * The vault never goes: secret values that a file carries anyway are
 * masked, the way run logs mask them.
 */
export function exportBundle(
    catalog: Catalog,
    vault: Vault,
    request: ExportRequest
): { bytes: Buffer; filename: string; masked: string[] } {
    const agents = new Set(request.agents)
    const skills = new Set(request.skills)
    const routines = new Set(request.routines)
    if (request.withDeps)
        for (const name of routines) {
            const entry = catalog.get('routines', name)
            const refs = routineRefs({ name, doc: entry })
            if (refs.agent && catalog.exists('agents', refs.agent)) agents.add(refs.agent)
            if (refs.skill && catalog.exists('skills', refs.skill)) skills.add(refs.skill)
        }

    const entries: ZipEntry[] = []
    const items: BundleItem[] = []
    const add = (kind: Kind, name: string, prefix: string, mainPath: string, folder: boolean) => {
        const entry = catalog.get(kind, name)
        const main = fs.readFileSync(entry.path)
        const own: ZipEntry[] = []
        if (folder)
            for (const file of catalog.folderFiles(kind as FolderKind, name)) {
                if (kind === 'routines' && !request.withData && file.path.startsWith('data/')) continue
                own.push({
                    path: file.path,
                    bytes: catalog.readFolderBytes(kind as FolderKind, name, file.path),
                    exec: file.exec
                })
            }
        entries.push({ path: prefix + mainPath, bytes: main, exec: false })
        for (const file of own) entries.push({ ...file, path: prefix + file.path })
        items.push(makeItem(kind, name, main, own))
    }
    for (const name of [...agents].sort()) add('agents', name, 'agents/', `${name}.md`, false)
    for (const name of [...skills].sort()) add('skills', name, `skills/${name}/`, 'SKILL.md', true)
    for (const name of [...routines].sort()) add('routines', name, `routines/${name}/`, 'ROUTINE.md', true)

    // Text that carries a secret's value has it masked; the file is named so the owner knows.
    const masked: string[] = []
    if (vault.hasSecrets())
        for (const entry of entries) {
            const text = asText(entry.bytes)
            if (text === null) continue
            const clean = vault.redact(text)
            if (clean !== text) {
                entry.bytes = Buffer.from(clean)
                masked.push(entry.path)
            }
        }

    const sole = items.length === 1 ? items[0] : null
    const title = request.title?.trim() || (sole ? sole.name : 'Pocket Factory export')
    const manifest = {
        title,
        description: `Exported from Pocket Factory ${VERSION}: ${items.map(itemKey).join(', ')}.`,
        tags: ['export']
    }
    const needs = new Map<string, BundleNeed>()
    for (const item of items) for (const need of itemNeeds(item)) needs.set(need.name, need)
    const readme = [
        `# ${title}`,
        '',
        `Exported from Pocket Factory ${VERSION}. Import it on the Presets page (Import), or put the folder under \`presets/\`.`,
        '',
        ...items.map((item) => `- \`${itemKey(item)}\`${item.files.length ? ` (+${item.files.length} files)` : ''}`),
        '',
        'Routines arrive switched off. Secrets and variables are never exported.',
        ...(needs.size
            ? [
                  '',
                  'Set these in Settings → Secrets and variables before the first run:',
                  '',
                  ...[...needs.values()].map((n) => `- \`${n.name}\` (${n.secret ? 'secret' : 'variable'})`)
              ]
            : []),
        ...(masked.length ? ['', `Secret values were masked in: ${masked.map((m) => `\`${m}\``).join(', ')}.`] : []),
        ''
    ].join('\n')
    const bytes = writeZip([
        { path: 'preset.json', bytes: Buffer.from(JSON.stringify(manifest, null, 4) + '\n'), exec: false },
        { path: 'README.md', bytes: Buffer.from(readme), exec: false },
        ...entries
    ])
    const filename = `${(sole ? sole.name : 'pocket-factory-export').replace(/[^A-Za-z0-9._-]/g, '_')}.zip`
    return { bytes, filename, masked }
}
