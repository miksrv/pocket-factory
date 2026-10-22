import { isModelAlias, MODEL_ALIASES } from '../claude/models.js'
import type { CatalogEntry } from '../files/catalog.js'
import { type Cron, describeCron, isTimeZone, parseCron, parseWindow, type Window } from './cron.js'
import { repoSlug } from './sources.js'

/**
 * A routine file: `<config>/routines/<name>.md`. The frontmatter says when
 * it runs (`triggers:`, crons) and what the run is (`steps:`, the pipeline:
 * scripts and sources in order, the agent as the last step); the body is
 * the instruction the agent step gets every run (and edits itself to
 * remember decisions). Everything here is what the scheduler needs from the
 * frontmatter, validated once per tick.
 */

/** A script: bash in the checkout. Its output goes to the agent as text, or as items when `items` is on. */
export interface RunStep {
    kind: 'run'
    name: string
    run: string
    /** Working directory, relative to the checkout (or the workspaces root). */
    cwd?: string
    timeout_s: number
    /** The output is a list of items (`key<TAB>title` per line, or a JSON array): the step is a source, and nothing found means no agent. */
    items: boolean
    /** A source hands over only what no earlier run has seen (keys in `seen_items`). */
    new_only: boolean
    /** A failure does not stop the run: the next steps and the agent still go, the error reaches the agent as this step's output. */
    continue_on_error: boolean
    /** Off: a run skips it (Run on its card still tries it). */
    enabled: boolean
    /**
     * A step after the agent runs once the agent's task has ended: when it succeeded (`success`, the
     * default), when it failed (`failure`), or whatever happened, stopped by the owner too (`always`).
     */
    if: 'success' | 'failure' | 'always'
}

/** Open pull requests of a repository, through `gh`. Always a source. */
export interface GithubStep {
    kind: 'github-prs'
    name: string
    /** `owner/name` each (`repo:` is one or a list); none = the project's repository. */
    repos: string[]
    /** Which open pull requests count: every one, those asking for the owner's review, or those mentioning the owner. */
    filter: 'open' | 'review-requested' | 'mentioned'
    /** Include the owner's own pull requests. */
    mine: boolean
    drafts: boolean
    new_only: boolean
    /** A failure does not stop the run: the next steps and the agent still go, the error reaches the agent as this step's output. */
    continue_on_error: boolean
    /** Off: a run skips it (Run on its card still tries it). */
    enabled: boolean
}

/** Tickets of a Trac query. Always a source. */
export interface TracStep {
    kind: 'trac'
    name: string
    /** The Trac site, from the custom query's address (`…/login` when the server authenticates that path). */
    url: string
    /** Trac query string, e.g. `status=new&component=Foo`. */
    query: string
    /** A ticket comes up again when it changes (key = id + change time), not only when it is new. */
    on_change: boolean
    max: number
    new_only: boolean
    /** A failure does not stop the run: the next steps and the agent still go, the error reaches the agent as this step's output. */
    continue_on_error: boolean
    /** Off: a run skips it (Run on its card still tries it). */
    enabled: boolean
}

/** The agent: the task that reads the instructions and what the steps before it found. At most one, the last. */
export interface AgentStep {
    kind: 'agent'
    name: string
    /** The agent file the run is (`claude --agent`); null = the orchestrator reads the instructions and decides. */
    agent: string | null
    /** A skill of data/claude/skills given in the prompt. */
    skill: string | null
}

export type Step = RunStep | GithubStep | TracStep | AgentStep
/** A step that finds items (a source): a run with `items`, a GitHub or a Trac step. */
export type SourceStep = RunStep | GithubStep | TracStep

export const isSource = (step: Step): step is SourceStep =>
    step.kind === 'github-prs' || step.kind === 'trac' || (step.kind === 'run' && step.items)

export const STEP_KINDS = ['run', 'github-prs', 'trac', 'agent'] as const

export interface RoutineHost {
    host: string
    path?: string
    notes?: string
}

/** The web conversation every run of a routine lands in. The key predates the rename, so threads and history stay. */
export const conversationKey = (name: string) => `schedule:${name}`

/** The routine whose thread a conversation is (its name), or null for the owner's own conversations. */
export const routineOf = (conversation: { channel: string; external_id: string | null }): string | null =>
    conversation.channel === 'web' && conversation.external_id?.startsWith('schedule:')
        ? conversation.external_id.slice('schedule:'.length)
        : null

