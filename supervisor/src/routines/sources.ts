import { execFile } from 'node:child_process'

import type { GithubStep, TracStep } from './spec.js'

/** What a source found: one thing the agent should look at. `key` is what dedup works on. */
export interface Item {
    key: string
    title: string
    text?: string
    url?: string
    /** Set by the scheduler: an earlier version of this item (same id, older change time or commit) was handed over at this time. */
    seen_before?: string
}

export interface SourceContext {
    cwd: string
    env: NodeJS.ProcessEnv
    /** The routine's project, when it has one. */
    project: { slug: string; repo: string | null } | null
}

export class SourceError extends Error {}

/**
 * The built-in sources of a routine's pipeline, no LLM: GitHub pull requests
 * and Trac tickets. A `run` step with `items` is the third kind; `steps.ts`
 * runs it and parses its output with `parseItems`.
 */
export function runSource(step: GithubStep | TracStep, ctx: SourceContext): Promise<Item[]> {
    return step.kind === 'github-prs' ? runGithub(step, ctx) : runTrac(step, ctx.env)
}

function exec(
    file: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { ...options, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
            if (error) {
                const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
                const tail = (stderr || stdout || '').trim().split('\n').slice(-5).join('\n')
                reject(
                    new SourceError(
                        killed
                            ? `timed out after ${options.timeout / 1000} s`
                            : `${file} exited with ${(error as { code?: number }).code ?? 'an error'}${tail ? `: ${tail}` : ''}`
                    )
                )
            } else resolve({ stdout, stderr })
        })
    })
}

/** A source's output as items: one per line (`key<TAB>title`, or the line as both), or a JSON array of strings / {key, title, text, url}. */
export function parseItems(output: string): Item[] {
    const text = output.trim()
    if (!text) return []
    if (text.startsWith('[')) {
        let parsed: unknown
        try {
            parsed = JSON.parse(text)
        } catch {
            throw new SourceError('output starts with "[" but is not a JSON array')
        }
        if (!Array.isArray(parsed)) throw new SourceError('output is not a JSON array')
        const seen = new Set<string>()
        const list = parsed.flatMap((raw, i): Item[] => {
            if (typeof raw === 'string') return raw.trim() ? [{ key: raw.trim(), title: raw.trim() }] : []
            if (!raw || typeof raw !== 'object') throw new SourceError(`item ${i} is neither a string nor an object`)
            const o = raw as Record<string, unknown>
            const key = String(o.key ?? o.id ?? o.title ?? '').trim()
            if (!key) throw new SourceError(`item ${i} has no key`)
            return [
                {
                    key,
                    title: String(o.title ?? key),
                    text: typeof o.text === 'string' ? o.text : undefined,
                    url: typeof o.url === 'string' ? o.url : undefined
                }
            ]
        })
        // The first of a repeated key wins, as in the line form.
        return list.filter((item) => !seen.has(item.key) && Boolean(seen.add(item.key)))
    }
    const items: Item[] = []
    const keys = new Set<string>()
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const tab = trimmed.indexOf('\t')
        const key = (tab > 0 ? trimmed.slice(0, tab) : trimmed).trim()
        const title = (tab > 0 ? trimmed.slice(tab + 1) : trimmed).trim()
        if (keys.has(key)) continue
        keys.add(key)
        items.push({ key, title })
    }
    return items
}

// ---- GitHub pull requests -------------------------------------------------

/** `https://github.com/owner/name(.git)`, a page under it (`…/pulls`) or `git@github.com:owner/name.git` → `owner/name`. */
export function repoSlug(url: string | null | undefined): string | null {
    if (!url) return null
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(url.trim())
    return m ? `${m[1]}/${m[2]}` : null
}

interface GhPr {
    number: number
    title: string
    url: string
    isDraft: boolean
    headRefOid: string
    updatedAt: string
    author?: { login?: string }
    baseRefName?: string
}

/**
 * Open pull requests of the step's repositories through `gh` (the owner's
 * token, the image's per-owner wrapper), one after another. The key carries
 * the head commit, so a new push to a reviewed PR brings it up again and an
 * untouched one stays quiet.
 */
async function runGithub(spec: GithubStep, ctx: SourceContext): Promise<Item[]> {
    const fallback = repoSlug(ctx.project?.repo)
    const repos = spec.repos.length ? spec.repos : fallback ? [fallback] : []
    if (!repos.length)
        throw new SourceError('no repository: set repo (owner/name) on the step or a project with a GitHub repo URL')
    const items: Item[] = []
    for (const repo of repos) items.push(...(await githubPrs(repo, spec, ctx)))
    return items
}

async function githubPrs(repo: string, spec: GithubStep, ctx: SourceContext): Promise<Item[]> {
    const search: string[] = []
    if (spec.filter === 'review-requested') search.push('review-requested:@me')
    if (spec.filter === 'mentioned') search.push('mentions:@me')
    if (!spec.mine) search.push('-author:@me')
    const args = [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--limit',
        '50',
        '--json',
        'number,title,url,isDraft,headRefOid,updatedAt,author,baseRefName'
    ]
    if (search.length) args.push('--search', search.join(' '))
    const { stdout } = await exec('gh', args, { cwd: ctx.cwd, env: ctx.env, timeout: 60_000 })
    let prs: GhPr[]
    try {
        prs = JSON.parse(stdout) as GhPr[]
    } catch {
        throw new SourceError(`gh returned something other than JSON for ${repo}`)
    }
    return prs
        .filter((pr) => spec.drafts || !pr.isDraft)
        .map((pr) => ({
            key: `${repo}#${pr.number}@${pr.headRefOid.slice(0, 12)}`,
            title: `${repo}#${pr.number} ${pr.title}`,
            url: pr.url,
            text: [
                pr.author?.login ? `by ${pr.author.login}` : null,
                pr.baseRefName ? `into ${pr.baseRefName}` : null,
                `head ${pr.headRefOid.slice(0, 7)}`,
                `updated ${pr.updatedAt}`,
                pr.isDraft ? 'draft' : null
            ]
                .filter(Boolean)
                .join(' · ')
        }))
}

