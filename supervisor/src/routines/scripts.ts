import fs from 'node:fs'
import path from 'node:path'

import { referencedNames } from '../secrets/vault.js'

/**
 * What the UI says about a script step: which file it runs (in the routine's
 * folder or a skill's), what the script is for (its header comment) and which
 * variables it needs. A script says what it is the way a shell script usually
 * does, in the comment under the shebang:
 *
 *     #!/usr/bin/env bash
 *     # Google Search Console, 28 days for the place's page: queries, clicks, position.
 *     # secrets: GSC_REFRESH_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
 *
 * `secrets:` (or `vars:`) names what it reads from the environment; other
 * `$NAME`s in the text that the vault holds count too.
 */

export interface ScriptRef {
    /** Where the file lives: the routine's folder, or the agent step's skill. */
    scope: 'routine' | 'skill'
    /** Relative to that folder. */
    path: string
    full: string
}

export interface ScriptInfo extends ScriptRef {
    exists: boolean
    /** The header comment, without `#` and without the `secrets:` / `vars:` lines. */
    description: string
    /** Declared in the header (`secrets:` and `vars:` alike). */
    declared: string[]
    /** Of those, the ones declared under `vars:` (plain values, not secrets). */
    variables: string[]
    /** Every `$NAME` / `${NAME}` the script reads. */
    referenced: string[]
}

const DIR_VARS: Record<string, ScriptRef['scope']> = { ROUTINE_DIR: 'routine', SKILL_DIR: 'skill' }

/** The script a step's command starts, when it is a file in the routine's folder or the skill's: `"${ROUTINE_DIR}/scripts/x.sh" --days 7`. */
export function scriptOf(command: string, dirs: { routine: string; skill: string | null }): ScriptRef | null {
    const m = /^\s*["']?\$\{?(ROUTINE_DIR|SKILL_DIR)\}?\/([^\s"']+)["']?/.exec(command)
    if (!m) return null
    const scope = DIR_VARS[m[1]]
    const base = scope === 'routine' ? dirs.routine : dirs.skill
    if (!base) return null
    const rel = path.posix.normalize(m[2])
    if (rel.startsWith('..')) return null
    return { scope, path: rel, full: path.join(base, rel) }
}

/** The header of a script and the names it reads. */
export function describeScript(text: string): {
    description: string
    declared: string[]
    variables: string[]
    referenced: string[]
} {
    const lines = text.split('\n')
    let i = lines[0]?.startsWith('#!') ? 1 : 0
    const header: string[] = []
    const declared = new Set<string>()
    const variables = new Set<string>()
    for (; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) {
            if (header.length) break
            continue
        }
        const m = /^\s*(?:#|\/\/|--)\s?(.*)$/.exec(line)
        if (!m) break
        const decl = /^(secrets|vars|env)\s*:\s*(.*)$/i.exec(m[1].trim())
        if (decl) {
            for (const name of decl[2].split(/[\s,]+/))
                if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
                    declared.add(name)
                    if (decl[1].toLowerCase() !== 'secrets') variables.add(name)
                }
            continue
        }
        header.push(m[1])
    }
    // Wrapped comment lines are one paragraph; an empty `#` line starts the next.
    const description = header
        .join('\n')
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
        .join('\n\n')
    return {
        description,
        declared: [...declared],
        variables: [...variables],
        referenced: referencedNames(text)
    }
}

/** A regular file's text when it weighs at most `max` bytes, else null; one descriptor from the check to the read. */
function readSmallFile(full: string, max: number): string | null {
    const fd = fs.openSync(full, 'r')
    try {
        const stat = fs.fstatSync(fd)
        return stat.isFile() && stat.size <= max ? fs.readFileSync(fd, 'utf8') : null
    } finally {
        fs.closeSync(fd)
    }
}

export function scriptInfo(ref: ScriptRef): ScriptInfo {
    let text = ''
    let exists = false
    try {
        const read = readSmallFile(ref.full, 1024 * 1024)
        if (read !== null) {
            text = read
            exists = true
        }
    } catch {
        // not there (yet): the card says so
    }
    return { ...ref, exists, ...describeScript(text) }
}

/** A name a folder's scripts read: declared in a header (as a secret or a variable), or only used as `$NAME`. */
export interface FolderNeed {
    name: string
    /** How a header declared it; undefined = only referenced (counts when the vault holds it). */
    declared?: 'secret' | 'variable'
    /** The files that read it, relative to the folder. */
    files: string[]
}

export const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/

/**
 * What every script of a folder (a skill's, a routine's) reads from the
 * environment: the names their headers declare and the `$NAME`s they use.
 * A script is a file with a script's extension or a shebang; dotfiles,
 * node_modules and files over 256 KB are skipped.
 */
export function folderNeeds(dir: string): FolderNeed[] {
    const needs = new Map<string, FolderNeed>()
    const walk = (sub: string) => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
            const rel = sub ? `${sub}/${entry.name}` : entry.name
            if (entry.isDirectory()) {
                walk(rel)
                continue
            }
            if (!entry.isFile()) continue
            const full = path.join(dir, rel)
            let text: string | null
            try {
                text = readSmallFile(full, 256 * 1024)
            } catch {
                continue
            }
            if (text === null) continue
            if (!SCRIPT_EXT.test(entry.name) && !text.startsWith('#!')) continue
            const info = describeScript(text)
            const add = (name: string, declared?: 'secret' | 'variable') => {
                const need = needs.get(name) ?? { name, files: [] }
                if (declared && !need.declared) need.declared = declared
                if (!need.files.includes(rel)) need.files.push(rel)
                needs.set(name, need)
            }
            for (const name of info.declared) add(name, info.variables.includes(name) ? 'variable' : 'secret')
            for (const name of info.referenced) add(name)
        }
    }
    walk('')
    return [...needs.values()].sort((a, b) => a.name.localeCompare(b.name))
}
