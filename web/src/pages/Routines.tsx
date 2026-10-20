import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { Editor, Field, str } from '../components/Editor'
import { FolderFiles } from '../components/Files'
import { ProjectHosts } from '../components/Hosts'
import { Icon } from '../components/Icon'
import { useConfirm } from '../components/Modal'
import { kindOf, type RawStep, StepsField } from '../components/Pipeline'
import { ModelPicker } from '../components/Providers'
import { Button, Empty, ErrorBox, SectionHead, Stat, StatusBadge, useToast } from '../components/ui'
import {
    api,
    type CatalogEntry,
    type CronCheck,
    fmt,
    type ProjectHost,
    type RoutinePreview,
    type RoutineRun,
    type RoutineTrigger,
    type RoutineView
} from '../lib/api'
import { runProgress } from '../lib/routines'
import { useAsync } from '../lib/useAsync'

const TEMPLATE = `What to do on every run, in plain words: what counts, what to skip, when to ask.

## Notes

Decisions the agent keeps between runs (it edits this section itself): tickets deferred and why, PRs skipped on purpose, anything the next run should know. Lines about items that are gone (merged, closed) are removed on the next run.
`

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Mon–Fri", "Mon, Wed, Fri", "Sat–Sun": consecutive days as a range. */
function dayList(days: number[]): string {
    const sorted = [...new Set(days)].sort((a, b) => a - b)
    const groups: number[][] = []
    for (const d of sorted) {
        const last = groups[groups.length - 1]
        if (last && d === last[last.length - 1] + 1) last.push(d)
        else groups.push([d])
    }
    return groups
        .map((g) =>
            g.length > 2 ? `${DAY_NAMES[g[0]]}–${DAY_NAMES[g[g.length - 1]]}` : g.map((d) => DAY_NAMES[d]).join(', ')
        )
        .join(', ')
}

/** Show runs lists this many, newest first; older firings are not shown anywhere. */
const RUNS_SHOWN = 20
const runTone = (status: RoutineRun['status']) =>
    status === 'running'
        ? 'running'
        : status === 'queued' || status === 'done'
          ? 'done'
          : status === 'error'
            ? 'failed'
            : status === 'skipped'
              ? 'queued'
              : status === 'missed'
                ? 'amber'
                : 'cancelled'

/** A run's outcome: the task's status when it queued one (that is what the owner wants to know), else what the scheduler decided. */
function RunBadge({ run }: { run: RoutineRun }) {
    if (run.task_id && run.task_status) return <StatusBadge status={run.task_status} />
    return <span className={`badge ${runTone(run.status)}`}>{run.status}</span>
}

/** A trigger as the file has it: `{ schedule: cron }` (`{ poll: cron }` from 1.5.0 reads the same), plus `tz` / `window` the form keeps. */
type RawTrigger = Record<string, unknown>
const cronOf = (t: RawTrigger) => str(t.poll ?? t.schedule)

/** The triggers of a form's frontmatter: `triggers:` as it is, or the old `cron:` read as one. */
function triggersOf(fm: Record<string, unknown>): RawTrigger[] {
    if (Array.isArray(fm.triggers))
        return fm.triggers.filter((t): t is RawTrigger => Boolean(t) && typeof t === 'object')
    const cron = str(fm.cron).trim()
    return cron ? [{ schedule: cron }] : []
}

/** The 1.5.0 `prefilter:` shape as a step, read as the server reads it (`parseStep` in routines/spec.ts). */
function stepOfPrefilter(p: unknown): RawStep | null {
    if (!p || typeof p !== 'object') return typeof p === 'string' && p.trim() ? { run: p } : null
    const { kind, ...rest } = p as RawStep
    if (kind === undefined) return rest
    if (kind === 'command') return { ...rest, run: rest.run ?? '', items: true }
    if (kind === 'github-prs' || kind === 'trac') {
        const { name, ...options } = rest
        return name === undefined ? { [kind]: options } : { name, [kind]: options }
    }
    return null
}

/**
 * The pipeline of a form's frontmatter: `steps:` as it is, or the 1.5.0
 * fields read as one (`prefilter:` on top or under a trigger as the first
 * step, `agent:` / `skill:` as the agent step). A file without `steps:`
 * always has the agent step: that was the only way to run.
 */
export function stepsOf(fm: Record<string, unknown>): RawStep[] {
    const steps: RawStep[] = []
    // As on the server: a top-level prefilter counts only without `triggers:`, and under a trigger only a `poll:` has one.
    const prefilters = Array.isArray(fm.triggers)
        ? triggersOf(fm)
              .filter((t) => t.poll !== undefined)
              .map((t) => t.prefilter)
        : [fm.prefilter]
    for (const p of prefilters) {
        const step = stepOfPrefilter(p)
        if (step) steps.push(step)
    }
    const listed = Array.isArray(fm.steps)
    if (listed)
        for (const s of fm.steps as unknown[]) {
            if (typeof s === 'string') steps.push({ run: s })
            else if (s && typeof s === 'object') steps.push(s as RawStep)
        }
    const hasAgent = steps.some((s) => kindOf(s) === 'agent')
    if (!hasAgent && (!listed || str(fm.agent) || str(fm.skill)))
        steps.push({ agent: str(fm.agent) || 'orchestrator', skill: str(fm.skill) || undefined })
    return steps
}

