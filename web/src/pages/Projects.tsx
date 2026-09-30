import { useRef, useState } from 'react'

import { Editor, Field, str } from '../components/Editor'
import { Button, GrowingTextarea } from '../components/ui'
import { api, type CatalogEntry, type McpEntry } from '../lib/api'
import { useAsync } from '../lib/useAsync'

interface Host {
    name?: string
    /** user@host or user@host:port */
    ssh?: string
    /** File name of the private key in data/secrets/ssh; empty = ssh's own defaults. */
    key?: string
    path?: string
    notes?: string
}

const TEMPLATE = `Notes for the agent: conventions, gotchas, what never to touch, how deploys work.
`

const TRACKERS = ['none', 'github', 'clickup', 'trac', 'jira']

/**
 * A list edited as lines. The text is kept as typed (a trailing newline or
 * space would otherwise vanish under the cursor) and parsed on the way out.
 */
function LinesInput({ value, onChange }: { value: string[]; onChange: (lines: string[]) => void }) {
    const [text, setText] = useState(value.join('\n'))
    return (
        <textarea
            className="mono"
            rows={4}
            value={text}
            onChange={(e) => {
                setText(e.target.value)
                onChange(
                    e.target.value
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean)
                )
            }}
        />
    )
}

export function ProjectsPage() {
    const status = useAsync(() => api.status(), [])
    const skills = useAsync(() => api.list('skills'), [])
    const keys = useAsync(() => api.sshKeys(), [])
    const mcp = useAsync(() => api.mcp(), [])
    const workspaces = status.data?.workspaces ?? []
    // Stable keys for the host cards (their test result is local state): one id per row, handed out
    // as rows appear and removed with them. Never written into the frontmatter.
    const hostIds = useRef<number[]>([])
    const nextHostId = useRef(0)

    return (
        <Editor
            kind="projects"
            title="Projects"
            sub="Knowledge base: one file per repository — where it is, how to branch, what to run, which hosts it lives on. Files in data/config/projects/."
            defaults={{ name: '', repo: '', default_branch: 'main', pr_base: 'main', skill: 'feature-to-pr', tracker: { type: 'none' }, hosts: [], checks: [] }}
            template={TEMPLATE}
            bodyLabel="Notes for the agent (Markdown)"
            describe={(e) => [e.frontmatter.name, e.frontmatter.repo].filter(Boolean).join(' · ')}
            intro="A project file tells the agent where a repository lives, how to branch, what to run and which hosts it touches. Pick one from the list to edit it, or describe a new one."
            newLabel="New project"
            form={(fm, set) => {
                const tracker = (fm.tracker as Record<string, unknown> | undefined) ?? {}
                const trackerType = str(tracker.type) || 'none'
                const hosts = (Array.isArray(fm.hosts) ? fm.hosts : []) as Host[]
                const checks = Array.isArray(fm.checks) ? (fm.checks as string[]) : []
                const setHost = (i: number, patch: Host) => set({ hosts: hosts.map((h, j) => (j === i ? { ...h, ...patch } : h)) })
                const removeHost = (i: number) => {
                    hostIds.current.splice(i, 1)
                    set({ hosts: hosts.filter((_, j) => j !== i) })
                }
                while (hostIds.current.length < hosts.length) hostIds.current.push(nextHostId.current++)
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
                        <Field label="Development workflow" hint="The skill that turns a change request into a pull request in this repository. Other kinds of task (a ticket, a review, a host check) pick their own skill.">
                            <select value={str(fm.skill)} onChange={(e) => set({ skill: e.target.value })}>
                                <option value="">— none —</option>
                                {workflowSkills(skills.data ?? []).map((s) => (
                                    <option key={s.name} value={s.name}>
                                        {s.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Default branch" hint="Branches are cut from it: feature/… for features, fix/… for defects, unless the notes say otherwise.">
                            <input className="mono" value={str(fm.default_branch)} onChange={(e) => set({ default_branch: e.target.value })} />
                        </Field>
                        <Field label="PR base branch">
                            <input className="mono" value={str(fm.pr_base)} onChange={(e) => set({ pr_base: e.target.value })} />
                        </Field>
                        <Field label="Tracker" hint="Where tickets live. A task that names a ticket gets the PR link as a comment; status rules go in the notes.">
                            <select value={trackerType} onChange={(e) => set({ tracker: e.target.value === 'none' ? { type: 'none' } : { ...tracker, type: e.target.value } })}>
                                {TRACKERS.map((t) => (
                                    <option key={t} value={t}>
                                        {t}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        {trackerType !== 'none' && (
                            <>
                                <Field label="Tracker URL / project" hint="Issues page, board or project the tickets belong to.">
                                    <input className="mono" value={str(tracker.url)} onChange={(e) => set({ tracker: { ...tracker, url: e.target.value } })} />
                                </Field>
                            </>
                        )}
                        <McpField slug={str(fm.slug)} allowed={Array.isArray(fm.mcp) ? (fm.mcp as string[]) : null} declared={mcp.data?.projects.find((p) => p.slug === str(fm.slug))?.servers ?? []} registry={mcp.data?.servers ?? []} onChange={(next) => set({ mcp: next })} />
                        <Field label="Checks (one per line)" hint="Run from the repository root before a PR is opened. All must pass." wide>
                            <LinesInput value={checks} onChange={(next) => set({ checks: next })} />
                        </Field>
                        <div className="field wide hosts">
                            <div className="field-head">
                                <span>
                                    Hosts — servers this project runs on
                                    <span className="dim"> · reached over SSH with the keys in {keys.data?.dir ?? 'data/secrets/ssh/'}; passwords are not supported on purpose</span>
                                </span>
                                <Button size="sm" onClick={() => set({ hosts: [...hosts, { name: '', ssh: '' }] })}>
                                    Add host
                                </Button>
                            </div>
                            {hosts.length === 0 && <div className="dim small">No hosts. The agent can still work on the repository; host checks need at least one.</div>}
                            {hosts.map((h, i) => (
                                <HostCard key={hostIds.current[i]} host={h} keys={keys.data?.keys ?? []} knownHosts={keys.data?.known_hosts ?? false} onChange={(patch) => setHost(i, patch)} onRemove={() => removeHost(i)} />
                            ))}
                        </div>
                    </>
                )
            }}
        />
    )
}

/**
 * Which of the checkout's `.mcp.json` servers a session bound to this project
 * loads. Nothing selected explicitly = all of them (no `mcp:` in the file);
 * toggling writes the allowlist, and the others are turned off with
 * `disabledMcpjsonServers` at spawn.
 */
/** The registry key of a server name, the way the CLI prefixes its tools (`mcp__<key>__`). */
const mcpKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * The servers the checkout declares in `.mcp.json`, one row each like the agent
 * form: a box for "sessions of this project load it" (the `mcp:` allowlist), the
 * status the CLI last reported and how many tools it brings. Connectors and
 * factory-wide servers are not listed: every session has them anyway.
 */
function McpField({ slug, allowed, declared, registry, onChange }: { slug: string; allowed: string[] | null; declared: Array<{ name: string; type: string; target: string; connector?: string | null }>; registry: McpEntry[]; onChange: (next: string[] | undefined) => void }) {
    if (!slug) return null
    const on = (name: string) => allowed === null || allowed.includes(name)
    const toggle = (name: string) => {
        const current = allowed ?? declared.map((s) => s.name)
        const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
        onChange(next.length === declared.length && declared.every((s) => next.includes(s.name)) ? undefined : next)
    }
    const tone = (status: string) => (status === 'connected' ? 'done' : status === 'needs-auth' ? 'queued' : status === 'failed' ? 'failed' : 'cancelled')
    return (
        <Field label="MCP servers from the repository" hint={declared.length ? 'Declared in the checkout\'s .mcp.json; a session bound to this project loads the ones switched on. Statuses come from the last sessions and Settings → MCP → Refresh, where a sign-in is done once (Authorize). claude.ai connectors and factory-wide servers apply to every session and are not listed here; a server with a connector\'s URL is that connector, and the entry adds nothing.' : 'The checkout has no .mcp.json. claude.ai connectors and factory-wide servers (Settings → MCP) apply to every session anyway.'} wide>
            {declared.length === 0 ? (
                <span className="dim small">none</span>
            ) : (
                <div className="mcp-servers">
                    {declared.map((s) => {
                        const entry = registry.find((e) => e.key === mcpKey(s.name))
                        const status = entry?.status ?? 'unknown'
                        return (
                            <label key={s.name} className="mcp-server row" title={s.target}>
                                <input type="checkbox" checked={on(s.name)} onChange={() => toggle(s.name)} />
                                <span className="grow">
                                    <strong>{s.name}</strong> <span className="dim">· {s.type}{entry?.tools ? ` · ${entry.tools} tools` : ''}</span>
                                    {s.connector && <span className="dim"> · same server as the {s.connector} connector</span>}
                                </span>
                                {s.connector ? (
                                    <span className="badge done" title="The connector with this URL is authorized for the account and loads in every session; the CLI drops this duplicate">via connector</span>
                                ) : (
                                    <span className={`badge ${tone(status)}`}>{status === 'needs-auth' ? 'needs authentication' : status === 'unknown' ? 'not seen yet' : status}</span>
                                )}
                            </label>
                        )
                    })}
                </div>
            )}
        </Field>
    )
}

/** Skills that describe a build-to-PR procedure; knowledge skills (conventions) are not workflows. */
function workflowSkills(skills: CatalogEntry[]): CatalogEntry[] {
    const isWorkflow = (s: CatalogEntry) => /pull request|\bPR\b/i.test(String(s.frontmatter.description ?? ''))
    const list = skills.filter(isWorkflow)
    return (list.length ? list : skills).sort((a, b) => (a.name === 'feature-to-pr' ? -1 : b.name === 'feature-to-pr' ? 1 : a.name.localeCompare(b.name)))
}

/** One server: where it is, which key opens it, and a test button that tries exactly that. */
function HostCard({ host, keys, knownHosts, onChange, onRemove }: { host: Host; keys: Array<{ name: string; public: boolean }>; knownHosts: boolean; onChange: (patch: Host) => void; onRemove: () => void }) {
    const [test, setTest] = useState<{ busy: boolean; ok?: boolean; output?: string; ms?: number }>({ busy: false })
    const run = async () => {
        setTest({ busy: true })
        try {
            const result = await api.testHost(host.ssh ?? '', host.key)
            setTest({ busy: false, ...result })
        } catch (e) {
            setTest({ busy: false, ok: false, output: (e as Error).message })
        }
    }
    return (
        <div className="host-card">
            <label className="field">
                <span>Name</span>
                <input placeholder="production" value={host.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} />
            </label>
            <label className="field">
                <span>SSH target</span>
                <input className="mono" placeholder="deploy@203.0.113.10 or deploy@host:2222" value={host.ssh ?? ''} onChange={(e) => onChange({ ssh: e.target.value })} />
            </label>
            <label className="field">
                <span>Key</span>
                <select value={host.key ?? ''} onChange={(e) => onChange({ key: e.target.value || undefined })}>
                    <option value="">default (~/.ssh/config or id_*)</option>
                    {host.key && !keys.some((k) => k.name === host.key) && <option value={host.key}>{host.key} (missing)</option>}
                    {keys.map((k) => (
                        <option key={k.name} value={k.name}>
                            {k.name}
                        </option>
                    ))}
                </select>
                {keys.length === 0 && <span className="dim">No keys yet: `ssh-keygen -t ed25519 -f data/secrets/ssh/id_ed25519 -C pocket-factory`, add the .pub to the host.</span>}
            </label>
            <label className="field">
                <span>Path</span>
                <input className="mono" placeholder="/srv/app" value={host.path ?? ''} onChange={(e) => onChange({ path: e.target.value })} />
            </label>
            <label className="field wide">
                <span>Notes</span>
                <GrowingTextarea placeholder="how to restart, where the logs are, what never to touch" value={host.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value })} />
            </label>
            <div className="host-foot wide">
                <Button size="sm" onClick={run} disabled={test.busy || !host.ssh?.trim()} title="ssh -o BatchMode=yes <target> echo ok">
                    {test.busy ? 'Connecting…' : 'Test connection'}
                </Button>
                {test.ok === true && <span className="badge done">reachable · {test.ms} ms</span>}
                {test.ok === false && <span className="badge failed">failed</span>}
                {test.output && <code className="host-output" title={test.output}>{test.output.split('\n').at(-1)}</code>}
                {!knownHosts && <span className="dim small">{'no known_hosts yet: ssh-keyscan <host> >> data/secrets/ssh/known_hosts'}</span>}
                <span className="grow" />
                <Button size="sm" variant="danger" onClick={onRemove} aria-label="Remove host">
                    Remove
                </Button>
            </div>
        </div>
    )
}
