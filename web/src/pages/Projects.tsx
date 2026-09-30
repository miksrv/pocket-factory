import { useState } from 'react'

import { Editor, Field, str } from '../components/Editor'
import { ProjectHosts } from '../components/Hosts'
import { api, type CatalogEntry, type McpEntry, type ProjectHost } from '../lib/api'
import { useAsync } from '../lib/useAsync'

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
    const sharedHosts = useAsync(() => api.hosts(), [])
    const mcp = useAsync(() => api.mcp(), [])
    const workspaces = status.data?.workspaces ?? []

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
                const hosts = (Array.isArray(fm.hosts) ? fm.hosts : []).filter((h): h is ProjectHost => Boolean(h) && typeof h === 'object')
                const checks = Array.isArray(fm.checks) ? (fm.checks as string[]) : []
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
                        <ProjectHosts value={hosts} onChange={(next) => set({ hosts: next })} shared={sharedHosts.data} onSharedChanged={sharedHosts.reload} keys={keys.data} />
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
        <Field label="MCP servers from the repository" hint={declared.length ? 'Declared in the checkout\'s .mcp.json; a session bound to this project loads the ones switched on. Statuses come from the last sessions and Settings → MCP → Refresh, where a sign-in is done once (Authorize). claude.ai connectors and factory-wide servers apply to every session and are not listed here; a server with a connector\'s URL is that connector, and the entry adds nothing.' : 'The checkout has no .mcp.json. claude.ai connectors and factory-wide servers (Settings → MCP) apply to every session anyway.'} wide group>
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