/** When a routine runs by itself: a cron, each with its own zone and window on top of the file's. */
export interface Trigger {
    kind: 'schedule'
    cron: Cron
    /** Human reading of the cron. */
    cron_text: string
    tz: string
    window: Window
}

export interface RoutineSpec {
    name: string
    /** Empty = the routine runs only by hand (Run now, /run). */
    triggers: Trigger[]
    /** The pipeline, in order: the steps before the agent, the agent step (if any), the scripts after it. */
    steps: Step[]
    /** The agent step, or null for a routine that is scripts only. */
    agentStep: AgentStep | null
    /** The scripts after the agent step: they run when its task has ended (`if:`). */
    after: RunStep[]
    /** Shortcuts of the agent step: who the run is (null = the orchestrator) and its skill. */
    agent: string | null
    skill: string | null
    enabled: boolean
    project: string | null
    /** Servers the run works on, the way a project lists them: a shared host by name plus the routine's own path and notes there. */
    hosts: RoutineHost[]
    /** The provider the runs go to (providers.yaml); null = the subscription. The agent file's `provider:` applies when the routine names none. */
    provider: string | null
    /** CLI alias the run's orchestrator uses; null (`inherit`) = the factory's current model. On another provider: that provider's model id, null = its default. */
    model: string | null
    notify: 'telegram' | 'none'
    /** `fresh`: every run starts a new session (memory is the file); `continue`: the runs share one session. */
    session: 'fresh' | 'continue'
    /** What the first ever timed run does with what a `new_only` source finds: mark it seen (start from now) or hand it to the agent. */
    first_run: 'skip' | 'process'
    /** At most this many new items per run; the rest wait for the next one. */
    max_items: number
    /** One-shot: the routine switches itself off once it has queued a task. */
    once: boolean
    /** The projects a run may hand work to (`hand_off:`); none = the run has no `hand_off` tool. */
    hand_off: string[]
}

