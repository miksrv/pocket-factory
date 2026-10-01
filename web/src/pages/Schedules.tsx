import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { Editor, Field, str } from '../components/Editor'
import { ProjectHosts } from '../components/Hosts'
import { useConfirm } from '../components/Modal'
import { Button, ErrorBox, StatusBadge, useToast } from '../components/ui'
import { api, type CatalogEntry, type CronCheck, fmt, type ProjectHost, type SchedulePreview, type ScheduleRun, type ScheduleView } from '../lib/api'
import { useAsync } from '../lib/useAsync'

const TEMPLATE = `What to do on every run, in plain words: what counts, what to skip, when to ask.

## Notes

Decisions the agent keeps between runs (it edits this section itself): tickets deferred and why, PRs skipped on purpose, anything the next run should know. Lines about items that are gone (merged, closed) are removed on the next run.
`

const PREFILTERS = [
    { value: '', label: 'none — every firing starts a task' },
    { value: 'command', label: 'command — a shell command; its output lines are the items' },
    { value: 'github-prs', label: 'github-prs — open pull requests of a repository' },
    { value: 'trac', label: 'trac — tickets of a Trac query' }
]

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
    return groups.map((g) => (g.length > 2 ? `${DAY_NAMES[g[0]]}–${DAY_NAMES[g[g.length - 1]]}` : g.map((d) => DAY_NAMES[d]).join(', '))).join(', ')
}

/** Show runs lists this many, newest first; older firings are not shown anywhere. */
const RUNS_SHOWN = 20
const runTone = (status: ScheduleRun['status']) => (status === 'queued' ? 'done' : status === 'error' ? 'failed' : status === 'skipped' ? 'queued' : status === 'missed' ? 'amber' : 'cancelled')

/** A run's outcome: the task's status when it queued one (that is what the owner wants to know), else what the scheduler decided. */
function RunBadge({ run }: { run: ScheduleRun }) {
    if (run.task_id && run.task_status) return <StatusBadge status={run.task_status} />
    return <span className={`badge ${runTone(run.status)}`}>{run.status}</span>
}

