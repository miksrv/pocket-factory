import { Editor, Field, str } from '../components/Editor'
import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'

interface Host {
    name?: string
    ssh?: string
    path?: string
    notes?: string
}

const TEMPLATE = `Notes for the agent: conventions, gotchas, what never to touch, how deploys work.
`

const TRACKERS = ['none', 'github', 'clickup', 'trac', 'jira']

export function ProjectsPage() {
    const status = useAsync(() => api.status(), [])
    const skills = useAsync(() => api.list('skills'), [])
    const workspaces = status.data?.workspaces ?? []

    return (
        <Editor
            kind="projects"
            title="Projects"
            sub="Knowledge base: one file per repository — where it is, how to branch, what to run, which hosts it lives on. Files in data/config/projects/."
            defaults={{ name: '', repo: '', default_branch: 'main', pr_base: 'main', branch_prefix: 'feature/', skill: 'feature-to-pr', tracker: { type: 'none' }, hosts: [], checks: [] }}
            template={TEMPLATE}
            bodyLabel="Notes for the agent (Markdown)"
            describe={(e) => [e.frontmatter.name, e.frontmatter.repo].filter(Boolean).join(' · ')}
            form={(fm, set) => {
                const tracker = (fm.tracker as Record<string, unknown> | undefined) ?? {}
                const hosts = (Array.isArray(fm.hosts) ? fm.hosts : []) as Host[]
                const checks = Array.isArray(fm.checks) ? (fm.checks as string[]) : []
                const setHost = (i: number, patch: Host) => set({ hosts: hosts.map((h, j) => (j === i ? { ...h, ...patch } : h)) })
                return (
                    <>
                        <Field label="Display name">
                            <input value={str(fm.name)} onChange={(e) => set({ name: e.target.value })} />
                        </Field>
                        <Field label="Checkout" hint="Directory under the workspaces root. Defaults to the file name.">
                            <input className="mono" list="workspaces" value={str(fm.path)} onChange={(e) => set({ path: e.target.value })} placeholder={`${status.data?.paths.workspaces ?? '/data/workspaces'}/<name>`} />
                            <datalist id="workspaces">
                                {workspaces.map((w) => (
                                    <option key={w.name} value={`${status.data?.paths.workspaces}/${w.name}`} />
                                ))}
                            </datalist>
                        </Field>
                        <Field label="Repository URL">
                            <input className="mono" value={str(fm.repo)} onChange={(e) => set({ repo: e.target.value })} placeholder="https://github.com/owner/repo" />
                        </Field>
                        <Field label="Default branch">
                            <input className="mono" value={str(fm.default_branch)} onChange={(e) => set({ default_branch: e.target.value })} />
                        </Field>
                        <Field label="PR base branch">
                            <input className="mono" value={str(fm.pr_base)} onChange={(e) => set({ pr_base: e.target.value })} />
                        </Field>
                        <Field label="Branch prefix">
                            <input className="mono" value={str(fm.branch_prefix)} onChange={(e) => set({ branch_prefix: e.target.value })} />
                        </Field>
                        <Field label="Workflow (skill)">
                            <select value={str(fm.skill)} onChange={(e) => set({ skill: e.target.value })}>
                                <option value="">— none —</option>
                                {(skills.data ?? []).map((s) => (
                                    <option key={s.name} value={s.name}>
                                        {s.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Tracker">
                            <select value={str(tracker.type) || 'none'} onChange={(e) => set({ tracker: { ...tracker, type: e.target.value } })}>
                                {TRACKERS.map((t) => (
                                    <option key={t} value={t}>
                                        {t}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Tracker URL / project">
                            <input className="mono" value={str(tracker.url)} onChange={(e) => set({ tracker: { ...tracker, url: e.target.value } })} />
                        </Field>
                        <Field label="Tracker state after PR" hint="Where the agent moves a ticket once the PR is open.">
                            <input value={str(tracker.review_state)} onChange={(e) => set({ tracker: { ...tracker, review_state: e.target.value } })} placeholder="Review" />
                        </Field>
                        <Field label="Checks (one per line)" hint="Run before a PR is opened. All must pass.">
                            <textarea className="mono" rows={3} value={checks.join('\n')} onChange={(e) => set({ checks: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
                        </Field>
                        <div style={{ gridColumn: '1 / -1' }}>
                            <div className="row between" style={{ marginBottom: 6 }}>
                                <span className="dim small" style={{ fontWeight: 500 }}>
                                    HOSTS — servers this project runs on (reachable with keys in data/secrets/ssh/)
                                </span>
                                <button className="sm" onClick={() => set({ hosts: [...hosts, { name: '', ssh: '' }] })}>
                                    Add host
                                </button>
                            </div>
                            {hosts.length === 0 && <div className="dim small">No hosts.</div>}
                            {hosts.map((h, i) => (
                                <div key={i} className="row top hosts-row" style={{ marginBottom: 8 }}>
                                    <input style={{ width: 140 }} placeholder="production" value={h.name ?? ''} onChange={(e) => setHost(i, { name: e.target.value })} />
                                    <input className="mono" style={{ width: 220 }} placeholder="deploy@203.0.113.10" value={h.ssh ?? ''} onChange={(e) => setHost(i, { ssh: e.target.value })} />
                                    <input className="mono" style={{ width: 200 }} placeholder="/srv/app" value={h.path ?? ''} onChange={(e) => setHost(i, { path: e.target.value })} />
                                    <input className="grow" placeholder="notes: how to restart, where logs are" value={h.notes ?? ''} onChange={(e) => setHost(i, { notes: e.target.value })} />
                                    <button className="sm danger" onClick={() => set({ hosts: hosts.filter((_, j) => j !== i) })}>
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    </>
                )
            }}
        />
    )
}