// ---- Trac -----------------------------------------------------------------

/** Trac's CSV export of a query: quoted fields, embedded newlines, `""` escapes. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    const src = text.startsWith('﻿') ? text.slice(1) : text
    for (let i = 0; i < src.length; i++) {
        const ch = src[i]
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"'
                    i++
                } else quoted = false
            } else field += ch
            continue
        }
        if (ch === '"') quoted = true
        else if (ch === ',') {
            row.push(field)
            field = ''
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++
            row.push(field)
            field = ''
            rows.push(row)
            row = []
        } else field += ch
    }
    if (field || row.length) {
        row.push(field)
        rows.push(row)
    }
    return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}

const TRAC_COLUMNS = [
    'id',
    'summary',
    'status',
    'component',
    'severity',
    'priority',
    'owner',
    'reporter',
    'milestone',
    'time',
    'changetime'
]

/** Column labels of Trac's CSV that are not their field's name. */
const TRAC_LABELS: Record<string, string> = { modified: 'changetime', created: 'time' }

/**
 * A Trac query as CSV (`/query?…&format=csv`), the site and the query from
 * the step. Credentials from the run's environment (Settings → Secrets), shared by every Trac step: TRAC_USER + TRAC_PASSWORD as basic auth (point `url` at the
 * `/login` path when the server authenticates there), or TRAC_COOKIE with a
 * browser session's `trac_auth` value. The key is `id@changetime` by
 * default, so a ticket that changed after the agent looked at it (a reply,
 * a status change) comes up again.
 */
async function runTrac(spec: TracStep, env: NodeJS.ProcessEnv): Promise<Item[]> {
    const base = spec.url
    const params = new URLSearchParams(spec.query)
    params.set('format', 'csv')
    params.set('max', String(spec.max))
    params.delete('col')
    for (const col of TRAC_COLUMNS) params.append('col', col)
    if (!params.has('order')) {
        params.set('order', 'changetime')
        params.set('desc', '1')
    }
    // No Accept-Language: Trac then writes dates in its stable en_US form, not a locale's short one.
    const headers: Record<string, string> = { accept: 'text/csv', 'accept-language': '' }
    if (env.TRAC_USER && env.TRAC_PASSWORD)
        headers.authorization = `Basic ${Buffer.from(`${env.TRAC_USER}:${env.TRAC_PASSWORD}`).toString('base64')}`
    if (env.TRAC_COOKIE)
        headers.cookie = env.TRAC_COOKIE.includes('=') ? env.TRAC_COOKIE : `trac_auth=${env.TRAC_COOKIE}`
    const url = `${base}/query?${params.toString()}`
    let response: Response
    try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000), redirect: 'manual' })
    } catch (error) {
        throw new SourceError(`Trac unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 401 || response.status === 403)
        throw new SourceError(
            `Trac refused the credentials (${response.status}); check TRAC_USER / TRAC_PASSWORD or TRAC_COOKIE in Settings → Secrets, and whether the URL needs /login`
        )
    if (response.status >= 300 && response.status < 400)
        throw new SourceError(
            `Trac redirected (${response.status} → ${response.headers.get('location') ?? '?'}): the query probably needs a login`
        )
    if (!response.ok) throw new SourceError(`Trac answered ${response.status}`)
    const text = await response.text()
    if (/<html/i.test(text.slice(0, 200)))
        throw new SourceError(
            'Trac answered with HTML instead of CSV: a login page, or format=csv is not allowed for this user'
        )
    const rows = parseCsv(text)
    if (rows.length === 0) return []
    // Trac heads its CSV with the columns' labels: lower-cased they are the field names, but two.
    const header = rows[0].map((h) => {
        const name = h.trim().toLowerCase()
        return TRAC_LABELS[name] ?? name
    })
    const idCol = header.indexOf('id')
    if (idCol < 0) throw new SourceError(`Trac CSV has no id column (header: ${rows[0].join(', ')})`)
    const col = (row: string[], name: string) => {
        const i = header.indexOf(name)
        return i >= 0 ? (row[i] ?? '').trim() : ''
    }
    // Tickets live at <base>/ticket/<id>; a base that ends in /login points one level above.
    const site = base.replace(/\/login$/, '')
    return rows.slice(1).flatMap((row): Item[] => {
        const id = col(row, 'id')
        if (!/^\d+$/.test(id)) return []
        const changed = col(row, 'changetime')
        const summary = col(row, 'summary')
        const facts = ['status', 'component', 'severity', 'priority', 'owner', 'reporter', 'milestone']
            .map((f) => (col(row, f) ? `${f} ${col(row, f)}` : null))
            .filter(Boolean)
        return [
            {
                key: spec.on_change && changed ? `${id}@${changed}` : id,
                title: `#${id} ${summary}`,
                url: `${site}/ticket/${id}`,
                text: [...facts, changed ? `changed ${changed}` : null].filter(Boolean).join(' · ')
            }
        ]
    })
}
