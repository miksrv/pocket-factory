import type { CatalogEntry } from '../files/catalog.js'
import { type Cron, describeCron, isTimeZone, parseCron, parseWindow, type Window } from './cron.js'

/**
 * A schedule file: `<config>/schedules/<name>.md`. The frontmatter says when
 * and what; the body is the instruction the agent gets every run (and edits
 * itself to remember decisions). Everything here is what the scheduler
 * needs from the frontmatter, validated once per tick.
 */
export interface CommandPrefilter {
    kind: 'command'
    /** A shell command (bash). Empty output = nothing to do; each line, or a JSON array, = the items handed to the agent. */
    run: string
    /** Working directory; defaults to the project's checkout, else the workspaces root. */
    cwd?: string
    timeout_s: number
}

export interface GithubPrefilter {
    kind: 'github-prs'
    /** `owner/name`; defaults to the project's repository. */
    repo?: string
    /** Which open pull requests count: every one, those asking for the owner's review, or those mentioning the owner. */
    filter: 'open' | 'review-requested' | 'mentioned'
    /** Include the owner's own pull requests. */
    mine: boolean
    drafts: boolean
}

export interface TracPrefilter {
    kind: 'trac'
    /** Base URL of the Trac instance (`…/login` when the server authenticates that path); defaults to TRAC_URL. */
    url?: string
    /** Trac query string, e.g. `status=new&component=Foo`. */
    query: string
    /** A ticket comes up again when it changes (key = id + change time), not only when it is new. */
    on_change: boolean
    max: number
}

export type Prefilter = CommandPrefilter | GithubPrefilter | TracPrefilter

export interface ScheduleHost {
    host: string
    path?: string
    notes?: string
}
export const PREFILTER_KINDS = ['command', 'github-prs', 'trac'] as const

export interface ScheduleSpec {
    name: string
    cron: Cron
    /** Human reading of the cron. */
    cron_text: string
    tz: string
    window: Window
    enabled: boolean
    project: string | null
    /** Servers the run works on, the way a project lists them: a shared host by name plus the schedule's own path and notes there. */
    hosts: ScheduleHost[]
    skill: string | null
    agent: string | null
    /** Free text handed to the agent as the mode of the run: `report`, `fix`, `comment`, … */
    action: string | null
    prefilter: Prefilter | null
    notify: 'telegram' | 'none'
    /** `fresh`: every run starts a new session (memory is the file); `continue`: the runs share one session. */
    session: 'fresh' | 'continue'
    /** What the first ever run does with what the prefilter finds: mark it seen (a poller starts from now) or hand it to the agent. */
    first_run: 'skip' | 'process'
    /** At most this many new items per run; the rest wait for the next one. */
    max_items: number
}

export interface Refs {
    projectExists: (slug: string) => boolean
    hostExists: (name: string) => boolean
    skillExists: (name: string) => boolean
    agentExists: (name: string) => boolean
}

export interface ParsedSchedule {
    name: string
    entry: CatalogEntry
    /** null when `errors` is not empty. */
    spec: ScheduleSpec | null
    /** What stops the schedule from firing. */
    errors: string[]
    /** What the owner should look at; the schedule still fires. */
    warnings: string[]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'string' ? !['false', 'no', 'off', '0'].includes(v.toLowerCase()) : fallback)
const int = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

/** `hosts:` entries: `- host: <name>` with optional path / notes (the project form), or bare names (the first schedule form). */
function hostList(raw: unknown): ScheduleHost[] {
    if (!Array.isArray(raw)) return []
    return raw.flatMap((h): ScheduleHost[] => {
        if (typeof h === 'string') return h.trim() ? [{ host: h.trim() }] : []
        if (!h || typeof h !== 'object') return []
        const o = h as Record<string, unknown>
        const host = str(o.host)
        if (!host) return []
        return [{ host, path: str(o.path), notes: str(o.notes) }]
    })
}