export function SchedulesPage() {
    const status = useAsync(() => api.schedules(), [], 15_000)
    const projects = useAsync(() => api.list('projects'), [])
    const skills = useAsync(() => api.list('skills'), [])
    const agents = useAsync(() => api.list('agents'), [])
    const hosts = useAsync(() => api.hosts(), [])
    const keys = useAsync(() => api.sshKeys(), [])
    const viewOf = (name: string) => status.data?.find((s) => s.name === name)
    const cron = useCronCheck()

    return (
        <Editor
            kind="schedules"
            title="Schedules"
            sub="Recurring tasks: a cron, an optional prefilter that runs without the model, and instructions the agent reads every run and edits to remember its decisions. Files in data/config/schedules/."
            defaults={{ cron: '0 8 * * mon-fri', enabled: false, notify: 'telegram', session: 'fresh', action: 'report' }}
            validate={(fm) => {
                const expr = str(fm.cron).trim()
                if (!expr) return 'cron is required'
                const check = cron.result(expr)
                return check && !check.ok ? `cron: ${check.error}` : null
            }}
            template={TEMPLATE}
            bodyLabel="Instructions for every run (Markdown) — the agent's memory between runs lives here too"
            describe={(e) => {
                const v = viewOf(e.name)
                const parts = [v?.cron_text ?? str(e.frontmatter.cron), str(e.frontmatter.project) || null, v?.prefilter ? `prefilter ${v.prefilter}` : null]
                // The state is a dot (green on, grey off, red invalid); the word is its tooltip.
                const state = v ? (v.errors.length ? { cls: 'off', label: `invalid: ${v.errors.join('; ')}` } : v.enabled ? { cls: '', label: 'on' } : { cls: 'idle', label: 'off' }) : null
                return (
                    <>
                        {state && <span className={`live state ${state.cls}`} role="img" aria-label={state.label} title={state.label} />}
                        {parts.filter(Boolean).join(' · ')}
                    </>
                )
            }}
            intro="A schedule fires a task on a cron: check a tracker for new defects, review new pull requests, look at the inbox, check a host. A prefilter (a shell command, a GitHub or Trac query) runs first without spending tokens; the agent starts only when it finds something new. Pick one from the list, or create a new one."
            newLabel="New schedule"
            aside={(entry) => <Status entry={entry} view={viewOf(entry.name)} onChanged={status.reload} />}
            form={(fm, set, entry) => {
                const prefilter = (fm.prefilter as Record<string, unknown> | undefined) ?? {}
                const kind = str(prefilter.kind)
                const setPrefilter = (patch: Record<string, unknown>) => set({ prefilter: { ...prefilter, ...patch } })
                // Bare names from the first form of the file become references, so the cards can edit them.
                const hostList = (Array.isArray(fm.hosts) ? fm.hosts : []).flatMap((h): ProjectHost[] => (typeof h === 'string' && h.trim() ? [{ host: h.trim() }] : h && typeof h === 'object' ? [h as ProjectHost] : []))
                return (
                    <>
                        <CronField value={str(fm.cron)} onChange={(v) => set({ cron: v })} check={cron} />
                        <Field label="Project" hint="The run works in its checkout with its rules; empty = the workspaces root.">
                            <select value={str(fm.project)} onChange={(e) => set({ project: e.target.value })}>
                                <option value="">— none —</option>
                                {(projects.data ?? []).map((p) => (
                                    <option key={p.name} value={p.name}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Skill" hint="The procedure to follow; empty = the instructions below.">
                            <select value={str(fm.skill)} onChange={(e) => set({ skill: e.target.value })}>
                                <option value="">— none —</option>
                                {(skills.data ?? []).map((s) => (
                                    <option key={s.name} value={s.name}>
                                        {s.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Agent" hint="Sub-agent the work is handed to; empty = the orchestrator decides.">
                            <select value={str(fm.agent)} onChange={(e) => set({ agent: e.target.value })}>
                                <option value="">— orchestrator decides —</option>
                                {(agents.data ?? []).map((a) => (
                                    <option key={a.name} value={a.name}>
                                        {a.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Model" hint="The orchestrator's model for these runs; inherit = whatever the factory runs on now (Settings, /model).">
                            <select value={str(fm.model)} onChange={(e) => set({ model: e.target.value || undefined })}>
                                <option value="">inherit — the factory's current model</option>
                                <option value="haiku">haiku — cheapest, mechanical checks</option>
                                <option value="sonnet">sonnet — current Sonnet</option>
                                <option value="opus">opus — current Opus</option>
                                <option value="fable">fable — current Fable (Max plans)</option>
                            </select>
                        </Field>
                        <Field label="Mode" hint="report = look and tell, change nothing; fix / comment = act as the instructions allow.">
                            <input list="modes" value={str(fm.action)} onChange={(e) => set({ action: e.target.value })} placeholder="report" />
                            <datalist id="modes">
                                <option value="report" />
                                <option value="fix" />
                                <option value="comment" />
                            </datalist>
                        </Field>
                        <Field label="Report to" hint="Where the report and questions go; the web thread has them either way.">
                            <select value={str(fm.notify) || 'telegram'} onChange={(e) => set({ notify: e.target.value })}>
                                <option value="telegram">Telegram (the owner's chat)</option>
                                <option value="none">web only</option>
                            </select>
                        </Field>
                        <Field label="Session" hint="fresh: memory is this file; continue: one growing transcript.">
                            <select value={str(fm.session) || 'fresh'} onChange={(e) => set({ session: e.target.value })}>
                                <option value="fresh">fresh session per run</option>
                                <option value="continue">continue one session</option>
                            </select>
                        </Field>
                        <Field label="Run once" hint="Switches itself off after queueing one task: a check to do tomorrow, not every day." group>
                            <div className="row wrap">
                                <label className="row" style={{ gap: 8 }}>
                                    <input type="checkbox" checked={fm.once === true} onChange={(e) => set({ once: e.target.checked ? true : undefined })} /> <span>switch off after the next run</span>
                                </label>
                            </div>
                        </Field>
                        {!entry && (
                            <Field label="After saving" hint="A new schedule is saved switched off unless ticked; the status bar above the form switches it later." group>
                                <div className="row wrap">
                                    <label className="row" style={{ gap: 8 }}>
                                        <input type="checkbox" checked={fm.enabled === true} onChange={(e) => set({ enabled: e.target.checked })} /> <span>switch it on</span>
                                    </label>
                                </div>
                            </Field>
                        )}
                        <ProjectHosts owner="schedule" value={hostList} onChange={(next) => set({ hosts: next.length ? next : undefined })} shared={hosts.data} onSharedChanged={hosts.reload} keys={keys.data} />
                        <Field label="Prefilter" hint="Runs before the model, every firing, without tokens. Only what it finds and no earlier run has handed over becomes a task; nothing found = no task." wide>
                            <select value={kind} onChange={(e) => set({ prefilter: e.target.value ? { kind: e.target.value } : undefined })}>
                                {PREFILTERS.map((p) => (
                                    <option key={p.value} value={p.value}>
                                        {p.label}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        {kind === 'command' && (
                            <>
                                <Field label="Command (bash)" hint="Runs in the project's checkout (or the workspaces root) with the agent's environment: ssh keys, gh, the .env variables. One item per output line (key<TAB>title), or a JSON array of {key, title, text, url}. Empty output and exit 0 = nothing to do." wide>
                                    <textarea className="mono" rows={5} value={str(prefilter.run)} onChange={(e) => setPrefilter({ run: e.target.value })} placeholder={'for h in host-a host-b; do\n  p=$(ssh -o BatchMode=yes $h "df --output=pcent / | tail -1" | tr -dc 0-9)\n  [ "$p" -ge 85 ] && echo "$h $p%"\ndone\ntrue'} spellCheck={false} />
                                </Field>
                                <Field label="Timeout (seconds)">
                                    <input type="number" min={5} max={900} value={str(prefilter.timeout_s) || '120'} onChange={(e) => setPrefilter({ timeout_s: Number(e.target.value) || undefined })} />
                                </Field>
                            </>
                        )}
                        {kind === 'github-prs' && (
                            <>
                                <Field label="Repository (owner/name)" hint="Empty = the project's repository URL.">
                                    <input className="mono" value={str(prefilter.repo)} onChange={(e) => setPrefilter({ repo: e.target.value })} placeholder="owner/name" />
                                </Field>
                                <Field label="Which pull requests" hint="A PR comes up again after a new push (the key carries the head commit).">
                                    <select value={str(prefilter.filter) || 'open'} onChange={(e) => setPrefilter({ filter: e.target.value })}>
                                        <option value="open">every open PR</option>
                                        <option value="review-requested">where my review is requested</option>
                                        <option value="mentioned">where I am mentioned</option>
                                    </select>
                                </Field>
                                <Field label="Also" group>
                                    <div className="row wrap" style={{ gap: '6px 16px' }}>
                                        <label className="row" style={{ gap: 8 }}>
                                            <input type="checkbox" checked={prefilter.mine === true} onChange={(e) => setPrefilter({ mine: e.target.checked })} /> <span>my own pull requests</span>
                                        </label>
                                        <label className="row" style={{ gap: 8 }}>
                                            <input type="checkbox" checked={prefilter.drafts === true} onChange={(e) => setPrefilter({ drafts: e.target.checked })} /> <span>drafts</span>
                                        </label>
                                    </div>
                                </Field>
                            </>
                        )}
                        {kind === 'trac' && (
                            <>
                                <Field label="Trac URL" hint="Base URL; append /login when the server authenticates that path. Empty = TRAC_URL from .env. Credentials: TRAC_USER + TRAC_PASSWORD (basic auth) or TRAC_COOKIE.">
                                    <input className="mono" value={str(prefilter.url)} onChange={(e) => setPrefilter({ url: e.target.value })} placeholder="https://trac.example.com" />
                                </Field>
                                <Field label="Query" hint="Trac query string, as in the URL of a custom query: status=new&component=Foo&severity=major" wide>
                                    <input className="mono" value={str(prefilter.query)} onChange={(e) => setPrefilter({ query: e.target.value })} placeholder="status=new&component=Foo" />
                                </Field>
                                <Field label="Changes count" hint="On: a ticket comes up again when it changes (a reply, a status), so a deferred one resurfaces when there is news. Off: only new ids." group>
                                    <div className="row wrap">
                                        <label className="row" style={{ gap: 8 }}>
                                            <input type="checkbox" checked={prefilter.on_change !== false} onChange={(e) => setPrefilter({ on_change: e.target.checked ? undefined : false })} /> <span>a changed ticket is new again</span>
                                        </label>
                                    </div>
                                </Field>
                            </>
                        )}
                        {kind && (
                            <>
                                <Field label="First run" hint="What the very first cron firing does with everything the prefilter already finds: mark it seen (a poller starts from now) or hand it all to the agent. Run now always hands over.">
                                    <select value={str(fm.first_run) || (kind === 'command' ? 'process' : 'skip')} onChange={(e) => set({ first_run: e.target.value })}>
                                        <option value="skip">mark existing items as seen</option>
                                        <option value="process">hand existing items to the agent</option>
                                    </select>
                                </Field>
                                <Field label="Max items per run" hint="The rest wait for the next run.">
                                    <input type="number" min={1} max={100} value={str(fm.max_items) || '10'} onChange={(e) => set({ max_items: Number(e.target.value) || undefined })} />
                                </Field>
                            </>
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
    const [results, setResults] = useState<Record<string, CronCheck>>({})
    const [pending, setPending] = useState('')
    useEffect(() => {
        const expr = pending.trim()
        if (!expr || results[expr]) return
        const timer = setTimeout(() => {
            api.checkCron(expr)
                .then((r) => setResults((prev) => ({ ...prev, [expr]: r })))
                .catch((e: Error) => setResults((prev) => ({ ...prev, [expr]: { ok: false, error: e.message, tz: '' } })))
        }, 250)
        return () => clearTimeout(timer)
    }, [pending, results])
    return {
        ask: (expr: string) => setPending(expr),
        result: (expr: string): CronCheck | undefined => results[expr.trim()]
    }
}

function CronField({ value, onChange, check }: { value: string; onChange: (v: string) => void; check: ReturnType<typeof useCronCheck> }) {
    useEffect(() => check.ask(value), [value, check])
    const result = check.result(value)
    const hint = !value.trim() ? (
        'minute hour day month weekday · 0 8 * * mon-fri = weekdays at 08:00 · */15 * * * * = every 15 min · @daily, @hourly'
    ) : !result ? (
        'checking…'
    ) : result.ok ? (
        <>
            <strong style={{ color: 'var(--text-2)' }}>{result.text}</strong> · {result.tz}
            {result.next ? ` · next ${fmt.when(result.next)} (in ${fmt.until(result.next)})` : ' · never fires within a year'}
        </>
    ) : (
        <span className="error">{result.error}</span>
    )
    return (
        <Field label="Cron (minute hour day month weekday)" hint={hint} wide>
            <input className="mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0 8 * * mon-fri" aria-invalid={!value.trim() || (result ? !result.ok : undefined)} />
        </Field>
    )
}

/**
 * What the file cannot say: whether the schedule is valid, when it fires
 * next, what the last firing did, the prefilter's current view, and the
 * buttons that act on the schedule rather than on its text.
 */
function Status({ entry, view, onChanged }: { entry: CatalogEntry; view: ScheduleView | undefined; onChanged: () => void }) {
    const [busy, setBusy] = useState<'run' | 'preview' | 'forget' | 'toggle' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [preview, setPreview] = useState<SchedulePreview | null>(null)
    const [showRuns, setShowRuns] = useState(false)
    // By default only the firings that mattered; every poll and skip on request.
    const [allRuns, setAllRuns] = useState(false)
    const runs = useAsync(() => (showRuns ? api.scheduleRuns(entry.name, RUNS_SHOWN, allRuns) : Promise.resolve([] as ScheduleRun[])), [entry.name, showRuns, allRuns, view?.last_run?.id, view?.last_task?.task_status])
    const [toast, showToast] = useToast()
    const confirm = useConfirm()
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
    const run = () => act('run', async () => {
        const r = await api.runSchedule(entry.name)
        return `${r.status}${r.note ? ` — ${r.note}` : ''}`
    })
    const doPreview = () => act('preview', async () => {
        setPreview(await api.previewSchedule(entry.name))
        return null
    })
    const toggle = () => act('toggle', async () => {
        await api.enableSchedule(entry.name, !view.enabled)
        return view.enabled ? 'Switched off' : 'Switched on'
    })
    const forget = () =>
        void confirm({
            title: `Forget what “${entry.name}” has seen?`,
            message: (
                <>
                    {view.seen} item(s) are marked as handed over. Forgetting them makes the next run treat everything the prefilter finds as new — up to the schedule's max items per run.
                </>
            ),
            action: 'Forget',
            pending: 'Forgetting…',
            danger: true,
            icon: 'warning',
            onConfirm: async () => {
                const r = await api.forgetScheduleSeen(entry.name)
                showToast(`Forgot ${r.forgotten} item(s)`)
                onChanged()
            }
        })

    const last = view.last_run
    const lastTask = view.last_task
    return (
        <div className="card pad0 schedule-status" style={{ marginBottom: 14 }}>
            <div className="stat-row">
                <div className="stat">
                    <span className="label dim">Fires</span>
                    <span className="value small" style={{ fontSize: 13 }}>
                        {view.cron_text ?? view.cron ?? '—'}
                        {view.once ? ' · once' : ''}
                        {view.model ? ` · ${view.model}` : ''}
                    </span>
                    <span className="small dim">
                        {view.tz}
                        {view.window?.days ? ` · ${dayList(view.window.days)}` : ''}
                        {view.window?.hours ? ` · ${view.window.hours}` : ''}
                    </span>
                </div>
                <div className="stat">
                    <span className="label dim">Next run</span>
                    <span className="value small" style={{ fontSize: 13 }}>
                        {view.next_run ? `in ${fmt.until(view.next_run)}` : view.enabled ? 'never (no matching minute within a year)' : 'off'}
                    </span>
                    {view.next_run && <span className="small dim">{fmt.when(view.next_run)}</span>}
                </div>
                <div className="stat">
                    <span className="label dim">Last firing</span>
                    <span className="value small" style={{ fontSize: 13 }}>
                        {last ? (
                            <>
                                <span className={`badge ${runTone(last.status)}`}>{last.status}</span> {fmt.ago(last.fired_at)}
                            </>
                        ) : (
                            'never'
                        )}
                    </span>
                    {last?.note && (
                        <span className={`small ${last.status === 'missed' || last.status === 'error' ? '' : 'dim'}`} style={last.status === 'missed' ? { color: 'var(--amber)' } : last.status === 'error' ? { color: 'var(--red)' } : undefined}>
                            {last.note}
                        </span>
                    )}
                </div>
                <div className="stat">
                    <span className="label dim">Last task</span>
                    <span className="value small" style={{ fontSize: 13 }}>
                        {lastTask ? (
                            <>
                                <RunBadge run={lastTask} /> {fmt.ago(lastTask.fired_at)}
                            </>
                        ) : (
                            'none yet'
                        )}
                    </span>
                    <span className="row" style={{ gap: 10 }}>
                        {lastTask?.task_id && (
                            <Link className="small" to={`/tasks/${lastTask.task_id}`}>
                                open task
                            </Link>
                        )}
                        {view.conversation_id && (
                            <Link className="small" to={`/chat/${view.conversation_id}`}>
                                open thread
                            </Link>
                        )}
                    </span>
                </div>
                <div className="stat">
                    <span className="label dim">Seen items</span>
                    <span className="value small" style={{ fontSize: 13 }}>
                        {view.prefilter ? view.seen : 'no prefilter'}
                    </span>
                </div>
            </div>
            {(view.errors.length > 0 || view.warnings.length > 0) && (
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }} className="stack">
                    {view.errors.map((e) => (
                        <div key={e} className="error small">
                            {e}
                        </div>
                    ))}
                    {view.warnings.map((w) => (
                        <div key={w} className="small" style={{ color: 'var(--amber)' }}>
                            {w}
                        </div>
                    ))}
                </div>
            )}
            <div className="row wrap" style={{ padding: '10px 16px', gap: 8 }}>
                {view.errors.length ? <span className="badge failed">invalid</span> : view.enabled ? <span className="badge done">on</span> : <span className="badge cancelled">off</span>}
                <span className="state-gap" />
                <Button size="sm" variant="primary" onClick={run} disabled={busy !== null || view.errors.length > 0 || view.active_task !== null} title={view.active_task ? `a run is ${view.active_task.status}` : 'Fire now: skips the cron, the window and the soft-stop; hands over what the prefilter finds'}>
                    {busy === 'run' ? 'Firing…' : 'Run now'}
                </Button>
                {view.prefilter && (
                    <Button size="sm" onClick={doPreview} disabled={busy !== null || view.errors.length > 0} title="Run the prefilter and show what it finds; marks nothing">
                        {busy === 'preview' ? 'Checking…' : 'Preview prefilter'}
                    </Button>
                )}
                <Button size="sm" onClick={toggle} disabled={busy !== null || view.errors.length > 0}>
                    {busy === 'toggle' ? '…' : view.enabled ? 'Switch off' : 'Switch on'}
                </Button>
                {view.prefilter && view.seen > 0 && (
                    <Button size="sm" variant="danger" onClick={forget} disabled={busy !== null}>
                        Forget seen items
                    </Button>
                )}
                <span className="grow" />
                <Button size="sm" variant="ghost" onClick={() => setShowRuns((v) => !v)}>
                    {showRuns ? 'Hide runs' : 'Show runs'}
                </Button>
                {view.active_task && (
                    <Link className="badge running" to={`/tasks/${view.active_task.id}`}>
                        {view.active_task.status}
                    </Link>
                )}
            </div>
            <ErrorBox error={error} />
            {preview && (
                <div style={{ padding: '0 16px 12px' }}>
                    <div className="row between">
                        <span className="small dim">
                            Prefilter found {preview.items.length} item(s) in {fmt.duration(preview.ms)}, {preview.new_keys.length} new
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                            Close
                        </Button>
                    </div>
                    {preview.items.length > 0 && (
                        <div className="mcp-servers" style={{ marginTop: 6 }}>
                            {preview.items.map((item) => (
                                <div key={item.key} className="mcp-server row" style={{ gap: 10 }}>
                                    <span className={`badge ${preview.new_keys.includes(item.key) ? (item.seen_before ? 'amber' : 'done') : 'cancelled'}`} title={item.seen_before ? `handed over ${fmt.when(item.seen_before)}, changed since` : undefined}>
                                        {preview.new_keys.includes(item.key) ? (item.seen_before ? 'changed' : 'new') : 'seen'}
                                    </span>
                                    <span className="grow">
                                        {item.url ? (
                                            <a href={item.url} target="_blank" rel="noreferrer">
                                                {item.title}
                                            </a>
                                        ) : (
                                            item.title
                                        )}
                                        {item.text && <span className="dim small"> · {item.text}</span>}
                                    </span>
                                    <span className="mono dim small">{item.key}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {showRuns && (
                <div className="card-scroll schedule-runs">
                    <label className="row small dim" style={{ gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
                        <input type="checkbox" checked={allRuns} onChange={(e) => setAllRuns(e.target.checked)} /> <span>every firing, including empty polls and skips</span>
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
                                        <th>Prefilter</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {runs.data.map((r) => (
                                        <tr key={r.id}>
                                            <td className="nowrap" title={fmt.when(r.fired_at)}>
                                                {fmt.ago(r.fired_at)}
                                            </td>
                                            <td>{r.trigger}</td>
                                            <td>
                                                <RunBadge run={r} />
                                            </td>
                                            <td className="col-main small">{r.note ?? ''}</td>
                                            <td>{r.items || ''}</td>
                                            <td className="dim nowrap">{r.duration_ms ? fmt.duration(r.duration_ms) : ''}</td>
                                            <td>{r.task_id && <Link to={`/tasks/${r.task_id}`}>task</Link>}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {runs.data.length >= RUNS_SHOWN && <div className="dim small" style={{ padding: '8px 16px' }}>The last {RUNS_SHOWN} runs.</div>}
                        </>
                    ) : (
                        <div className="dim small" style={{ padding: '10px 16px' }}>
                            {runs.loading ? 'Loading…' : allRuns ? 'No firings yet.' : 'No task, error or missed firing yet.'}
                        </div>
                    )}
                </div>
            )}
            {toast}
        </div>
    )
}
