import { type ReactNode, useState } from 'react'

import { Editor, Field, str } from '../components/Editor'
import { ProjectHosts } from '../components/Hosts'
import { Icon } from '../components/Icon'
import { ProjectSandboxCard } from '../components/Sandboxes'
import { Button } from '../components/ui'
import { api, type CatalogEntry, fmt, type McpEntry, type ProjectHost } from '../lib/api'
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
    const agents = useAsync(() => api.list('agents'), [])
    const workspaces = status.data?.workspaces ?? []
    // The roles (agent files with a provider) that would run on the subscription in a project allowing no provider.
    const roles = (agents.data ?? [])
        .filter((a) => typeof a.frontmatter.provider === 'string' && a.frontmatter.provider.trim())
        .map((a) => a.name)

    return (
        <Editor
            kind='projects'
            title='Projects'
            sub='Knowledge base: one file per repository — its repository, workflow, hosts and notes for the agent. Files in data/config/projects/.'
            defaults={{
                repo: '',
                skill: 'feature-to-pr',
                hosts: []
            }}
            template={TEMPLATE}
            bodyLabel='Notes for the agent'
            bodyHint='Markdown: conventions, checks, tracker, deploys'
            describe={(e) => str(e.frontmatter.repo).replace(/^https?:\/\/(www\.)?github\.com\//, '')}
            intro='A project file tells the agent which repository it is, how work becomes a PR, what to run and which hosts it touches. Pick one from the list to edit it, or describe a new one.'
            newLabel='New project'
            aside={(entry) => <ProjectSandboxCard slug={entry.name} />}
            form={(fm, set, entry) => {
                const hosts = (Array.isArray(fm.hosts) ? fm.hosts : []).filter(
                    (h): h is ProjectHost => Boolean(h) && typeof h === 'object'
                )
                return (
                    <>
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
                            hint='Turns a request into a PR.'
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
                        <McpField
                            slug={str(fm.slug)}
                            allowed={Array.isArray(fm.mcp) ? (fm.mcp as string[]) : null}
                            declared={mcp.data?.projects.find((p) => p.slug === str(fm.slug))?.servers ?? []}
                            registry={mcp.data?.servers ?? []}
                            onChange={(next) => set({ mcp: next })}
                        />
                        <NetworkField
                            value={Array.isArray(fm.network) ? (fm.network as unknown[]).map(String) : []}
                            onChange={(next) => set({ network: next.length ? next : undefined })}
                        />
                        <ProjectHosts
                            value={hosts}
                            onChange={(next) => set({ hosts: next })}
                            shared={sharedHosts.data}
                            onSharedChanged={sharedHosts.reload}
                            keys={keys.data}
                        />
                        <MoreDetails
                            key={entry?.name ?? 'new'}
                            initiallyOpen={Boolean(str(fm.path)) && !str(fm.path).endsWith(`/${str(fm.slug)}`)}
                        >
                            <div className='form-grid'>
                                <Field
                                    label='Checkout'
                                    hint='only if the folder is named otherwise'
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
                                {(providers.data?.providers.length ?? 0) > 0 && (
                                    <Field
                                        label='Delegate to providers'
                                        hint={
                                            roles.length > 0 &&
                                            !(Array.isArray(fm.providers) && fm.providers.length > 0) ? (
                                                <span
                                                    title={`${roles.join(', ')} ${roles.length === 1 ? 'runs' : 'run'} on the subscription here; tick a provider to let roles run there.`}
                                                >
                                                    {`${fmt.plural(roles.length, 'role')} on the subscription here`}
                                                </span>
                                            ) : (
                                                <span title='Roles with a provider may run there for this project; unticked = on the subscription.'>
                                                    unticked = on the subscription
                                                </span>
                                            )
                                        }
                                        wide
                                        group
                                    >
                                        <div
                                            className='row wrap'
                                            style={{ gap: 6 }}
                                        >
                                            {providers.data!.providers.map((p) => {
                                                const allowed = Array.isArray(fm.providers)
                                                    ? (fm.providers as string[])
                                                    : []
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
                            </div>
                        </MoreDetails>
                    </>
                )
            }}
        />
    )
}

/** A host as the sandbox's policy takes it: `host`, `host:port`, `*.domain`, an address. */
const RESOURCE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i

/**
 * What the project's sandbox may reach besides the registries, GitHub and the AI services its
 * policy already opens: one host per chip (`network:` in the file). The project's SSH hosts and
 * its routines' Trac sites are opened without being listed here.
 */
function NetworkField({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
    const [draft, setDraft] = useState('')
    const entry = draft.trim().toLowerCase()
    const valid = RESOURCE.test(entry) && !value.includes(entry)
    const add = () => {
        if (!valid) return
        onChange([...value, entry])
        setDraft('')
    }
    return (
        <Field
            label='Network'
            section
            hint='Hosts the sandbox may reach besides registries and GitHub; its SSH hosts are open already.'
            wide
            group
        >
            <div className='stack'>
                {value.length > 0 && (
                    <div className='row wrap'>
                        {value.map((host) => (
                            <span
                                key={host}
                                className='badge plain mono'
                            >
                                {host}
                                <Button
                                    size='sm'
                                    variant='ghost'
                                    className='chip-x'
                                    aria-label={`Remove ${host}`}
                                    onClick={() => onChange(value.filter((h) => h !== host))}
                                >
                                    <Icon
                                        name='close'
                                        size={11}
                                    />
                                </Button>
                            </span>
                        ))}
                    </div>
                )}
                <div className='row'>
                    <input
                        className='mono'
                        value={draft}
                        aria-label='Host to allow'
                        placeholder='trac.example.com, *.example.com, 10.0.0.5:22'
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                add()
                            }
                        }}
                    />
                    <Button
                        disabled={!valid}
                        onClick={add}
                    >
                        Add
                    </Button>
                </div>
            </div>
        </Field>
    )
}

/**
 * "More" opens by itself when the project's file uses it (a checkout not named like the project),
 * decided once per project: the field inside must not fold it away while it is typed in.
 */
function MoreDetails({ initiallyOpen, children }: { initiallyOpen: boolean; children: ReactNode }) {
    const [open, setOpen] = useState(initiallyOpen)
    return (
        <details
            className='field wide more'
            open={open}
            onToggle={(e) => setOpen(e.currentTarget.open)}
        >
            <summary>
                More<span className='dim'> · checkout folder, delegation to providers</span>
            </summary>
            {children}
        </details>
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
            section
            hint={
                declared.length
                    ? "From the checkout's .mcp.json; sessions load the ones switched on. Sign in under Settings → MCP."
                    : 'No .mcp.json in the checkout; connectors and Settings → MCP still apply.'
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