function parsePrefilter(raw: unknown, errors: string[]): Prefilter | null {
    if (raw === undefined || raw === null || raw === '' || raw === false) return null
    if (typeof raw !== 'object') {
        errors.push('prefilter must be a mapping with a `kind`')
        return null
    }
    const p = raw as Record<string, unknown>
    const kind = str(p.kind)
    switch (kind) {
        case 'command': {
            const run = typeof p.run === 'string' ? p.run.trim() : ''
            if (!run) errors.push('prefilter.run is required for kind command')
            return { kind, run, cwd: str(p.cwd), timeout_s: int(p.timeout_s, 120, 5, 900) }
        }
        case 'github-prs': {
            const filter = str(p.filter) ?? 'open'
            if (!['open', 'review-requested', 'mentioned'].includes(filter)) errors.push(`prefilter.filter must be open, review-requested or mentioned (got "${filter}")`)
            const repo = str(p.repo)
            if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push('prefilter.repo must be owner/name')
            return { kind, repo, filter: filter as GithubPrefilter['filter'], mine: bool(p.mine, false), drafts: bool(p.drafts, false) }
        }
        case 'trac': {
            const query = str(p.query) ?? ''
            if (!query) errors.push('prefilter.query is required for kind trac (a Trac query string, e.g. status=new&component=Foo)')
            const url = str(p.url)
            if (url && !/^https?:\/\//.test(url)) errors.push('prefilter.url must start with http:// or https://')
            return { kind, url, query, on_change: bool(p.on_change, true), max: int(p.max, 100, 1, 500) }
        }
        case undefined:
            errors.push('prefilter.kind is required')
            return null
        default:
            errors.push(`unknown prefilter kind "${kind}" (command, github-prs, trac)`)
            return null
    }
}

export function parseSchedule(entry: CatalogEntry, defaults: { tz: string }, refs: Refs): ParsedSchedule {
    const fm = entry.frontmatter
    const errors: string[] = []
    const warnings: string[] = []
    if (entry.frontmatter_error) errors.push(`frontmatter is not valid YAML: ${entry.frontmatter_error}`)

    let cron: Cron | null = null
    const cronText = str(fm.cron)
    if (!cronText) errors.push('cron is required (five fields, e.g. "0 * * * *")')
    else {
        try {
            cron = parseCron(cronText)
        } catch (e) {
            errors.push(`cron: ${(e as Error).message}`)
        }
    }
    const tz = str(fm.tz) ?? defaults.tz
    if (!isTimeZone(tz)) errors.push(`tz "${tz}" is not a known time zone (IANA name such as Europe/Warsaw)`)
    let window: Window = {}
    try {
        window = parseWindow(fm.window)
    } catch (e) {
        errors.push((e as Error).message)
    }

    const project = str(fm.project) ?? null
    if (project && !refs.projectExists(project)) errors.push(`project "${project}" has no file or its checkout is missing`)
    const hosts = hostList(fm.hosts)
    for (const h of hosts) if (!refs.hostExists(h.host)) warnings.push(`host "${h.host}" is not in hosts.yaml`)
    const skill = str(fm.skill) ?? null
    if (skill && !refs.skillExists(skill)) warnings.push(`skill "${skill}" is not installed`)
    const agent = str(fm.agent) ?? null
    if (agent && !refs.agentExists(agent)) warnings.push(`agent "${agent}" does not exist`)

    const prefilter = parsePrefilter(fm.prefilter, errors)
    if (prefilter?.kind === 'github-prs' && !prefilter.repo && !project) errors.push('prefilter github-prs needs a `repo` or a `project` with a repository')

    const notify = str(fm.notify) ?? 'telegram'
    if (notify !== 'telegram' && notify !== 'none') errors.push('notify must be telegram or none')
    const session = str(fm.session) ?? 'fresh'
    if (session !== 'fresh' && session !== 'continue') errors.push('session must be fresh or continue')
    const firstRun = str(fm.first_run) ?? (prefilter?.kind === 'command' || !prefilter ? 'process' : 'skip')
    if (firstRun !== 'skip' && firstRun !== 'process') errors.push('first_run must be skip or process')
    if (!entry.body.trim()) warnings.push('the instructions are empty: the agent only gets the prefilter items')

    if (errors.length || !cron) return { name: entry.name, entry, spec: null, errors, warnings }
    return {
        name: entry.name,
        entry,
        errors,
        warnings,
        spec: {
            name: entry.name,
            cron,
            cron_text: describeCron(cron),
            tz,
            window,
            enabled: bool(fm.enabled, true),
            project,
            hosts,
            skill,
            agent,
            action: str(fm.action) ?? null,
            prefilter,
            notify: notify as ScheduleSpec['notify'],
            session: session as ScheduleSpec['session'],
            first_run: firstRun as ScheduleSpec['first_run'],
            max_items: int(fm.max_items, 10, 1, 100)
        }
    }
}
