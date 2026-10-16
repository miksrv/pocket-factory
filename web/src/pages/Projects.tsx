import { Editor, Field, str } from '../components/Editor'
import { ProjectHosts } from '../components/Hosts'
import { ProjectToolchainField } from '../components/Toolchains'
import { Button } from '../components/ui'
import { api, type CatalogEntry, type McpEntry, type ProjectHost } from '../lib/api'
import { useAsync } from '../lib/useAsync'

// The notes are the agent's briefing: what the supervisor never reads (the checks to run, the tracker) is prose here, not a field.
const TEMPLATE = `Notes for the agent: conventions, gotchas, what never to touch, how deploys work.

Checks before a PR, from the repository root (all must pass): \`yarn lint\`, \`yarn test\`.

Tracker: where the tickets live, and what to do with a ticket once its PR is open (a comment with the link; a status, tag or assignee to set).
`

export function ProjectsPage() {
    const status = useAsync(() => api.status(), [])
    const skills = useAsync(() => api.list('skills'), [])
    const keys = useAsync(() => api.sshKeys(), [])
    const sharedHosts = useAsync(() => api.hosts(), [])
    const mcp = useAsync(() => api.mcp(), [])
    const providers = useAsync(() => api.providers(), [])
    const workspaces = status.data?.workspaces ?? []

    return (
        <Editor
            kind='projects'
            title='Projects'
            sub='Knowledge base: one file per repository — where it is, how to branch, what to run, which hosts it lives on. Files in data/config/projects/.'
            defaults={{
                name: '',
                repo: '',
                default_branch: 'main',
                pr_base: 'main',
                skill: 'feature-to-pr',
                hosts: []
            }}
            template={TEMPLATE}
            bodyLabel='Notes for the agent (Markdown)'
            describe={(e) => [e.frontmatter.name, e.frontmatter.repo].filter(Boolean).join(' · ')}
            intro='A project file tells the agent where a repository lives, how to branch, what to run and which hosts it touches. Pick one from the list to edit it, or describe a new one.'
            newLabel='New project'
            form={(fm, set) => {
                const hosts = (Array.isArray(fm.hosts) ? fm.hosts : []).filter(
                    (h): h is ProjectHost => Boolean(h) && typeof h === 'object'
                )
                return (
                    <>
                        <Field label='Display name'>
                            <input
                                value={str(fm.name)}
                                onChange={(e) => set({ name: e.target.value })}
                            />
                        </Field>
                        <Field
                            label='Checkout'
                            hint='Directory under the workspaces root. Defaults to the file name.'
                        >
                            <input
                                className='mono'
                                list='workspaces'
                                value={str(fm.path)}
                                onChange={(e) => set({ path: e.target.value })}
                                placeholder={`${status.data?.paths.workspaces ?? '/data/workspaces'}/<name>`}
                            />
                            <datalist id='workspaces'>
                                {workspaces.map((w) => (
                                    <option
                                        key={w.name}
                                        value={`${status.data?.paths.workspaces}/${w.name}`}
                                    />
                                ))}
                            </datalist>
                        </Field>
                        <Field label='Repository URL'>
                            <input
                                className='mono'
                                value={str(fm.repo)}
                                onChange={(e) => set({ repo: e.target.value })}
                                placeholder='https://github.com/owner/repo'
                            />
                        </Field>
                        <Field
                            label='Development workflow'
                            hint='The skill that turns a change request into a pull request in this repository. Other kinds of task (a ticket, a review, a host check) pick their own skill.'
                        >
                            <select
                                value={str(fm.skill)}
                                onChange={(e) => set({ skill: e.target.value })}
                            >
                                <option value=''>— none —</option>
                                {workflowSkills(skills.data ?? []).map((s) => (
                                    <option
                                        key={s.name}
                                        value={s.name}
                                    >
                                        {s.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field
                            label='Default branch'
                            hint='Branches are cut from it: feature/… for features, fix/… for defects, unless the notes say otherwise.'
                        >
                            <input
                                className='mono'
                                value={str(fm.default_branch)}
                                onChange={(e) => set({ default_branch: e.target.value })}
                            />
                        </Field>
                        <Field label='PR base branch'>
                            <input
                                className='mono'
                                value={str(fm.pr_base)}
                                onChange={(e) => set({ pr_base: e.target.value })}
                            />
                        </Field>
                        <McpField
                            slug={str(fm.slug)}
                            allowed={Array.isArray(fm.mcp) ? (fm.mcp as string[]) : null}
                            declared={mcp.data?.projects.find((p) => p.slug === str(fm.slug))?.servers ?? []}
                            registry={mcp.data?.servers ?? []}
                            onChange={(next) => set({ mcp: next })}
                        />
                        {(providers.data?.providers.length ?? 0) > 0 && (
                            <Field
                                label='Providers this project may delegate to'
                                hint="A role on another provider (an agent file with a provider) gets this project's work only when its provider is ticked here; otherwise the orchestrator's own model runs the role. Keep work code off a box you would not give it to."
                                wide
                                group
                            >
                                <div
                                    className='row wrap'
                                    style={{ gap: 6 }}
                                >
                                    {providers.data!.providers.map((p) => {
                                        const allowed = Array.isArray(fm.providers) ? (fm.providers as string[]) : []
                                        const on = allowed.includes(p.name)
                                        return (
                                            <Button
                                                key={p.name}
                                                className={`chip${on ? ' on' : ''}`}
                                                aria-pressed={on}
                                                onClick={() => {
                                                    const next = on
                                                        ? allowed.filter((n) => n !== p.name)
                                                        : [...allowed, p.name]
                                                    set({ providers: next.length ? next : undefined })
                                                }}
                                            >
                                                {p.name}
                                            </Button>
                                        )
                                    })}
                                </div>
                            </Field>
                        )}
                        <ProjectToolchainField slug={str(fm.slug)} />
                        <ProjectHosts
                            value={hosts}
                            onChange={(next) => set({ hosts: next })}
                            shared={sharedHosts.data}
                            onSharedChanged={sharedHosts.reload}
                            keys={keys.data}
                        />
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
function McpField({
    slug,
    allowed,
    declared,
    registry,
    onChange
}: {
    slug: string
    allowed: string[] | null
    declared: Array<{ name: string; type: string; target: string; connector?: string | null }>
    registry: McpEntry[]
    onChange: (next: string[] | undefined) => void
}) {
    if (!slug) return null
    const on = (name: string) => allowed === null || allowed.includes(name)
    const toggle = (name: string) => {
        const current = allowed ?? declared.map((s) => s.name)
        const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
        onChange(next.length === declared.length && declared.every((s) => next.includes(s.name)) ? undefined : next)
    }
    const tone = (status: string) =>
        status === 'connected'
            ? 'done'
            : status === 'needs-auth'
              ? 'queued'
              : status === 'failed'
                ? 'failed'
                : 'cancelled'
    return (
        <Field
            label='MCP servers from the repository'
            hint={
                declared.length
                    ? "Declared in the checkout's .mcp.json; a session bound to this project loads the ones switched on. Statuses come from the last sessions and Settings → MCP → Refresh, where a sign-in is done once (Authorize). claude.ai connectors and factory-wide servers apply to every session and are not listed here; a server with a connector's URL is that connector, and the entry adds nothing."
                    : 'The checkout has no .mcp.json. claude.ai connectors and factory-wide servers (Settings → MCP) apply to every session anyway.'
            }
            wide
            group
        >
            {declared.length === 0 ? (
                <span className='dim small'>none</span>
            ) : (
                <div className='mcp-servers'>
                    {declared.map((s) => {
                        const entry = registry.find((e) => e.key === mcpKey(s.name))
                        const status = entry?.status ?? 'unknown'
                        return (
                            <label
                                key={s.name}
                                className='mcp-server row'
                                title={s.target}
                            >
                                <input
                                    type='checkbox'
                                    checked={on(s.name)}
                                    onChange={() => toggle(s.name)}
                                />
                                <span className='grow'>
                                    <strong>{s.name}</strong>{' '}
                                    <span className='dim'>
                                        · {s.type}
                                        {entry?.tools ? ` · ${entry.tools} tools` : ''}
                                    </span>
                                    {s.connector && (
                                        <span className='dim'> · same server as the {s.connector} connector</span>
                                    )}
                                </span>
                                {s.connector ? (
                                    <span
                                        className='badge done'
                                        title='The connector with this URL is authorized for the account and loads in every session; the CLI drops this duplicate'
                                    >
                                        via connector
                                    </span>
                                ) : (
                                    <span className={`badge ${tone(status)}`}>
                                        {status === 'needs-auth'
                                            ? 'needs authentication'
                                            : status === 'unknown'
                                              ? 'not seen yet'
                                              : status}
                                    </span>
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
    return (list.length ? list : skills).sort((a, b) =>
        a.name === 'feature-to-pr' ? -1 : b.name === 'feature-to-pr' ? 1 : a.name.localeCompare(b.name)
    )
}
