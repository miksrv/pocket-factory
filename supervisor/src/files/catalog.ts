import fs from 'node:fs'
import path from 'node:path'

import { type MarkdownDoc, parseMarkdown, serializeMarkdown } from './markdown.js'

/**
 * The factory's editable files, all Markdown with frontmatter:
 *   agents   → <claude>/agents/<name>.md          (Claude Code sub-agents)
 *   skills   → <claude>/skills/<name>/SKILL.md    (Claude Code skills)
 *   projects → <config>/projects/<slug>.md        (knowledge base)
 *   routines → <config>/routines/<name>/ROUTINE.md (routines: pipeline, schedule, instructions; scripts and data next to it)
 * The UI, the owner and the agent itself edit the same files.
 */
export type Kind = 'agents' | 'skills' | 'projects' | 'routines'

export interface CatalogEntry {
    kind: Kind
    name: string
    path: string
    frontmatter: Record<string, unknown>
    body: string
    /** The file's frontmatter is not valid YAML; the UI must not save over it blindly. */
    frontmatter_error?: string
    updated_at: string
    size: number
}

/** Letters of both cases: Claude Code's built-in agents (`Explore`, `Plan`) are overridden by a file of the same name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export class BadName extends Error {}
export class NotFound extends Error {}
export class Conflict extends Error {}

/** A file next to a skill's SKILL.md or a routine's ROUTINE.md: a script, data, a reference, a template. */
export interface FolderFile {
    /** Relative to the folder, with `/`. */
    path: string
    size: number
    /** Small enough and text: the UI can show and edit it. */
    text: boolean
    /** Executable (a script a step can run as it is). */
    exec: boolean
    updated_at: string
}

/** The kinds that are a folder: a skill always, a routine since 1.6.0 (a flat `<name>.md` still reads). */
export type FolderKind = 'skills' | 'routines'

/** The main file of a folder kind, which the form edits and the file routes never touch. */
const MAIN: Record<FolderKind, string> = { skills: 'SKILL.md', routines: 'ROUTINE.md' }

/** The most a file the UI edits as text may weigh (a routine's CSV of places fits). */
const TEXT_MAX = 1024 * 1024
/** The most a file uploaded through the UI may weigh (the API's body limit, base64 included, is the real cap). */
export const UPLOAD_MAX = 1500 * 1024

/** Whether `child` is `dir` itself or lies under it (a sibling sharing the prefix does not). */
function isInside(child: string, dir: string): boolean {
    return child === dir || child.startsWith(dir + path.sep)
}

/** Bytes are text when their head carries no NUL and decodes as UTF-8. */
function isTextBytes(bytes: Buffer): boolean {
    const head = bytes.subarray(0, 4096)
    if (head.includes(0)) return false
    try {
        // `stream` forgives a multi-byte character cut at the end of the sample.
        new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
        return true
    } catch {
        return false
    }
}

/** A file is text when its first bytes carry no NUL and decode as UTF-8. */
function isText(file: string): boolean {
    let fd: number
    try {
        fd = fs.openSync(file, 'r')
    } catch {
        return false
    }
    try {
        const buffer = Buffer.alloc(4096)
        const n = fs.readSync(fd, buffer, 0, buffer.length, 0)
        return isTextBytes(buffer.subarray(0, n))
    } catch {
        return false
    } finally {
        fs.closeSync(fd)
    }
}

/**
 * Open a folder's file without following a link, and hand its descriptor and facts to `use`:
 * what is checked is what is read (no window between a stat and the read). Null when there is
 * no such regular file.
 */
function withRegularFile<T>(full: string, use: (fd: number, stat: fs.Stats) => T): T | null {
    let fd: number
    try {
        fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    } catch {
        return null
    }
    try {
        const stat = fs.fstatSync(fd)
        return stat.isFile() ? use(fd, stat) : null
    } finally {
        fs.closeSync(fd)
    }
}

/**
 * 1.5.0 renamed `<config>/schedules` to `<config>/routines`: a factory whose
 * data predates it gets its files moved on start, once. Both directories
 * present: the files move one by one, and one that exists under both names
 * stays where it was and is reported (routines/ wins; the owner merges by hand).
 * Returns what the owner should hear about.
 */
