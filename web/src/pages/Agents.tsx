import { Link, useNavigate, useParams } from 'react-router-dom'

import { AgentStatus, auditLink, rosterOf } from '../components/AgentsPanel'
import { Editor, Field, str } from '../components/Editor'
import { Tile } from '../components/Tile'
import { Empty, ErrorBox, PageHead } from '../components/ui'
import { api, fmt } from '../lib/api'
import { useAsync } from '../lib/useAsync'

/** What the agent frontmatter accepts besides a model id: the CLI's aliases. */
const ALIASES: Array<{ value: string; label: string }> = [
    { value: '', label: 'CLI default' },
    { value: 'inherit', label: 'inherit — same model as the orchestrator' },
    { value: 'sonnet', label: 'sonnet — current Sonnet' },
    { value: 'opus', label: 'opus — current Opus' },
    { value: 'haiku', label: 'haiku — current Haiku' }
]

const TEMPLATE = `You are the <role> of a personal software factory.

Input you get: …

How you work:

1. …
2. …

Report back in a few lines. No tool logs.
`

/** The roster as cards; editing opens the shared file editor. */
export function AgentsPage() {
    const { name } = useParams()
    if (name) return <AgentEditor />
    return <AgentGrid />
}

function AgentGrid() {
    const navigate = useNavigate()
    const entries = useAsync(() => api.list('agents'), [], 30_000)
    const activity = useAsync(() => api.agentActivity('7d'), [], 5_000)
    const rows = rosterOf(entries.data, activity.data).filter((r) => r.name !== 'orchestrator')

    return (
        <div className="page">
            <PageHead title="Agents" sub="Claude Code sub-agents: roles with their own tools, model and system prompt. Files in data/claude/agents/; built-ins appear once the audit log has seen them.">
                <button className="primary" onClick={() => navigate('/agents/new')}>
                    New agent
                </button>
            </PageHead>
            <ErrorBox error={entries.error ?? activity.error} />
            {rows.length === 0 && !entries.loading && (
                <div className="card">
                    <Empty>No agents yet. Create one, or install a preset.</Empty>
                </div>
            )}
            <div className="agent-grid">
                {rows.map((r) => {
                    const tools = str(r.entry?.frontmatter.tools)
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean)
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
                                        <span>{r.activity.runs} run{r.activity.runs === 1 ? '' : 's'} in 7 days</span>
                                        <span>{fmt.tokens(r.activity.tokens)} tokens</span>
                                        <span>last {fmt.ago(r.activity.last_active)}</span>
                                    </>
                                ) : (
                                    <span>no runs in the last 7 days</span>
                                )}
                            </div>
                            <div className="agent-card-foot">
                                <div className="row wrap" title={tools.join(', ')}>
                                    {tools.length > 0 ? (
                                        <>
                                            {tools.slice(0, 4).map((t) => (
                                                <span key={t} className="badge plain">
                                                    {t}
                                                </span>
                                            ))}
                                            {tools.length > 4 && <span className="badge plain">+{tools.length - 4}</span>}
                                        </>
                                    ) : (
                                        <span className="badge plain">{r.builtin ? 'built-in tools' : 'all tools'}</span>
                                    )}
                                </div>
                                <div className="row">
                                    <Link className="btn sm" to={auditLink(r.name)}>
                                        Audit log
                                    </Link>
                                    {r.entry && (
                                        <Link className="btn sm" to={`/agents/${r.name}`}>
                                            Edit
                                        </Link>
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

const splitTools = (value: string) =>
    value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

/**
 * `tools:` is an allowlist of Claude Code tool names, not free text. Known
 * tools are toggles; anything else (MCP tools like mcp__github__get_issue)
 * goes in the extra field. Nothing selected = inherit every tool.
 */
function ToolPicker({
    value,
    common,
    reported,
    source,
    onChange
}: {
    value: string
    common: string[]
    reported: string[]
    source: 'cli' | 'default'
    onChange: (next: string) => void
}) {
    const selected = splitTools(value)
    const known = [...common, ...reported]
    const extra = selected.filter((t) => !known.includes(t))
    const toggle = (tool: string) => {
        const next = selected.includes(tool) ? selected.filter((t) => t !== tool) : [...selected, tool]
        onChange(next.join(', '))
    }
    const chip = (tool: string) => (
        <button key={tool} type="button" className={`chip${selected.includes(tool) ? ' on' : ''}`} onClick={() => toggle(tool)}>
            {tool}
        </button>
    )
    return (
        <div className="tool-picker">
            <div className="row wrap" style={{ gap: 6 }}>
                {common.map(chip)}
            </div>
            {reported.length > 0 && (
                <details className="tool-more">
                    <summary className="dim">
                        {reported.filter((t) => selected.includes(t)).length > 0
                            ? `More tools the CLI reports (${reported.length}, ${reported.filter((t) => selected.includes(t)).length} selected)`
                            : `More tools the CLI reports (${reported.length})`}
                    </summary>
                    <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                        {reported.map(chip)}
                    </div>
                </details>
            )}
            <input
                className="mono"
                value={extra.join(', ')}
                placeholder="MCP tools, comma separated — e.g. mcp__github__get_issue"
                onChange={(e) => onChange([...selected.filter((t) => known.includes(t)), ...splitTools(e.target.value)].join(', '))}
            />
            <span className="dim">
                {selected.length ? `${selected.length} allowed: ${selected.join(', ')}` : 'None selected — the agent inherits every tool.'}
                {source === 'default' ? ' · The CLI reports its full list after the first task.' : ''}
            </span>
        </div>
    )
}

function AgentEditor() {
    const models = useAsync(() => api.models(), [])
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
                const known = ALIASES.some((a) => a.value === model) || (models.data ?? []).some((m) => m.id === model)
                return (
                    <>
                        <Field label="Model" hint={models.data?.length ? 'Aliases follow the CLI; ids are what the subscription can use right now.' : 'Aliases only — the model list could not be fetched.'}>
                            <select value={model} onChange={(e) => set({ model: e.target.value })}>
                                <optgroup label="Aliases">
                                    {ALIASES.map((a) => (
                                        <option key={a.value} value={a.value}>
                                            {a.label}
                                        </option>
                                    ))}
                                </optgroup>
                                {models.data && models.data.length > 0 && (
                                    <optgroup label="Models on this subscription">
                                        {models.data.map((m) => (
                                            <option key={m.id} value={m.id}>
                                                {m.display_name} — {m.id}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {!known && model && <option value={model}>{model}</option>}
                            </select>
                        </Field>
                        <Field label="Description — when the dispatcher should use this agent" hint="Claude Code matches tasks to agents by this text. Be specific." wide>
                            <input value={str(fm.description)} onChange={(e) => set({ description: e.target.value })} />
                        </Field>
                        <Field label="Tools the agent may use" hint="An allowlist of Claude Code tool names. Read-only agents: Read, Bash, Grep, Glob." wide>
                            <ToolPicker value={str(fm.tools)} common={tools.data?.common ?? []} reported={tools.data?.reported ?? []} source={tools.data?.source ?? 'default'} onChange={(next) => set({ tools: next })} />
                        </Field>
                    </>
                )
            }}
        />
    )
}
