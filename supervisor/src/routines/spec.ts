import { isModelAlias, MODEL_ALIASES } from '../claude/models.js'
import type { CatalogEntry } from '../files/catalog.js'
import { type Cron, describeCron, isTimeZone, parseCron, parseWindow, type Window } from './cron.js'

/**
 * A routine file: `<config>/routines/<name>.md`. The frontmatter says who
 * does it (`agent:`), with what (`skill:`) and when (`triggers:`); the body
 * is the instruction the agent gets every run (and edits itself to remember
 * decisions). Everything here is what the scheduler needs from the
 * frontmatter, validated once per tick.
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

export interface RoutineHost {
    host: string
    path?: string
    notes?: string
}
export const PREFILTER_KINDS = ['command', 'github-prs', 'trac'] as const

/**
 * When a routine runs by itself. A `schedule` starts a run at every minute
 * its cron allows; a `poll` runs its prefilter at those minutes and starts a
 * run only for new items. Run now is not a trigger: it is always there.
 */
export type TriggerKind = 'schedule' | 'poll'

/** The web conversation every run of a routine lands in. The key predates the rename, so threads and history stay. */
export const conversationKey = (name: string) => `schedule:${name}`

/** The routine whose thread a conversation is (its name), or null for the owner's own conversations. */
export const routineOf = (conversation: { channel: string; external_id: string | null }): string | null =>
    conversation.channel === 'web' && conversation.external_id?.startsWith('schedule:')
        ? conversation.external_id.slice('schedule:'.length)
        : null

export interface Trigger {
    kind: TriggerKind
    cron: Cron
    /** Human reading of the cron. */
    cron_text: string
    tz: string
    window: Window
    /** What a poll looks at; null for a schedule. */
    prefilter: Prefilter | null
}

export interface RoutineSpec {
    name: string
    /** Empty = the routine runs only by hand (Run now, /run). */
    triggers: Trigger[]
    /** The prefilter a manual run and the preview use: the first poll's (or a legacy top-level one); null = nothing to look at first. */
    prefilter: Prefilter | null
    enabled: boolean
    project: string | null
    /** Servers the run works on, the way a project lists them: a shared host by name plus the routine's own path and notes there. */
    hosts: RoutineHost[]
    skill: string | null
    agent: string | null
    /** The provider the runs go to (providers.yaml); null = the subscription. The agent file's `provider:` applies when the routine names none. */
    provider: string | null
    /** CLI alias the run's orchestrator uses; null (`inherit`) = the factory's current model. On another provider: that provider's model id, null = its default. */
    model: string | null
    /** Free text handed to the agent as the mode of the run: `report`, `fix`, `comment`, … */
    action: string | null
    notify: 'telegram' | 'none'
    /** `fresh`: every run starts a new session (memory is the file); `continue`: the runs share one session. */
    session: 'fresh' | 'continue'
    /** What the first ever poll does with what the prefilter finds: mark it seen (a poller starts from now) or hand it to the agent. */
    first_run: 'skip' | 'process'
    /** At most this many new items per run; the rest wait for the next one. */
    max_items: number
    /** One-shot: the routine switches itself off once it has queued a task. */
    once: boolean
}

export interface Refs {
    projectExists: (slug: string) => boolean
    hostExists: (name: string) => boolean
    skillExists: (name: string) => boolean
    agentExists: (name: string) => boolean
    providerExists: (name: string) => boolean
    /** The `provider:` / `provider_model:` an agent file carries, for a run that embodies that agent (`model:` stays the CLI's alias). */
    agentProvider: (name: string) => { provider: string | null; model: string | null }
}

export interface ParsedRoutine {
    name: string
    entry: CatalogEntry
    /** null when `errors` is not empty. */
    spec: RoutineSpec | null
    /** What stops the routine from firing. */
    errors: string[]
    /** What the owner should look at; the routine still fires. */
    warnings: string[]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean'
        ? v
        : typeof v === 'string'
          ? !['false', 'no', 'off', '0'].includes(v.toLowerCase())
          : fallback
const int = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}
/** `hosts:` entries: `- host: <name>` with optional path / notes (the project form), or bare names (the first routine form). */
function hostList(raw: unknown): RoutineHost[] {
    if (!Array.isArray(raw)) return []
    return raw.flatMap((h): RoutineHost[] => {
        if (typeof h === 'string') return h.trim() ? [{ host: h.trim() }] : []
        if (!h || typeof h !== 'object') return []
        const o = h as Record<string, unknown>
        const host = str(o.host)
        if (!host) return []
        return [{ host, path: str(o.path), notes: str(o.notes) }]
    })
}

