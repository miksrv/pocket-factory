import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { AgentStatus, auditLink, rosterOf } from '../components/AgentsPanel'
import { Editor, Field, str } from '../components/Editor'
import { Tile } from '../components/Tile'
import { Button, Empty, ErrorBox, GrowingTextarea, PageHead } from '../components/ui'
import { api, fmt, type ToolList } from '../lib/api'
import { useAsync } from '../lib/useAsync'

/**
 * What `model:` in an agent file accepts: the CLI's aliases, which Claude
 * Code resolves to the subscription's current model of that tier (so a file
 * follows model releases by itself), or a full model id typed by hand. The
 * list is deliberately static: finding out what an alias means today would
 * cost either an API call with the owner's token or a turn per alias.
 */
const ALIASES: Array<{ value: string; label: string }> = [
    { value: '', label: 'CLI default' },
    { value: 'inherit', label: 'inherit — same model as the orchestrator' },
    { value: 'sonnet', label: 'sonnet — current Sonnet' },
    { value: 'opus', label: 'opus — current Opus' },
    { value: 'haiku', label: 'haiku — current Haiku' },
    { value: 'fable', label: 'fable — current Fable (Max plans)' }
]

const splitTools = (value: string) =>
    value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

const TEMPLATE = `You are the <role> of a personal software factory.

Input you get: …

How you work:

1. …
2. …

Report back in a few lines. No tool logs.
`

/** The roster as cards; editing opens the shared file editor. */
/** The MCP servers an allowlist reaches: one entry per server, with how many of its tools are on the list (partial when not all). */
function mcpServersOf(allowed: string[], known: ToolList['mcp']): Array<{ key: string; label: string; selected: number; total: number; partial: boolean }> {
    const byServer = new Map<string, number>()
    for (const tool of allowed) {
        const match = /^mcp__(.+?)__/.exec(tool)
        if (match) byServer.set(match[1], (byServer.get(match[1]) ?? 0) + 1)
    }
    return [...byServer].map(([key, selected]) => {
        const server = known.find((m) => m.server === key)
        const total = server?.tools.length ?? selected
        return { key, label: server?.label ?? key.replace(/^claude_ai_/, 'claude.ai ').replace(/_/g, ' '), selected, total, partial: selected < total }
    })
}

export function AgentsPage() {
    const { name } = useParams()
    if (name) return <AgentEditor />
    return <AgentGrid />
}