export function RoutinesPage() {
    const status = useAsync(() => api.routines(), [], 15_000)
    const projects = useAsync(() => api.list('projects'), [])
    const skills = useAsync(() => api.list('skills'), [])
    const agents = useAsync(() => api.list('agents'), [])
    const providers = useAsync(() => api.providers(), [])
    const hosts = useAsync(() => api.hosts(), [])
    const keys = useAsync(() => api.sshKeys(), [])
    const viewOf = (name: string) => status.data?.find((s) => s.name === name)
    const cron = useCronCheck()
    // The file open in a routine's Files section.
    const [openFile, setOpenFile] = useState<{ routine: string; path: string } | null>(null)
    // Bumped when a step card writes a script, so the Files list reads the folder again.
    const [filesVersion, setFilesVersion] = useState(0)
    const refresh = () => {
        status.reload()
        setFilesVersion((v) => v + 1)
    }

    return (
        <Editor
            kind='routines'
            title='Routines'
            sub='Work that runs by itself: a pipeline of steps (scripts, sources, the agent last) and the schedules that start it. The agent edits the instructions to remember its decisions. Files in data/config/routines/.'
            defaults={{
                triggers: [{ schedule: '0 8 * * mon-fri' }],
                steps: [{ agent: 'orchestrator' }],
                enabled: false,
                notify: 'telegram',
                session: 'fresh'
            }}
            validate={(fm) => {
                for (const [i, t] of triggersOf(fm).entries()) {
                    const expr = cronOf(t).trim()
                    if (!expr) return `schedule ${i + 1}: a cron is required`
                    const check = cron.result(expr)
                    if (check && !check.ok && !check.offline) return `schedule ${i + 1}: ${check.error}`
                }
                const steps = stepsOf(fm)
                if (!steps.length) return 'the pipeline is empty: add a step or the agent'
                for (const [i, s] of steps.entries()) {
                    const kind = kindOf(s)
                    if (kind === 'run' && !str(s.run).trim()) return `step ${i + 1}: a command is required`
                    // As on the server: the query is `query:` or the part of `url:` after `?`.
                    const trac = s.trac as RawStep | undefined
                    if (kind === 'trac' && !str(trac?.query).trim() && !/\?./s.test(str(trac?.url)))
                        return `step ${i + 1}: a Trac query is required`
                    if (kind === 'agent' && i !== steps.length - 1) return 'the agent must be the last step'
                }
                return null
            }}
            template={TEMPLATE}
            bodyLabel='Instructions'
            bodyHint='Markdown: what to do on every run; the agent keeps its notes here too'
            describe={(e) => {
                const v = viewOf(e.name)
                const when = v
                    ? v.triggers.map((t) => t.cron_text).join(', ') || 'by hand'
                    : triggersOf(e.frontmatter).map(cronOf).join(', ')
                const who = v ? (v.has_agent ? (v.agent ?? 'orchestrator') : 'scripts only') : str(e.frontmatter.agent)
                const parts = [who || null, when, str(e.frontmatter.project) || null]
                // The state is a dot (green on, grey off, red invalid); the word is its tooltip.
                const state = v
                    ? v.errors.length
                        ? { cls: 'off', label: `invalid: ${v.errors.join('; ')}` }
                        : v.enabled
                          ? { cls: '', label: 'on' }
                          : { cls: 'idle', label: 'off' }
                    : null
                return (
                    <>
                        {state && (
                            <span
                                className={`live state ${state.cls}`}
                                role='img'
                                aria-label={state.label}
                                title={state.label}
                            />
                        )}
                        {parts.filter(Boolean).join(' · ')}
                    </>
                )
            }}
            intro='A routine is a pipeline that runs by itself: scripts (fetch statistics, make a backup), sources (open pull requests, Trac tickets, a command that lists items) and, as the last step, the agent that reads what they found and your instructions. When every source comes back empty the agent is not started, so an idle routine costs no tokens; a routine without an agent just runs its scripts and reports their output. Pick one from the list, or create a new one.'
            newLabel='New routine'
            overview={status.data && status.data.length > 0 && <PipelinesOverview routines={status.data} />}
            aside={(entry) => (
                <Status
                    entry={entry}
                    view={viewOf(entry.name)}
                    onChanged={status.reload}
                />
            )}
            form={(fm, set, entry) => {
                // The agent step runs as the agent picked: a named agent brings its own model and provider,
                // so the routine pins one only for the orchestrator, or when the file already does.
                const agentStep = stepsOf(fm).find((s) => kindOf(s) === 'agent')
                const named = Boolean(agentStep && str(agentStep.agent) && str(agentStep.agent) !== 'orchestrator')
                const model =
                    agentStep && (!named || str(fm.model) || str(fm.provider)) ? (
                        <Field
                            hint={
                                str(fm.provider)
                                    ? 'Runs go to this provider, off the subscription; light mode runs the agent alone.'
                                    : named
                                      ? "Overrides the agent file's model; inherit follows the file."
                                      : "The orchestrator's model here; inherit = the factory's current one."
                            }
                            group
                            wide
                        >
                            <ModelPicker
                                provider={str(fm.provider)}
                                model={str(fm.model)}
                                providers={providers.data?.providers}
                                onChange={(p, m) => set({ provider: p || undefined, model: m || undefined })}
                            />
                        </Field>
                    ) : null
                return (
                    <StepsField
                        model={model}
                        steps={stepsOf(fm)}
                        view={entry ? viewOf(entry.name) : undefined}
                        saved={entry ? stepsOf(entry.frontmatter) : []}
                        onChanged={refresh}
                        // The form writes the new shape; the 1.5.0 fields (prefilter, agent, skill on top) go with the first save.
                        onChange={(next) =>
                            set({
                                steps: next,
                                prefilter: undefined,
                                agent: undefined,
                                skill: undefined,
                                triggers: triggersOf(fm).map(({ prefilter: _p, poll, ...t }) =>
                                    poll !== undefined ? { ...t, schedule: poll } : t
                                ),
                                cron: undefined
                            })
                        }
                        agents={(agents.data ?? []).map((a) => a.name)}
                        skills={(skills.data ?? []).map((s) => s.name)}
                        routine={entry?.name ?? null}
                    />
                )
            }}
            below={(fm, set, entry) => {
                const triggers = triggersOf(fm)
                const steps = stepsOf(fm)
                const newOnly = steps.some(
                    (s) =>
                        ((kindOf(s) === 'github-prs' || kindOf(s) === 'trac') &&
                            (s[kindOf(s)] as RawStep).new_only !== false) ||
                        (kindOf(s) === 'run' && s.items === true && s.new_only !== false)
                )
                // Bare names from the first form of the file become references, so the cards can edit them.
                const hostList = (Array.isArray(fm.hosts) ? fm.hosts : []).flatMap((h): ProjectHost[] =>
                    typeof h === 'string' && h.trim()
                        ? [{ host: h.trim() }]
                        : h && typeof h === 'object'
                          ? [h as ProjectHost]
                          : []
                )
                return (
                    <>
                        <div className='field wide triggers'>
                            <SectionHead
                                title='Schedule'
                                hint='Empty = only by Run now (or /run in Telegram).'
                            />
                            <CronField
                                value={triggers[0] ? cronOf(triggers[0]) : ''}
                                onChange={(expr) => {
                                    const { poll: _p, prefilter: _f, ...first } = triggers[0] ?? {}
                                    const rest = triggers
                                        .slice(1)
                                        .map(({ prefilter: _q, poll, ...t }) =>
                                            poll !== undefined ? { ...t, schedule: poll } : t
                                        )
                                    // The 1.5.0 prefilter becomes a step here too, or this edit alone would drop it.
                                    set({
                                        steps,
                                        prefilter: undefined,
                                        agent: undefined,
                                        skill: undefined,
                                        // Clearing the first schedule leaves the others the file has, not an empty one.
                                        triggers: expr.trim() ? [{ ...first, schedule: expr }, ...rest] : rest,
                                        cron: undefined
                                    })
                                }}
                                check={cron}
                            />
                            {triggers.length > 1 && (
                                <div className='dim small'>
                                    {`+ ${triggers.length - 1} more in the file: `}
                                    <span className='mono'>{triggers.slice(1).map(cronOf).join(', ')}</span>
                                </div>
                            )}
                            <label
                                className='row'
                                style={{ gap: 8 }}
                                title='Switch the routine off after its next run'
                            >
                                <input
                                    type='checkbox'
                                    checked={fm.once === true}
                                    onChange={(e) => set({ once: e.target.checked ? true : undefined })}
                                />
                                <span>Run once</span>
                            </label>
                        </div>
                        {newOnly && (
                            <>
                                <Field
                                    label='First run'
                                    hint={
                                        <span title='Run now never skips: it hands over what is new at once.'>
                                            Run now never skips
                                        </span>
                                    }
                                >
                                    <select
                                        value={
                                            str(fm.first_run) ||
                                            (steps.every((s) => kindOf(s) === 'run' || kindOf(s) === 'agent')
                                                ? 'process'
                                                : 'skip')
                                        }
                                        onChange={(e) => set({ first_run: e.target.value })}
                                    >
                                        <option value='skip'>mark existing items as seen</option>
                                        <option value='process'>hand existing items to the agent</option>
                                    </select>
                                </Field>
                                <Field
                                    label='Max items per run'
                                    hint='The rest wait for the next run.'
                                >
                                    <input
                                        type='number'
                                        min={1}
                                        max={100}
                                        value={str(fm.max_items) || '10'}
                                        onChange={(e) => set({ max_items: Number(e.target.value) || undefined })}
                                    />
                                </Field>
                            </>
                        )}
                        <div className='field wide group section'>
                            <SectionHead title='Project and delivery' />
                            <div className='form-grid'>
                                <Field
                                    label='Project'
                                    hint='Its checkout; empty = workspaces root'
                                >
                                    <select
                                        value={str(fm.project)}
                                        onChange={(e) => set({ project: e.target.value })}
                                    >
                                        <option value=''>— none —</option>
                                        {(projects.data ?? []).map((p) => (
                                            <option
                                                key={p.name}
                                                value={p.name}
                                            >
                                                {p.name}
                                            </option>
                                        ))}
                                    </select>
                                </Field>
                                <Field
                                    label='Report to'
                                    hint='The web thread has them either way.'
                                >
                                    <select
                                        value={str(fm.notify) || 'telegram'}
                                        onChange={(e) => set({ notify: e.target.value })}
                                    >
                                        <option value='telegram'>Telegram (the owner's chat)</option>
                                        <option value='none'>web only</option>
                                    </select>
                                </Field>
                                {str(fm.session) === 'continue' && (
                                    <Field
                                        label='Session'
                                        hint={
                                            <span title='The memory between runs is this file, so a fresh session is the default.'>
                                                fresh is the default
                                            </span>
                                        }
                                    >
                                        <select
                                            value={str(fm.session) || 'fresh'}
                                            onChange={(e) => set({ session: e.target.value })}
                                        >
                                            <option value='fresh'>fresh session per run</option>
                                            <option value='continue'>continue one session</option>
                                        </select>
                                    </Field>
                                )}
                                {!entry && (
                                    <Field
                                        label='After saving'
                                        group
                                    >
                                        <div className='row wrap'>
                                            <label
                                                className='row'
                                                style={{ gap: 8 }}
                                            >
                                                <input
                                                    type='checkbox'
                                                    checked={fm.enabled === true}
                                                    onChange={(e) => set({ enabled: e.target.checked })}
                                                />{' '}
                                                <span>Switch it on</span>
                                            </label>
                                        </div>
                                    </Field>
                                )}
                                {hostList.length > 0 && (
                                    <ProjectHosts
                                        owner='routine'
                                        value={hostList}
                                        onChange={(next) => set({ hosts: next.length ? next : undefined })}
                                        shared={hosts.data}
                                        onSharedChanged={hosts.reload}
                                        keys={keys.data}
                                    />
                                )}
                            </div>
                        </div>
                        {entry && (
                            <div
                                id='routine-files'
                                className='field wide'
                            >
                                <FolderFiles
                                    key={`${entry.name}:${filesVersion}`}
                                    kind='routines'
                                    name={entry.name}
                                    dir={viewOf(entry.name)?.dir ?? entry.path.replace(/\/ROUTINE\.md$|\.md$/, '')}
                                    open={openFile?.routine === entry.name ? openFile.path : null}
                                    onOpen={(path) => setOpenFile(path ? { routine: entry.name, path } : null)}
                                    onChanged={status.reload}
                                    hint={
                                        <span title={viewOf(entry.name)?.dir}>
                                            The routine's folder (ROUTINE_DIR): its scripts in scripts/, its data in
                                            data/
                                        </span>
                                    }
                                />
                            </div>
                        )}
                    </>
                )
            }}
        />
    )
}

/**
 * The cron expression read back by the server as it is typed: valid or not,
 * in words, and when it fires next in the factory's zone. One request per
 * distinct expression, debounced; the last result is kept per expression so
 * the form's validation can consult it synchronously.
 */
function useCronCheck() {
    const [results, setResults] = useState<Record<string, CronCheck & { offline?: boolean }>>({})
    const [pending, setPending] = useState('')
    useEffect(() => {
        const expr = pending.trim()
        if (!expr || results[expr]) return
        const timer = setTimeout(() => {
            api.checkCron(expr)
                .then((r) => setResults((prev) => ({ ...prev, [expr]: r })))
                // The check could not be made (offline, signed out): said in the hint, never a reason to
                // refuse the save (the server reads the cron again).
                .catch((e: Error) =>
                    setResults((prev) => ({ ...prev, [expr]: { ok: false, error: e.message, tz: '', offline: true } }))
                )
        }, 300)
        return () => clearTimeout(timer)
    }, [pending, results])
    return {
        ask: (expr: string) => setPending(expr),
        result: (expr: string): (CronCheck & { offline?: boolean }) | undefined => results[expr.trim()]
    }
}

function CronField({
    value,
    onChange,
    check
}: {
    value: string
    onChange: (v: string) => void
    check: ReturnType<typeof useCronCheck>
}) {
    useEffect(() => check.ask(value), [value, check])
    const result = check.result(value)
    const hint = !value.trim() ? (
        'e.g. 0 8 * * mon-fri = weekdays at 08:00 · */15 * * * * = every 15 min'
    ) : !result ? (
        'checking…'
    ) : result.ok ? (
        <>
            <strong style={{ color: 'var(--text-2)' }}>{result.text}</strong> · {result.tz}
            {result.next
                ? ` · next ${fmt.when(result.next)} (in ${fmt.until(result.next)})`
                : ' · never fires within a year'}
        </>
    ) : (
        <span className='error'>{result.error}</span>
    )
    return (
        <Field
            label='Cron (minute hour day month weekday)'
            hint={hint}
            wide
        >
            <input
                className='mono'
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder='0 8 * * mon-fri'
                aria-invalid={value.trim() && result ? !result.ok : undefined}
            />
        </Field>
    )
}

/** One schedule as the scheduler reads it: the cron in words, zone and window. */
function TriggerLine({ trigger }: { trigger: RoutineTrigger }) {
    return (
        <span
            className='stack'
            style={{ gap: 2 }}
        >
            <span>{trigger.cron_text}</span>
            <span className='dim small'>
                {trigger.tz}
                {trigger.window.days ? ` · ${dayList(trigger.window.days)}` : ''}
                {trigger.window.hours ? ` · ${trigger.window.hours}` : ''}
            </span>
        </span>
    )
}

/**
 * What the file cannot say: whether the routine is valid, when it fires
 * next, what the last firing did, what the steps find right now, and the
 * buttons that act on the routine rather than on its text.
 */
function Status({
    entry,
    view,
    onChanged
}: {
    entry: CatalogEntry
    view: RoutineView | undefined
    onChanged: () => void
}) {
    const [busy, setBusy] = useState<'run' | 'preview' | 'forget' | 'toggle' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [preview, setPreview] = useState<RoutinePreview | null>(null)
    const [showRuns, setShowRuns] = useState(false)
    // A Run now that found nothing new offers what the sources see, seen or not ("Run with all").
    const [offerAll, setOfferAll] = useState(0)
    // By default only the firings that mattered; every empty run and skip on request.
    const [allRuns, setAllRuns] = useState(false)
    const runs = useAsync(
        () => (showRuns ? api.routineRuns(entry.name, RUNS_SHOWN, allRuns) : Promise.resolve([] as RoutineRun[])),
        [entry.name, showRuns, allRuns, view?.last_run?.id, view?.last_task?.task_status]
    )
    const [toast, showToast] = useToast()
    const confirm = useConfirm()
    // While a run's steps go (this Run now, or a timed firing): their progress every second and a half;
    // then, while its agent's task waits or works, every three seconds.
    const task = view?.last_run?.task_id ? view.last_run.task_status : null
    const pollMs =
        busy === 'run' || view?.last_run?.status === 'running'
            ? 1500
            : task === 'queued' || task === 'running'
              ? 3000
              : 0
    useEffect(() => {
        if (!pollMs) return
        const timer = setInterval(onChanged, pollMs)
        return () => clearInterval(timer)
    }, [pollMs, onChanged])
    if (!view) return null

    const act = async (what: 'run' | 'preview' | 'forget' | 'toggle', work: () => Promise<string | null>) => {
        setBusy(what)
        setError(null)
        try {
            const note = await work()
            if (note) showToast(note)
            onChanged()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(null)
        }
    }
    const run = (all = false) =>
        act('run', async () => {
            const r = await api.runRoutine(entry.name, all)
            setOfferAll(r.status === 'empty' && !all ? (r.found ?? 0) : 0)
            return `${r.status}${r.note ? ` — ${r.note.slice(0, 200)}` : ''}`
        })
    const doPreview = () =>
        act('preview', async () => {
            setPreview(await api.previewRoutine(entry.name))
            return null
        })
    const toggle = () =>
        act('toggle', async () => {
            await api.enableRoutine(entry.name, !view.enabled)
            return view.enabled ? 'Switched off' : 'Switched on'
        })
    const forget = () =>
        void confirm({
            title: `Forget what “${entry.name}” has seen?`,
            message: (
                <>
                    {view.seen} item(s) are marked as handed over. Forgetting them makes the next run treat everything
                    the sources find as new — up to the routine's max items per run.
                </>
            ),
            action: 'Forget',
            pending: 'Forgetting…',
            danger: true,
            icon: 'warning',
            onConfirm: async () => {
                const r = await api.forgetRoutineSeen(entry.name)
                showToast(`Forgot ${r.forgotten} item(s)`)
                onChanged()
            }
        })

    const last = view.last_run
    const progress = runProgress(last, view.steps.filter((s) => s.kind !== 'agent').length)
    const lastTask = view.last_task
    const model = view.provider ? `${view.provider}${view.model ? `:${view.model}` : ''}` : view.model
    const hasSources = view.steps.some((s) => s.source)
    const previewable = view.steps.some((s) => s.kind !== 'agent')
    // The last firing that queued a task is often the last firing itself: then one badge, not the same run twice.
    const taskLine = lastTask && lastTask.id !== last?.id
    return (
        <div className='card pad0 routine-status'>
            <div className='stat-row'>
                <Stat
                    label='Runs'
                    value={
                        <span className='stack routine-triggers'>
                            {view.triggers.length ? (
                                view.triggers.map((t, i) => (
                                    <TriggerLine
                                        key={i}
                                        trigger={t}
                                    />
                                ))
                            ) : (
                                <span>by hand only</span>
                            )}
                        </span>
                    }
                    sub={[
                        view.steps.map((s) => s.name).join(' → '),
                        view.has_agent ? (view.agent ? `as ${view.agent}` : 'the orchestrator') : 'no agent',
                        model,
                        view.once ? 'once' : null,
                        hasSources ? `${view.seen} item(s) seen` : null
                    ]
                        .filter(Boolean)
                        .join(' · ')}
                />
                <Stat
                    label='Next run'
                    value={
                        view.next_run
                            ? `in ${fmt.until(view.next_run)}`
                            : !view.triggers.length
                              ? 'when you press Run now'
                              : view.enabled
                                ? 'never (no matching minute within a year)'
                                : 'off'
                    }
                    sub={view.next_run ? fmt.when(view.next_run) : undefined}
                />
                <Stat
                    label='Last firing'
                    value={
                        last ? (
                            <>
                                <RunBadge run={last} /> {fmt.ago(last.fired_at)}
                            </>
                        ) : (
                            'never'
                        )
                    }
                    sub={
                        progress || last?.note || taskLine || lastTask?.task_id || view.conversation_id ? (
                            <span className='stack routine-stat-sub'>
                                {progress && <span className='routine-note running'>{progress}</span>}
                                {last?.note && (
                                    <span className={`routine-note ${last.status}`}>
                                        {last.note.length > 300 ? `${last.note.slice(0, 300)}…` : last.note}
                                    </span>
                                )}
                                {taskLine && (
                                    <span>
                                        last task <RunBadge run={lastTask} /> {fmt.ago(lastTask.fired_at)}
                                    </span>
                                )}
                                {(lastTask?.task_id || view.conversation_id) && (
                                    <span className='row routine-links'>
                                        {lastTask?.task_id && <Link to={`/tasks/${lastTask.task_id}`}>open task</Link>}
                                        {view.conversation_id && (
                                            <Link to={`/chat/${view.conversation_id}`}>open thread</Link>
                                        )}
                                    </span>
                                )}
                            </span>
                        ) : undefined
                    }
                />
            </div>
            {(view.errors.length > 0 || view.warnings.length > 0) && (
                <div className='stack routine-band'>
                    {view.errors.map((e) => (
                        <ErrorBox
                            key={e}
                            error={e}
                            inline
                        />
                    ))}
                    {view.warnings.map((w) => (
                        <div
                            key={w}
                            className='small warn-text'
                        >
                            {w}
                        </div>
                    ))}
                </div>
            )}
            <div className='row wrap routine-actions'>
                {view.errors.length ? (
                    <span className='badge failed'>invalid</span>
                ) : view.enabled ? (
                    <span className='badge done'>on</span>
                ) : (
                    <span className='badge cancelled'>off</span>
                )}
                <span className='state-gap' />
                <Button
                    size='sm'
                    variant='primary'
                    onClick={() => run()}
                    disabled={busy !== null || view.errors.length > 0 || view.active_task !== null}
                    title={
                        view.active_task
                            ? `a run is ${view.active_task.status}`
                            : 'Run now: skips the crons, the windows and the soft-stop; runs the steps and hands over what the sources find'
                    }
                >
                    {busy === 'run' ? 'Starting…' : 'Run now'}
                </Button>
                {offerAll > 0 && (
                    <Button
                        size='sm'
                        onClick={() => run(true)}
                        disabled={busy !== null || view.errors.length > 0 || view.active_task !== null}
                        title='Hand over what the sources see, seen before or not, up to max items per run'
                    >
                        {`Run with all ${offerAll}`}
                    </Button>
                )}
                {previewable && (
                    <Button
                        size='sm'
                        onClick={doPreview}
                        disabled={busy !== null || view.errors.length > 0}
                        title='Run every step but the agent and show what they print and find; marks nothing'
                    >
                        {busy === 'preview' ? 'Running…' : 'Preview steps'}
                    </Button>
                )}
                <Button
                    size='sm'
                    onClick={toggle}
                    disabled={busy !== null || view.errors.length > 0}
                >
                    {busy === 'toggle' ? '…' : view.enabled ? 'Switch off' : 'Switch on'}
                </Button>
                {hasSources && view.seen > 0 && (
                    <Button
                        size='sm'
                        variant='danger'
                        onClick={forget}
                        disabled={busy !== null}
                    >
                        Forget seen items
                    </Button>
                )}
                <span className='grow' />
                <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setShowRuns((v) => !v)}
                >
                    {showRuns ? 'Hide runs' : 'Show runs'}
                </Button>
                {view.active_task && (
                    <Link
                        className='badge running'
                        to={`/tasks/${view.active_task.id}`}
                    >
                        {view.active_task.status}
                    </Link>
                )}
            </div>
            <ErrorBox error={error} />
            {preview && (
                <div className='routine-preview'>
                    <div className='row between'>
                        <span className='small dim'>
                            Steps ran in {fmt.duration(preview.ms)}
                            {hasSources
                                ? `: ${preview.items.length} item(s), ${preview.new_keys.length} would be handed over`
                                : ''}
                        </span>
                        <Button
                            size='sm'
                            variant='ghost'
                            onClick={() => setPreview(null)}
                        >
                            Close
                        </Button>
                    </div>
                    {preview.outputs.map((o, i) => (
                        <div key={i}>
                            <div className='dim small'>
                                {o.name} · {fmt.duration(o.ms)}
                                {o.truncated ? ' · output cut' : ''}
                            </div>
                            <pre className='mono small'>{o.output.trim() || '(no output)'}</pre>
                        </div>
                    ))}
                    {preview.items.length > 0 && (
                        <div className='mcp-servers'>
                            {preview.items.map((item) => (
                                <div
                                    key={item.key}
                                    className='mcp-server row'
                                    style={{ gap: 10 }}
                                >
                                    <span
                                        className={`badge ${preview.new_keys.includes(item.key) ? (item.seen_before ? 'amber' : 'done') : 'cancelled'}`}
                                        title={
                                            item.seen_before
                                                ? `handed over ${fmt.when(item.seen_before)}, changed since`
                                                : undefined
                                        }
                                    >
                                        {preview.new_keys.includes(item.key)
                                            ? item.seen_before
                                                ? 'changed'
                                                : 'new'
                                            : 'seen'}
                                    </span>
                                    <span className='grow'>
                                        {item.url ? (
                                            <a
                                                href={item.url}
                                                target='_blank'
                                                rel='noreferrer'
                                            >
                                                {item.title}
                                            </a>
                                        ) : (
                                            item.title
                                        )}
                                        {item.text && <span className='dim small'> · {item.text}</span>}
                                    </span>
                                    <span className='mono dim small'>{item.key}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {showRuns && (
                <div className='card-scroll routine-runs'>
                    <label className='row small dim routine-band'>
                        <input
                            type='checkbox'
                            checked={allRuns}
                            onChange={(e) => setAllRuns(e.target.checked)}
                        />{' '}
                        <span>Every firing, including empty runs and skips</span>
                    </label>
                    {runs.data?.length ? (
                        <>
                            <table>
                                <thead>
                                    <tr>
                                        <th>When</th>
                                        <th>Trigger</th>
                                        <th>Outcome</th>
                                        <th>Note</th>
                                        <th>Items</th>
                                        <th>Steps</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {runs.data.map((r) => (
                                        <RunRow
                                            key={r.id}
                                            run={r}
                                        />
                                    ))}
                                </tbody>
                            </table>
                            {runs.data.length >= RUNS_SHOWN && (
                                <div className='routine-runs-foot'>
                                    <Empty inline>The last {RUNS_SHOWN} runs.</Empty>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className='routine-runs-foot'>
                            <Empty inline>
                                {runs.loading
                                    ? 'Loading…'
                                    : allRuns
                                      ? 'No firings yet.'
                                      : 'No task, error or missed firing yet.'}
                            </Empty>
                        </div>
                    )}
                </div>
            )}
            {toast}
        </div>
    )
}

/**
 * One firing in the runs table, with its steps one click away, the way a CI
 * job opens into its steps: each with ok or failed, its time, the head of
 * what it printed (secrets masked).
 */
function RunRow({ run: r }: { run: RoutineRun }) {
    const [open, setOpen] = useState(false)
    const steps = r.steps ?? []
    return (
        <>
            <tr
                className={steps.length ? 'run-row clickable' : 'run-row'}
                onClick={() => steps.length && setOpen((v) => !v)}
                aria-expanded={steps.length ? open : undefined}
            >
                <td
                    className='nowrap'
                    title={fmt.when(r.fired_at)}
                >
                    {steps.length > 0 && (
                        <span className='dim run-fold'>
                            <Icon
                                name={open ? 'collapse' : 'expand'}
                                size={12}
                            />
                        </span>
                    )}
                    {fmt.ago(r.fired_at)}
                </td>
                <td>{r.trigger === 'cron' || r.trigger === 'poll' ? 'schedule' : r.trigger}</td>
                <td>
                    <RunBadge run={r} />
                </td>
                <td className='col-main small run-note'>
                    {steps.length > 0 && (
                        <span className='run-steps'>
                            {steps.map((s) => (
                                <span
                                    key={s.index}
                                    className={`badge ${s.ok ? 'done' : 'failed'}`}
                                    title={`${s.name}: ${s.ok ? 'ok' : 'failed'} in ${fmt.duration(s.ms)}`}
                                >
                                    <Icon
                                        name={s.ok ? 'ok' : 'failed'}
                                        size={12}
                                    />
                                    {s.name}
                                </span>
                            ))}
                        </span>
                    )}
                    {(r.note ?? '').length > 400 ? `${r.note!.slice(0, 400)}…` : (r.note ?? '')}
                </td>
                <td>{r.items || ''}</td>
                <td className='dim nowrap'>{r.duration_ms ? fmt.duration(r.duration_ms) : ''}</td>
                <td>
                    {r.task_id && (
                        <Link
                            to={`/tasks/${r.task_id}`}
                            onClick={(e) => e.stopPropagation()}
                        >
                            task
                        </Link>
                    )}
                </td>
            </tr>
            {open && (
                <tr className='run-detail'>
                    <td colSpan={7}>
                        {steps.map((s) => (
                            <div
                                key={s.index}
                                className='run-step'
                            >
                                <div className='row small'>
                                    <span className={`badge ${s.ok ? 'done' : 'failed'}`}>
                                        {s.ok ? 'ok' : 'failed'}
                                    </span>
                                    <strong>
                                        {s.index + 1}. {s.name}
                                    </strong>
                                    <span className='dim'>
                                        {fmt.duration(s.ms)}
                                        {s.items !== undefined ? ` · ${s.items} item(s)` : ''}
                                    </span>
                                </div>
                                {s.log.trim() && <pre className='mono small'>{s.log.trim()}</pre>}
                            </div>
                        ))}
                    </td>
                </tr>
            )}
        </>
    )
}

const STEP_SHORT: Record<RoutineView['steps'][number]['kind'], string> = {
    run: 'script',
    'github-prs': 'GitHub PRs',
    trac: 'Trac',
    agent: 'agent'
}

/**
 * Every routine's pipeline at a glance: its steps in order, each coloured by
 * how it went in the last run, with what is missing (a variable a step reads
 * that no run gets) marked; when it runs next and how the last run ended.
 */
function PipelinesOverview({ routines }: { routines: RoutineView[] }) {
    return (
        <div className='pipelines'>
            <SectionHead
                title='All pipelines'
                hint={
                    <>
                        Each step coloured by its last run;{' '}
                        <Icon
                            name='alert'
                            size={12}
                        />{' '}
                        = a variable it reads is not set.
                    </>
                }
            />
            {routines.map((r) => {
                const last = r.last_run?.steps ?? []
                return (
                    <Link
                        key={r.name}
                        to={`/routines/${encodeURIComponent(r.name)}`}
                        className='pipeline-row'
                    >
                        <span className='pipeline-main'>
                            <span className='pipeline-name'>
                                <span
                                    className={`live state ${r.errors.length ? 'off' : r.enabled ? '' : 'idle'}`}
                                    aria-hidden
                                />
                                <strong>{r.name}</strong>
                                <span className='dim small'>
                                    {r.errors.length
                                        ? 'invalid'
                                        : r.next_run
                                          ? `next in ${fmt.until(r.next_run)}`
                                          : r.triggers.length
                                            ? r.enabled
                                                ? 'never'
                                                : 'off'
                                            : 'by hand'}
                                </span>
                            </span>
                            <span className='pipeline-flow'>
                                {r.steps.map((step, i) => {
                                    const result = last.find((s) => s.index === i)
                                    const missing = step.needs.some((n) => n.from === null && !n.optional)
                                    return (
                                        <span
                                            key={i}
                                            className='row'
                                            style={{ gap: 4 }}
                                        >
                                            {i > 0 && <span className='dim'>›</span>}
                                            <span
                                                className={`pipeline-step ${step.kind}${result ? (result.ok ? ' ok' : ' failed') : ''}`}
                                                title={[
                                                    `${STEP_SHORT[step.kind]}: ${step.name}`,
                                                    step.script?.description,
                                                    result
                                                        ? `last run: ${result.ok ? 'ok' : 'failed'} in ${fmt.duration(result.ms)}`
                                                        : null,
                                                    missing
                                                        ? `not set: ${step.needs
                                                              .filter((n) => n.from === null && !n.optional)
                                                              .map((n) => n.name)
                                                              .join(', ')}`
                                                        : null
                                                ]
                                                    .filter(Boolean)
                                                    .join('\n')}
                                            >
                                                {missing && (
                                                    <Icon
                                                        name='alert'
                                                        size={12}
                                                    />
                                                )}
                                                {step.kind === 'agent' ? (r.agent ?? 'orchestrator') : step.name}
                                            </span>
                                        </span>
                                    )
                                })}
                            </span>
                        </span>
                        <span className='pipeline-last small'>
                            {r.last_run ? (
                                <>
                                    <RunBadge run={r.last_run} />{' '}
                                    <span className='dim'>{fmt.ago(r.last_run.fired_at)}</span>
                                </>
                            ) : (
                                <span className='dim'>never ran</span>
                            )}
                        </span>
                    </Link>
                )
            })}
        </div>
    )
}