function parsePrefilter(raw: unknown, errors: string[], at = 'prefilter'): Prefilter | null {
    if (raw === undefined || raw === null || raw === '' || raw === false) return null
    if (typeof raw !== 'object') {
        errors.push(`${at} must be a mapping with a \`kind\``)
        return null
    }
    const p = raw as Record<string, unknown>
    const kind = str(p.kind)
    switch (kind) {
        case 'command': {
            const run = typeof p.run === 'string' ? p.run.trim() : ''
            if (!run) errors.push(`${at}.run is required for kind command`)
            return { kind, run, cwd: str(p.cwd), timeout_s: int(p.timeout_s, 120, 5, 900) }
        }
        case 'github-prs': {
            const filter = str(p.filter) ?? 'open'
            if (!['open', 'review-requested', 'mentioned'].includes(filter))
                errors.push(`${at}.filter must be open, review-requested or mentioned (got "${filter}")`)
            const repo = str(p.repo)
            if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push(`${at}.repo must be owner/name`)
            return {
                kind,
                repo,
                filter: filter as GithubPrefilter['filter'],
                mine: bool(p.mine, false),
                drafts: bool(p.drafts, false)
            }
        }
        case 'trac': {
            const query = str(p.query) ?? ''
            if (!query)
                errors.push(
                    `${at}.query is required for kind trac (a Trac query string, e.g. status=new&component=Foo)`
                )
            const url = str(p.url)
            if (url && !/^https?:\/\//.test(url)) errors.push(`${at}.url must start with http:// or https://`)
            return { kind, url, query, on_change: bool(p.on_change, true), max: int(p.max, 100, 1, 500) }
        }
        case undefined:
            errors.push(`${at}.kind is required`)
            return null
        default:
            errors.push(`unknown ${at} kind "${kind}" (command, github-prs, trac)`)
            return null
    }
}

/** One trigger's cron, zone and window; `at` names it in errors. Null when the cron does not parse. */
function parseTrigger(
    kind: TriggerKind,
    cronRaw: unknown,
    o: { tz?: unknown; window?: unknown },
    defaults: { tz: string; window: Window },
    prefilter: Prefilter | null,
    errors: string[],
    at: string
): Trigger | null {
    let cron: Cron | null = null
    const cronText = str(cronRaw)
    if (!cronText) errors.push(`${at} needs a cron (five fields, e.g. "0 * * * *")`)
    else {
        try {
            cron = parseCron(cronText)
        } catch (e) {
            errors.push(`${at}: ${(e as Error).message}`)
        }
    }
    const tz = str(o.tz) ?? defaults.tz
    if (o.tz !== undefined && !isTimeZone(tz))
        errors.push(`${at}.tz "${tz}" is not a known time zone (IANA name such as Europe/Warsaw)`)
    let window = defaults.window
    if (o.window !== undefined) {
        try {
            window = parseWindow(o.window)
        } catch (e) {
            errors.push(`${at}.${(e as Error).message}`)
        }
    }
    return cron ? { kind, cron, cron_text: describeCron(cron), tz, window, prefilter } : null
}

/**
 * `triggers:` is a list of `- schedule: <cron>` and `- poll: <cron>` + `prefilter:`
 * entries, each with its own `tz:` / `window:` on top of the file's. A file
 * without it is read the old way: `cron:` alone is one schedule, `cron:` with
 * `prefilter:` one poll.
 */
function parseTriggers(
    fm: Record<string, unknown>,
    defaults: { tz: string; window: Window },
    errors: string[],
    warnings: string[]
): { triggers: Trigger[]; prefilter: Prefilter | null } {
    if (fm.triggers === undefined || fm.triggers === null) {
        const prefilter = parsePrefilter(fm.prefilter, errors)
        if (fm.cron === undefined || fm.cron === null || fm.cron === '') {
            if (prefilter) warnings.push('prefilter: without cron: or triggers: is only used by Run now')
            return { triggers: [], prefilter }
        }
        const trigger = parseTrigger(prefilter ? 'poll' : 'schedule', fm.cron, {}, defaults, prefilter, errors, 'cron')
        return { triggers: trigger ? [trigger] : [], prefilter }
    }
    if (!Array.isArray(fm.triggers)) {
        errors.push('triggers must be a list of `- schedule: <cron>` and `- poll: <cron>` entries')
        return { triggers: [], prefilter: null }
    }
    if (fm.cron !== undefined || fm.prefilter !== undefined)
        warnings.push('cron: and prefilter: are ignored when triggers: is set; move them under a trigger')
    const triggers: Trigger[] = []
    fm.triggers.forEach((raw, i) => {
        const at = `triggers[${i + 1}]`
        if (!raw || typeof raw !== 'object') {
            errors.push(`${at} must be a mapping with \`schedule:\` or \`poll:\``)
            return
        }
        const o = raw as Record<string, unknown>
        const isSchedule = o.schedule !== undefined
        const isPoll = o.poll !== undefined
        if (isSchedule === isPoll) {
            errors.push(`${at} must have exactly one of \`schedule:\` or \`poll:\` (a cron)`)
            return
        }
        let prefilter: Prefilter | null = null
        if (isPoll) {
            prefilter = parsePrefilter(o.prefilter, errors, `${at}.prefilter`)
            if (o.prefilter === undefined) errors.push(`${at}: a poll needs a prefilter (what to look at)`)
        } else if (o.prefilter !== undefined) warnings.push(`${at}: a schedule has no prefilter; use poll: for that`)
        const trigger = parseTrigger(
            isPoll ? 'poll' : 'schedule',
            isPoll ? o.poll : o.schedule,
            o,
            defaults,
            prefilter,
            errors,
            at
        )
        if (trigger) triggers.push(trigger)
    })
    return { triggers, prefilter: triggers.find((t) => t.prefilter)?.prefilter ?? null }
}

export function parseRoutine(entry: CatalogEntry, defaults: { tz: string }, refs: Refs): ParsedRoutine {
    const fm = entry.frontmatter
    const errors: string[] = []
    const warnings: string[] = []
    if (entry.frontmatter_error) errors.push(`frontmatter is not valid YAML: ${entry.frontmatter_error}`)

    // The file's zone and window are the defaults for every trigger.
    const tz = str(fm.tz) ?? defaults.tz
    if (!isTimeZone(tz)) errors.push(`tz "${tz}" is not a known time zone (IANA name such as Europe/Warsaw)`)
    let window: Window = {}
    try {
        window = parseWindow(fm.window)
    } catch (e) {
        errors.push((e as Error).message)
    }
    const { triggers, prefilter } = parseTriggers(
        fm,
        { tz: isTimeZone(tz) ? tz : defaults.tz, window },
        errors,
        warnings
    )

    const project = str(fm.project) ?? null
    if (project && !refs.projectExists(project))
        errors.push(`project "${project}" has no file or its checkout is missing`)
    const hosts = hostList(fm.hosts)
    for (const h of hosts) if (!refs.hostExists(h.host)) warnings.push(`host "${h.host}" is not in hosts.yaml`)
    const skill = str(fm.skill) ?? null
    if (skill && !refs.skillExists(skill)) warnings.push(`skill "${skill}" is not installed`)
    const agent = str(fm.agent) ?? null
    if (agent && !refs.agentExists(agent)) warnings.push(`agent "${agent}" does not exist`)
    // `provider:` in the file, else the agent's own; `model:` is validated only for the subscription (other providers name their own ids).
    const own = str(fm.provider) ?? null
    const fromAgent = agent && !own ? refs.agentProvider(agent) : null
    const provider = own ?? fromAgent?.provider ?? null
    if (provider && !refs.providerExists(provider))
        errors.push(`provider "${provider}" is not in providers.yaml (Settings → Providers)`)
    const modelRaw = str(fm.model) ?? (fromAgent?.provider ? (fromAgent.model ?? undefined) : undefined)
    const model = !modelRaw || modelRaw === 'inherit' ? null : modelRaw
    if (model && !provider && !isModelAlias(model))
        errors.push(`model must be inherit or one of ${MODEL_ALIASES.join(', ')} (got "${model}")`)

    const prefilters = [prefilter, ...triggers.map((t) => t.prefilter)].filter((p): p is Prefilter => p !== null)
    if (prefilters.some((p) => p.kind === 'github-prs' && !p.repo) && !project)
        errors.push('prefilter github-prs needs a `repo` or a `project` with a repository')

    const notify = str(fm.notify) ?? 'telegram'
    if (notify !== 'telegram' && notify !== 'none') errors.push('notify must be telegram or none')
    const session = str(fm.session) ?? 'fresh'
    if (session !== 'fresh' && session !== 'continue') errors.push('session must be fresh or continue')
    const firstRun = str(fm.first_run) ?? (prefilter?.kind === 'command' || !prefilter ? 'process' : 'skip')
    if (firstRun !== 'skip' && firstRun !== 'process') errors.push('first_run must be skip or process')
    if (!entry.body.trim()) warnings.push('the instructions are empty: the agent only gets the prefilter items')

    if (errors.length) return { name: entry.name, entry, spec: null, errors, warnings }
    return {
        name: entry.name,
        entry,
        errors,
        warnings,
        spec: {
            name: entry.name,
            triggers,
            prefilter,
            enabled: bool(fm.enabled, true),
            project,
            hosts,
            skill,
            agent,
            provider,
            model,
            action: str(fm.action) ?? null,
            notify: notify as RoutineSpec['notify'],
            session: session as RoutineSpec['session'],
            first_run: firstRun as RoutineSpec['first_run'],
            max_items: int(fm.max_items, 10, 1, 100),
            once: bool(fm.once, false)
        }
    }
}