export function migrateSchedulesDir(configDir: string): { moved: number; kept: string[] } {
    const old = path.join(configDir, 'schedules')
    const next = path.join(configDir, 'routines')
    if (!fs.existsSync(old) || !fs.statSync(old).isDirectory()) return { moved: 0, kept: [] }
    if (!fs.existsSync(next)) {
        fs.renameSync(old, next)
        return { moved: fs.readdirSync(next).length, kept: [] }
    }
    let moved = 0
    const kept: string[] = []
    for (const name of fs.readdirSync(old)) {
        if (fs.existsSync(path.join(next, name))) kept.push(name)
        else {
            fs.renameSync(path.join(old, name), path.join(next, name))
            moved++
        }
    }
    if (!kept.length) fs.rmdirSync(old)
    return { moved, kept }
}

/**
 * 1.6.0 dropped a routine's `action:` (its mode, which was only ever a line in
 * the prompt): a file that still has it gets the mode as the first line of its
 * instructions instead, on start, once. The file stays where it is (a flat
 * one is not moved into a folder). Returns the routines it changed.
 */
export function migrateRoutineActions(catalog: Catalog): string[] {
    const changed: string[] = []
    for (const entry of catalog.list('routines')) {
        if (entry.frontmatter_error || !('action' in entry.frontmatter)) continue
        const { action, ...frontmatter } = entry.frontmatter
        const mode = typeof action === 'string' ? action.trim() : ''
        const line = !mode
            ? ''
            : mode === 'report'
              ? 'Mode: report — look and report; change nothing, post nothing.'
              : `Mode: ${mode}.`
        const body = entry.body.replace(/^\n+/, '')
        fs.writeFileSync(entry.path, serializeMarkdown({ frontmatter, body: line ? `${line}\n\n${body}` : body }))
        changed.push(entry.name)
    }
    return changed
}