/** `hand_off:` of a routine file: the projects its runs may open a chat in (a name or a list). */
export function handOffProjects(fm: Record<string, unknown>): string[] {
    const raw = Array.isArray(fm.hand_off) ? fm.hand_off : [fm.hand_off]
    return [...new Set(raw.map(str).filter((p): p is string => p !== undefined))]
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

/** A repository's GitHub address (https, ssh or scp-like), as opposed to owner/name. */
const GITHUB_ADDRESS = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[/:]/i

const KINDS = ['run', 'github-prs', 'trac', 'agent'] as const

/**
 * One step of `steps:`. A mapping with exactly one of `run:`, `github-prs:`,
 * `trac:` or `agent:` (its value is the command, the options, or the agent's
 * name); a bare string is a `run:`. The old `prefilter:` shape (`kind:` +
 * options) is read as the same step, always a source that hands new items.
 */
function parseStep(raw: unknown, errors: string[], at: string, index: number): Step | null {
    const o: Record<string, unknown> | null =
        typeof raw === 'string'
            ? { run: raw }
            : raw && typeof raw === 'object'
              ? (raw as Record<string, unknown>)
              : null
    if (!o) {
        errors.push(`${at} must be a command or a mapping with \`run:\`, \`github-prs:\`, \`trac:\` or \`agent:\``)
        return null
    }
    const legacyKind = str(o.kind)
    if (legacyKind) {
        // The old prefilter shape: { kind, …options } → the step of that kind, a source.
        const { kind: _kind, ...rest } = o
        if (legacyKind === 'command') return parseStep({ ...rest, run: rest.run ?? '', items: true }, errors, at, index)
        if (legacyKind === 'github-prs' || legacyKind === 'trac')
            return parseStep({ name: rest.name, [legacyKind]: rest }, errors, at, index)
        errors.push(`${at}: unknown kind "${legacyKind}" (run, github-prs, trac, agent)`)
        return null
    }
    const kinds = KINDS.filter((k) => o[k] !== undefined)
    if (kinds.length !== 1) {
        errors.push(`${at} must have exactly one of \`run:\`, \`github-prs:\`, \`trac:\` or \`agent:\``)
        return null
    }
    const kind = kinds[0]
    const name = str(o.name)
    switch (kind) {
        case 'run': {
            const run = typeof o.run === 'string' ? o.run.trim() : ''
            if (!run) errors.push(`${at}.run is required (a bash command)`)
            const items = bool(o.items, false)
            const when = str(o.if) ?? 'success'
            if (!['success', 'failure', 'always'].includes(when))
                errors.push(`${at}.if must be success, failure or always (got "${when}")`)
            return {
                kind,
                name: name ?? `step ${index + 1}`,
                run,
                cwd: str(o.cwd),
                timeout_s: int(o.timeout_s, 300, 5, 3600),
                items,
                new_only: items && bool(o.new_only, true),
                continue_on_error: bool(o.continue_on_error, false),
                enabled: bool(o.enabled, true),
                if: when as RunStep['if']
            }
        }
        case 'github-prs': {
            const p = (o['github-prs'] && typeof o['github-prs'] === 'object' ? o['github-prs'] : {}) as Record<
                string,
                unknown
            >
            const filter = str(p.filter) ?? 'open'
            if (!['open', 'review-requested', 'mentioned'].includes(filter))
                errors.push(`${at}.filter must be open, review-requested or mentioned (got "${filter}")`)
            // `repo:` is one repository or a list; the address as the browser has it reads as owner/name too.
            const given = (Array.isArray(p.repo) ? (p.repo as unknown[]) : [p.repo])
                .map(str)
                .filter((r) => r !== undefined)
            const repos = [...new Set(given.map((r) => (GITHUB_ADDRESS.test(r) ? (repoSlug(r) ?? r) : r)))]
            for (const repo of repos)
                if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
                    errors.push(`${at}.repo "${repo}" must be owner/name or the repository's GitHub address`)
            return {
                kind,
                name: name ?? (repos.length === 1 ? `PRs of ${repos[0]}` : 'pull requests'),
                repos,
                filter: filter as GithubStep['filter'],
                mine: bool(p.mine, false),
                drafts: bool(p.drafts, false),
                new_only: bool(p.new_only ?? o.new_only, true),
                continue_on_error: bool(o.continue_on_error, false),
                enabled: bool(o.enabled, true)
            }
        }
        case 'trac': {
            const p = (o.trac && typeof o.trac === 'object' ? o.trac : {}) as Record<string, unknown>
            // `url` is the address of a custom query, as the browser has it: the site, then the query.
            const [site, inUrl] = (str(p.url) ?? '').split(/\?(.*)/s, 2)
            const url = site.replace(/\/query\/?$/, '').replace(/\/+$/, '')
            const query = [inUrl, str(p.query)].filter(Boolean).join('&')
            if (!url)
                errors.push(
                    `${at}.url is required (a custom query's address, e.g. https://trac.example.com/query?status=new)`
                )
            else if (!/^https?:\/\//.test(url)) errors.push(`${at}.url must start with http:// or https://`)
            else if (!query) errors.push(`${at}.url has no query (the part after ?, e.g. status=new&component=Foo)`)
            return {
                kind,
                name: name ?? 'Trac tickets',
                url,
                query,
                on_change: bool(p.on_change, true),
                max: int(p.max, 100, 1, 500),
                new_only: bool(p.new_only ?? o.new_only, true),
                continue_on_error: bool(o.continue_on_error, false),
                enabled: bool(o.enabled, true)
            }
        }
        case 'agent': {
            const agent = str(o.agent)
            return {
                kind,
                name: name ?? 'agent',
                agent: agent && agent !== 'orchestrator' ? agent : null,
                skill: str(o.skill) ?? null
            }
        }
    }
}

/** One step alone, as a card holds it before Save (Run step on a draft). */
export function parseOneStep(raw: unknown, index: number): { step: Step | null; errors: string[] } {
    const errors: string[] = []
    const step = parseStep(raw, errors, `steps[${index + 1}]`, index)
    return { step: errors.length ? null : step, errors }
}

/**
 * `steps:` as the pipeline. Without it the old fields are read as one: a
 * `prefilter:` (top-level or under a `poll:` trigger) is the first step, a
 * source; `agent:` / `skill:` are the agent step. A `steps:` list without an
 * agent step is scripts only, unless the file still names `agent:` on top.
 */
function parseSteps(
    fm: Record<string, unknown>,
    legacySources: unknown[],
    errors: string[],
    warnings: string[]
): { steps: Step[]; agentStep: AgentStep | null; after: RunStep[] } {
    const steps: Step[] = []
    legacySources.forEach((raw, i) => {
        const step = parseStep(raw, errors, 'prefilter', i)
        if (step) steps.push(step)
    })
    const listed = fm.steps !== undefined && fm.steps !== null
    if (listed) {
        if (!Array.isArray(fm.steps))
            errors.push('steps must be a list of `- run: <command>` / `- agent: <name>` entries')
        else
            fm.steps.forEach((raw, i) => {
                const step = parseStep(raw, errors, `steps[${i + 1}]`, steps.length)
                if (step) steps.push(step)
            })
    }
    const agents = steps.filter((s): s is AgentStep => s.kind === 'agent')
    if (agents.length > 1) errors.push('steps: at most one `agent:` step')
    // After the agent: scripts only, run once its task has ended; `if:` means nothing before it.
    const at = agents.length ? steps.indexOf(agents[0]) : steps.length
    const after: RunStep[] = []
    steps.forEach((step, i) => {
        const where = `steps[${i + 1}]`
        if (i < at) {
            if (step.kind === 'run' && step.if !== 'success')
                errors.push(`${where}: \`if:\` is for steps after the agent`)
            return
        }
        if (i === at) return
        if (step.kind !== 'run') errors.push(`${where}: after the agent only scripts (\`run:\`) can follow`)
        else if (step.items) errors.push(`${where}: a step after the agent cannot be a source (\`items:\`)`)
        else after.push(step)
    })
    let agentStep = agents[0] ?? null
    const topAgent = str(fm.agent)
    const topSkill = str(fm.skill)
    if (!agentStep && (topAgent || topSkill || !listed)) {
        // The old shape (or a `steps:` list that leaves the agent on top): the agent closes the pipeline.
        agentStep = {
            kind: 'agent',
            name: 'agent',
            agent: topAgent && topAgent !== 'orchestrator' ? topAgent : null,
            skill: topSkill ?? null
        }
        steps.push(agentStep)
    } else if (agentStep && (topAgent || topSkill))
        warnings.push('agent: and skill: on top are ignored: the `agent:` step has its own')
    return { steps, agentStep, after }
}

/** One trigger's cron, zone and window; `at` names it in errors. Null when the cron does not parse. */
function parseTrigger(
    cronRaw: unknown,
    o: { tz?: unknown; window?: unknown },
    defaults: { tz: string; window: Window },
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
    return cron ? { kind: 'schedule', cron, cron_text: describeCron(cron), tz, window } : null
}

/**
 * `triggers:` is a list of `- schedule: <cron>` entries, each with its own
 * `tz:` / `window:` on top of the file's. The old shapes still read: a
 * top-level `cron:` is one trigger, a `- poll: <cron>` is a schedule whose
 * `prefilter:` becomes the first step (returned as `legacySources`).
 */
function parseTriggers(
    fm: Record<string, unknown>,
    defaults: { tz: string; window: Window },
    errors: string[],
    warnings: string[]
): { triggers: Trigger[]; legacySources: unknown[] } {
    const legacySources: unknown[] = []
    // An empty `prefilter:` (`''`, `false`, nothing) is no source, wherever it stands.
    const given = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== false
    const topPrefilter = given(fm.prefilter)
    // As in 1.5.0, a top-level prefilter counts only without `triggers:` (there it was ignored, with a warning).
    if (topPrefilter && (fm.triggers === undefined || fm.triggers === null)) {
        warnings.push('prefilter: is read as the first step; move it under steps:')
        legacySources.push(fm.prefilter)
    }
    if (fm.triggers === undefined || fm.triggers === null) {
        if (fm.cron === undefined || fm.cron === null || fm.cron === '') return { triggers: [], legacySources }
        const trigger = parseTrigger(fm.cron, {}, defaults, errors, 'cron')
        return { triggers: trigger ? [trigger] : [], legacySources }
    }
    if (!Array.isArray(fm.triggers)) {
        errors.push('triggers must be a list of `- schedule: <cron>` entries')
        return { triggers: [], legacySources }
    }
    if (fm.cron !== undefined) warnings.push('cron: is ignored when triggers: is set; move it under a trigger')
    if (topPrefilter) warnings.push('prefilter: is ignored when triggers: is set; move it under steps:')
    const triggers: Trigger[] = []
    fm.triggers.forEach((raw, i) => {
        const at = `triggers[${i + 1}]`
        if (!raw || typeof raw !== 'object') {
            errors.push(`${at} must be a mapping with \`schedule:\` (a cron)`)
            return
        }
        const o = raw as Record<string, unknown>
        const isSchedule = o.schedule !== undefined
        const isPoll = o.poll !== undefined
        if (isSchedule === isPoll) {
            errors.push(`${at} must have \`schedule:\` (a cron)`)
            return
        }
        // A poll of 1.5.0: the same minute as a schedule; its prefilter is a source step now.
        if (isPoll) {
            if (given(o.prefilter)) legacySources.push(o.prefilter)
            warnings.push(`${at}: poll: is read as schedule:, its prefilter as a step; move it under steps:`)
        } else if (o.prefilter !== undefined)
            warnings.push(`${at}: a schedule has no prefilter; sources live under steps:`)
        const trigger = parseTrigger(isPoll ? o.poll : o.schedule, o, defaults, errors, at)
        if (trigger) triggers.push(trigger)
    })
    // In 1.5.0 a schedule next to a poll started the agent on every firing, gated by nothing;
    // one pipeline for all triggers would make the poll's source gate the schedule too.
    const polls = fm.triggers.filter((t) => t && typeof t === 'object' && (t as Record<string, unknown>).poll)
    if (polls.length && polls.length < fm.triggers.length && legacySources.length)
        errors.push(
            'a schedule: next to a poll: with a prefilter means two pipelines now: split the file into two routines (one with the source under steps:, one without)'
        )
    return { triggers, legacySources }
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
    const { triggers, legacySources } = parseTriggers(
        fm,
        { tz: isTimeZone(tz) ? tz : defaults.tz, window },
        errors,
        warnings
    )
    const { steps, agentStep, after } = parseSteps(fm, legacySources, errors, warnings)

    const project = str(fm.project) ?? null
    if (project && !refs.projectExists(project))
        errors.push(`project "${project}" has no file or its checkout is missing`)
    const handOff = handOffProjects(fm)
    for (const p of handOff)
        if (!refs.projectExists(p)) errors.push(`hand_off: project "${p}" has no file or its checkout is missing`)
    const hosts = hostList(fm.hosts)
    for (const h of hosts) if (!refs.hostExists(h.host)) warnings.push(`host "${h.host}" is not in hosts.yaml`)
    const skill = agentStep?.skill ?? null
    if (skill && !refs.skillExists(skill)) warnings.push(`skill "${skill}" is not installed`)
    const agent = agentStep?.agent ?? null
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

    if (steps.some((s) => s.kind === 'github-prs' && !s.repos.length) && !project)
        errors.push('a github-prs step needs a `repo` or a `project` with a repository')

    const notify = str(fm.notify) ?? 'telegram'
    if (notify !== 'telegram' && notify !== 'none') errors.push('notify must be telegram or none')
    const session = str(fm.session) ?? 'fresh'
    if (session !== 'fresh' && session !== 'continue') errors.push('session must be fresh or continue')
    const sources = steps.filter(isSource)
    const firstRun = str(fm.first_run) ?? (sources.some((s) => s.kind !== 'run') ? 'skip' : 'process')
    if (firstRun !== 'skip' && firstRun !== 'process') errors.push('first_run must be skip or process')
    if (agentStep && !entry.body.trim())
        warnings.push('the instructions are empty: the agent only gets what the steps found')
    if (!steps.length) errors.push('nothing to run: no steps and no agent')

    if (errors.length) return { name: entry.name, entry, spec: null, errors, warnings }
    return {
        name: entry.name,
        entry,
        errors,
        warnings,
        spec: {
            name: entry.name,
            triggers,
            steps,
            agentStep,
            after,
            agent,
            skill,
            enabled: bool(fm.enabled, true),
            project,
            hosts,
            provider,
            model,
            notify: notify as RoutineSpec['notify'],
            session: session as RoutineSpec['session'],
            first_run: firstRun as RoutineSpec['first_run'],
            max_items: int(fm.max_items, 10, 1, 100),
            once: bool(fm.once, false),
            hand_off: handOff
        }
    }
}