function AgentGrid() {
    const navigate = useNavigate()
    const entries = useAsync(() => api.list('agents'), [], 30_000)
    const activity = useAsync(() => api.agentActivity('7d'), [], 5_000)
    const known = useAsync(() => api.tools(), [])
    const rows = rosterOf(entries.data, activity.data)
        .filter((r) => r.name !== 'orchestrator')
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    return (
        <div className="page">
            <PageHead title="Agents" sub="Claude Code sub-agents: roles with their own tools, model and system prompt. Files in data/claude/agents/; built-ins appear once the audit log has seen them.">
                <Button variant="primary" onClick={() => navigate('/agents/new')}>
                    New agent
                </Button>
            </PageHead>
            <ErrorBox error={entries.error ?? activity.error} />
            {rows.length === 0 && !entries.loading && (
                <div className="card">
                    <Empty>No agents yet. Create one, or install a preset.</Empty>
                </div>
            )}
            <div className="agent-grid">
                {rows.map((r) => {
                    const allowed = splitTools(str(r.entry?.frontmatter.tools))
                    const tools = allowed.filter((t) => !t.startsWith('mcp__'))
                    const servers = mcpServersOf(allowed, known.data?.mcp ?? [])
                    const model = str(r.entry?.frontmatter.model)
                    return (
                        <div key={r.name} className="card agent-card">
                            <div className="agent-card-head">
                                <Tile name={r.name} kind="agents" large />
                                <div className="grow">
                                    <div className="agent-name">{r.name}</div>
                                    <div className="dim small">{r.builtin ? 'built-in' : model ? `model ${model}` : 'CLI default model'}</div>
                                </div>
                                <AgentStatus activity={r.activity} />
                            </div>
                            <p className="agent-desc">{r.description || <span className="dim">No description — the orchestrator picks agents by it.</span>}</p>
                            <div className="agent-stats dim small">
                                {r.activity ? (
                                    <>
                                        <span>{fmt.plural(r.activity.runs, 'run')} in 7 days</span>
                                        <span>{fmt.tokens(r.activity.tokens)} tokens</span>
                                        <span>last {fmt.ago(r.activity.last_active)}</span>
                                    </>
                                ) : (
                                    <span>no runs in the last 7 days</span>
                                )}
                            </div>
                            <div className="agent-card-foot">
                                <div className="row wrap" title={allowed.join(', ')}>
                                    {allowed.length > 0 ? (
                                        <>
                                            {tools.slice(0, 4).map((t) => (
                                                <span key={t} className="badge plain">
                                                    {t}
                                                </span>
                                            ))}
                                            {tools.length > 4 && <span className="badge plain">+{tools.length - 4}</span>}
                                            {servers.map((m) => (
                                                <span key={m.key} className="badge plain sky" title={m.partial ? `${m.selected} of ${m.total} tools of ${m.label}` : `every tool of ${m.label}`}>
                                                    {m.label}
                                                    {m.partial ? ` ${m.selected}/${m.total}` : ''}
                                                </span>
                                            ))}
                                        </>
                                    ) : (
                                        <span className="badge plain">{r.builtin ? 'built-in tools' : 'all tools'}</span>
                                    )}
                                </div>
                                <div className="row">
                                    <Button size="sm" to={auditLink(r.name)}>
                                        Audit log
                                    </Button>
                                    {r.entry && (
                                        <Button size="sm" to={`/agents/${r.name}`}>
                                            Edit
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

/**
 * `tools:` is an allowlist of Claude Code tool names, not free text. Known
 * tools are toggles; MCP tools come grouped by server — the servers the
 * sessions have seen: claude.ai connectors, project servers, the owner's own —
 * with a whole-server box or single tools; anything else goes in the extra
 * field. Nothing selected = inherit every tool.
 */
function ToolPicker({ value, tools, onChange }: { value: string; tools: ToolList | undefined; onChange: (next: string) => void }) {
    const common = tools?.common ?? []
    const reported = tools?.reported ?? []
    const mcp = tools?.mcp ?? []
    const selected = splitTools(value)
    const known = [...common, ...reported, ...mcp.flatMap((m) => m.tools)]
    const extra = selected.filter((t) => !known.includes(t))
    // The field keeps what was typed (", " included) until it parses to something else.
    const [extraText, setExtraText] = useState(extra.join(', '))
    const shownExtra = splitTools(extraText).join(',') === extra.join(',') ? extraText : extra.join(', ')
    const toggle = (tool: string) => {
        const next = selected.includes(tool) ? selected.filter((t) => t !== tool) : [...selected, tool]
        onChange(next.join(', '))
    }
    const setMany = (names: string[], on: boolean) => {
        const next = on ? [...selected, ...names.filter((n) => !selected.includes(n))] : selected.filter((t) => !names.includes(t))
        onChange(next.join(', '))
    }
    const chip = (tool: string, text = tool) => (
        <Button key={tool} className={`chip${selected.includes(tool) ? ' on' : ''}`} onClick={() => toggle(tool)} aria-pressed={selected.includes(tool)} title={tool}>
            {text}
        </Button>
    )
    return (
        <div className="tool-picker">
            <div className="row wrap" style={{ gap: 6 }}>
                {common.map((t) => chip(t))}
            </div>
            {reported.length > 0 && (
                <details className="tool-more">
                    <summary className="dim">
                        {reported.filter((t) => selected.includes(t)).length > 0
                            ? `More tools the CLI reports (${reported.length}, ${reported.filter((t) => selected.includes(t)).length} selected)`
                            : `More tools the CLI reports (${reported.length})`}
                    </summary>
                    <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                        {reported.map((t) => chip(t))}
                    </div>
                </details>
            )}
            {mcp.length > 0 && (
                <div className="mcp-servers">
                    <div className="dim">MCP servers the sessions have seen — a whole server, or single tools:</div>
                    {mcp.map((m) => (
                        <McpServerRow key={m.server} server={m} selected={selected} onAll={(on) => setMany(m.tools, on)} chip={chip} />
                    ))}
                </div>
            )}
            <input
                className="mono"
                value={shownExtra}
                placeholder="Other tools, comma separated — e.g. mcp__github__get_issue for a server not seen yet"
                onChange={(e) => {
                    setExtraText(e.target.value)
                    onChange([...selected.filter((t) => known.includes(t)), ...splitTools(e.target.value)].join(', '))
                }}
            />
            <span className="dim">
                {selected.length ? `${selected.length} allowed: ${selected.join(', ')}` : 'None selected — the agent inherits every tool.'}
                {tools?.source === 'default' ? ' · The CLI reports its full list after the first task.' : ''}
            </span>
        </div>
    )
}

/** One MCP server: a box for all of its tools (indeterminate when some are on) and the tools themselves behind a fold. */
function McpServerRow({ server, selected, onAll, chip }: { server: ToolList['mcp'][number]; selected: string[]; onAll: (on: boolean) => void; chip: (tool: string, text?: string) => ReactNode }) {
    const on = server.tools.filter((t) => selected.includes(t)).length
    const all = on === server.tools.length
    const box = useRef<HTMLInputElement>(null)
    useEffect(() => {
        if (box.current) box.current.indeterminate = on > 0 && !all
    }, [on, all])
    const short = (tool: string) => tool.slice(`mcp__${server.server}__`.length)
    const usable = server.tools.length > 0
    const tone = server.status === 'connected' ? 'done' : server.status === 'needs-auth' ? 'queued' : server.status === 'failed' ? 'failed' : 'cancelled'
    return (
        <details className="mcp-server" open={on > 0 && !all}>
            <summary>
                <label className="row" onClick={(e) => e.stopPropagation()}>
                    <input ref={box} type="checkbox" checked={all && usable} disabled={!usable} onChange={(e) => onAll(e.target.checked)} />
                    <span className="grow">
                        <strong>{server.label}</strong>{' '}
                        <span className="dim">· {!usable ? 'no tools until it is authorized' : all ? `all ${server.tools.length} tools` : on ? `${on} of ${server.tools.length} tools` : `${server.tools.length} tools`}</span>
                    </span>
                    <span className={`badge ${tone}`}>{server.status === 'needs-auth' ? 'needs authentication' : server.status}</span>
                </label>
            </summary>
            <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                {server.tools.map((t) => chip(t, short(t)))}
            </div>
        </details>
    )
}

function AgentEditor() {
    const tools = useAsync(() => api.tools(), [])
    return (
        <Editor
            kind="agents"
            title="Agents"
            sub="Claude Code sub-agents: roles with their own tools, model and system prompt. Files in data/claude/agents/."
            defaults={{ description: '', tools: 'Read, Edit, Write, Bash, Grep, Glob', model: 'sonnet' }}
            template={TEMPLATE}
            bodyLabel="System prompt (Markdown)"
            backTo={{ to: '/agents', label: 'All agents' }}
            form={(fm, set) => {
                const model = str(fm.model)
                const known = ALIASES.some((a) => a.value === model)
                return (
                    <>
                        <Field label="Model" hint="An alias follows the CLI to the current model of that tier; a full id (claude-sonnet-5-5) pins one — type it in the file.">
                            <select value={model} onChange={(e) => set({ model: e.target.value })}>
                                {ALIASES.map((a) => (
                                    <option key={a.value} value={a.value}>
                                        {a.label}
                                    </option>
                                ))}
                                {!known && model && <option value={model}>{model}</option>}
                            </select>
                        </Field>
                        <Field label="Description — when the dispatcher should use this agent" hint="Claude Code matches tasks to agents by this text. Be specific." wide>
                            <GrowingTextarea value={str(fm.description)} onChange={(e) => set({ description: e.target.value })} />
                        </Field>
                        <Field label="Tools the agent may use" hint="An allowlist of Claude Code tool names. Read-only agents: Read, Bash, Grep, Glob. MCP servers are the ones the factory is connected to (claude.ai connectors, the project's .mcp.json, Settings → MCP); pick a server to make this a role for it, or only some of its tools (the email assistant has Gmail without send)." wide>
                            <ToolPicker value={str(fm.tools)} tools={tools.data} onChange={(next) => set({ tools: next })} />
                        </Field>
                    </>
                )
            }}
        />
    )
}