export class Catalog {
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
            case 'routines':
                return path.join(this.configDir, 'routines')
        }
    }

    /**
     * The Markdown file of an entry. A routine is a folder (`<name>/ROUTINE.md`
     * next to its scripts and data); a routine written before that is a flat
     * `<name>.md`, read where it is until it is saved (the save moves it in).
     */
    fileFor(kind: Kind, name: string): string {
        if (!NAME.test(name))
            throw new BadName(`Invalid ${kind} name "${name}": use letters, digits, dot, dash, underscore`)
        if (kind === 'skills') return path.join(this.dirFor(kind), name, MAIN.skills)
        if (kind === 'routines') {
            const folder = path.join(this.dirFor(kind), name, MAIN.routines)
            const flat = path.join(this.dirFor(kind), `${name}.md`)
            return !fs.existsSync(folder) && fs.existsSync(flat) ? flat : folder
        }
        return path.join(this.dirFor(kind), `${name}.md`)
    }

    /** The folder of a skill or a routine (a flat routine's folder may not exist yet). */
    folderOf(kind: FolderKind, name: string): string {
        this.fileFor(kind, name) // validates the name
        return path.join(this.dirFor(kind), name)
    }

    /** A flat routine becomes a folder: its file moves to `<name>/ROUTINE.md`, keeping its time. */
    private toFolder(kind: FolderKind, name: string): void {
        if (kind !== 'routines') return
        const flat = path.join(this.dirFor(kind), `${name}.md`)
        const folder = path.join(this.dirFor(kind), name)
        const main = path.join(folder, MAIN.routines)
        if (!fs.existsSync(flat) || fs.existsSync(main)) return
        fs.mkdirSync(folder, { recursive: true })
        fs.renameSync(flat, main)
    }

    // ---- a folder's other files (scripts, data, references next to SKILL.md / ROUTINE.md) -----

    /** The folder of an existing skill or routine, or NotFound. */
    private existingFolder(kind: FolderKind, name: string): string {
        if (!fs.existsSync(this.fileFor(kind, name))) throw new NotFound(`${kind}/${name} not found`)
        return this.folderOf(kind, name)
    }

    /** A file inside the folder, by its relative path; never outside it, never the main file, never a dotfile. */
    private folderFilePath(kind: FolderKind, name: string, rel: string): string {
        const dir = this.existingFolder(kind, name)
        const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
        const full = path.resolve(dir, clean)
        if (!clean || clean === MAIN[kind] || clean.split('/').some((p) => p === '..' || p.startsWith('.') || !p))
            throw new BadName(`"${rel}" is not a file of the ${kind.slice(0, -1)}`)
        if (!full.startsWith(dir + path.sep)) throw new BadName(`"${rel}" is outside the ${kind.slice(0, -1)}`)
        // A symlink inside the folder that points elsewhere must not be read or written through.
        let parent = path.dirname(full)
        while (!fs.existsSync(parent) && parent.startsWith(dir + path.sep)) parent = path.dirname(parent)
        if (fs.existsSync(parent) && fs.existsSync(dir) && !isInside(fs.realpathSync(parent), fs.realpathSync(dir)))
            throw new BadName(`"${rel}" leaves the ${kind.slice(0, -1)} through a link`)
        if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink())
            throw new BadName(`"${rel}" is a link; edit the file it points to`)
        return full
    }

    /** Every file of the folder, recursively (dotfiles and node_modules left out), with its size and whether it reads as text. */
    folderFiles(kind: FolderKind, name: string): FolderFile[] {
        const dir = this.existingFolder(kind, name)
        if (!fs.existsSync(dir)) return []
        const out: FolderFile[] = []
        const walk = (sub: string) => {
            for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__')
                    continue
                const rel = sub ? `${sub}/${entry.name}` : entry.name
                if (entry.isDirectory()) walk(rel)
                else if (entry.isFile() && rel !== MAIN[kind]) {
                    const stat = fs.statSync(path.join(dir, rel))
                    out.push({
                        path: rel,
                        size: stat.size,
                        text: stat.size <= TEXT_MAX && isText(path.join(dir, rel)),
                        exec: (stat.mode & 0o111) !== 0,
                        updated_at: stat.mtime.toISOString()
                    })
                }
            }
        }
        walk('')
        return out.sort((a, b) => a.path.localeCompare(b.path))
    }

    /** One file's facts, or null when there is no such file. */
    folderFile(kind: FolderKind, name: string, rel: string): FolderFile | null {
        let full: string
        try {
            full = this.folderFilePath(kind, name, rel)
        } catch {
            return null
        }
        return withRegularFile(full, (fd, stat) => {
            let text = false
            if (stat.size <= TEXT_MAX) {
                const buffer = Buffer.alloc(4096)
                text = isTextBytes(buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)))
            }
            return {
                path: rel,
                size: stat.size,
                text,
                exec: (stat.mode & 0o111) !== 0,
                updated_at: stat.mtime.toISOString()
            }
        })
    }

    readFolderFile(kind: FolderKind, name: string, rel: string): { text: string; updated_at: string } {
        const full = this.folderFilePath(kind, name, rel)
        const read = withRegularFile(full, (fd, stat) => {
            if (stat.size > TEXT_MAX) return { bytes: null, stat }
            return { bytes: fs.readFileSync(fd), stat }
        })
        if (!read) throw new NotFound(`${kind}/${name}/${rel} not found`)
        if (!read.bytes || !isTextBytes(read.bytes))
            throw new BadName(`${kind}/${name}/${rel} is not a text file the editor can show`)
        return { text: read.bytes.toString('utf8'), updated_at: read.stat.mtime.toISOString() }
    }

    /** The raw bytes, for a download (a binary file the editor does not show). */
    readFolderBytes(kind: FolderKind, name: string, rel: string): Buffer {
        const full = this.folderFilePath(kind, name, rel)
        const bytes = withRegularFile(full, (fd) => fs.readFileSync(fd))
        if (!bytes) throw new NotFound(`${kind}/${name}/${rel} not found`)
        return bytes
    }

    /**
     * Write (or create) a file of the folder. Text from the editor, or bytes from an upload.
     * A script keeps its executable bit, a new one gets it. `updatedAt`: the version the
     * editor opened; a file changed since (by a run, by the agent) is refused.
     */
    writeFolderFile(
        kind: FolderKind,
        name: string,
        rel: string,
        content: string | Buffer,
        options: { updatedAt?: string; exec?: boolean } = {}
    ): FolderFile {
        this.existingFolder(kind, name)
        this.toFolder(kind, name)
        const full = this.folderFilePath(kind, name, rel)
        const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.length
        const max = typeof content === 'string' ? TEXT_MAX : UPLOAD_MAX
        if (bytes > max) throw new BadName(`the file is larger than ${Math.round(max / 1024)} KB`)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        // One descriptor from the check to the write: a new file is created exclusively, an
        // existing one is opened (never through a link), compared and only then truncated.
        const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
        let existed = false
        let fd: number
        try {
            fd = fs.openSync(full, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
            existed = true
            fd = fs.openSync(full, O_WRONLY | O_NOFOLLOW)
        }
        try {
            const stat = fs.fstatSync(fd)
            if (!stat.isFile()) throw new BadName(`"${rel}" is not a file`)
            if (existed && options.updatedAt && stat.mtime.toISOString() !== options.updatedAt)
                throw new Conflict(
                    `${rel} changed on disk since you opened it (maybe by a run): reload it and apply your edit again`
                )
            fs.ftruncateSync(fd, 0)
            fs.writeSync(fd, typeof content === 'string' ? Buffer.from(content) : content, 0, bytes, 0)
            if (options.exec !== undefined) fs.fchmodSync(fd, options.exec ? 0o755 : 0o644)
            else if (!existed && /\.(sh|bash|py|mjs|js|rb|pl)$/.test(full)) fs.fchmodSync(fd, 0o755)
        } finally {
            fs.closeSync(fd)
        }
        return this.folderFile(kind, name, rel)!
    }

    /** Rename or move a file inside the folder; the target must not exist. */
    renameFolderFile(kind: FolderKind, name: string, from: string, to: string): FolderFile {
        const src = this.folderFilePath(kind, name, from)
        const dst = this.folderFilePath(kind, name, to)
        if (!fs.existsSync(src)) throw new NotFound(`${kind}/${name}/${from} not found`)
        if (fs.existsSync(dst)) throw new Conflict(`${to} exists already`)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.renameSync(src, dst)
        this.pruneEmpty(kind, name, path.dirname(src))
        return this.folderFile(kind, name, to)!
    }

    removeFolderFile(kind: FolderKind, name: string, rel: string): void {
        const full = this.folderFilePath(kind, name, rel)
        if (!fs.existsSync(full)) throw new NotFound(`${kind}/${name}/${rel} not found`)
        fs.rmSync(full)
        this.pruneEmpty(kind, name, path.dirname(full))
    }

    /** Empty subdirectories left by a delete or a move go too (never the folder itself). */
    private pruneEmpty(kind: FolderKind, name: string, dir: string): void {
        const root = this.folderOf(kind, name)
        let at = dir
        while (at.startsWith(root + path.sep) && fs.existsSync(at) && fs.readdirSync(at).length === 0) {
            fs.rmdirSync(at)
            at = path.dirname(at)
        }
    }

    list(kind: Kind): CatalogEntry[] {
        const dir = this.dirFor(kind)
        if (!fs.existsSync(dir)) return []
        const names = fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap((entry) => {
                if (kind === 'skills') return entry.isDirectory() ? [entry.name] : []
                if (kind === 'routines' && entry.isDirectory())
                    return fs.existsSync(path.join(dir, entry.name, MAIN.routines)) ? [entry.name] : []
                return entry.isFile() && entry.name.endsWith('.md') ? [entry.name.slice(0, -3)] : []
            })
            .filter((name) => NAME.test(name))
            // Alphabetical regardless of case: "developer" next to "Explore", "my.site" before "Shop".
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        // A routine present as a folder and as a flat file (copied by hand) is listed once: the folder wins.
        return [...new Set(names)].flatMap((name) => {
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
            ...(doc.frontmatter_error ? { frontmatter_error: doc.frontmatter_error } : {}),
            updated_at: stat.mtime.toISOString(),
            size: stat.size
        }
    }

    save(kind: Kind, name: string, doc: MarkdownDoc<Record<string, unknown>>): CatalogEntry {
        if (kind === 'routines') this.toFolder(kind, name)
        const file = this.fileFor(kind, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const frontmatter = { ...doc.frontmatter }
        // Claude Code requires `name` in agent and skill frontmatter and it must match the file; a routine is named the same way.
        if (kind !== 'projects') frontmatter.name = name
        if (kind === 'projects' && !frontmatter.slug) frontmatter.slug = name
        fs.writeFileSync(file, serializeMarkdown({ frontmatter, body: doc.body }))
        return this.get(kind, name)
    }

    remove(kind: Kind, name: string): void {
        const file = this.fileFor(kind, name)
        if (!fs.existsSync(file)) throw new NotFound(`${kind}/${name} not found`)
        if (kind === 'skills') fs.rmSync(path.dirname(file), { recursive: true, force: true })
        else if (kind === 'routines') {
            // The folder with its scripts and data, and a flat file of the same name if one is left.
            fs.rmSync(path.join(this.dirFor(kind), name), { recursive: true, force: true })
            fs.rmSync(path.join(this.dirFor(kind), `${name}.md`), { force: true })
        } else fs.rmSync(file)
    }

    exists(kind: Kind, name: string): boolean {
        try {
            return fs.existsSync(this.fileFor(kind, name))
        } catch {
            return false
        }
    }
}
