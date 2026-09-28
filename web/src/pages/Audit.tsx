import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { summarizeInput } from '../components/EventFeed'
import { LoadMore } from '../components/LoadMore'
import { ErrorBox, PageHead } from '../components/ui'
import { api, type AuditEvent, type AuditKind, type AuditPeriod, fmt } from '../lib/api'
import { useAsync } from '../lib/useAsync'

const PERIODS: Array<{ value: AuditPeriod; label: string }> = [
    { value: '1h', label: 'Last hour' },
    { value: '24h', label: 'Last 24 hours' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
    { value: 'all', label: 'All time' }
]

const KINDS: Array<{ value: AuditKind; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'llm', label: 'LLM' },
    { value: 'tools', label: 'Tools' },
    { value: 'files', label: 'Files' },
    { value: 'agents', label: 'Agents' },
    { value: 'sessions', label: 'Sessions' },
    { value: 'limits', label: 'Limits' }
]

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Badge label and colour, then the one-line description, for each event. */
function describe(e: AuditEvent): { badge: string; tone: string; text: string } {
    const p = e.payload
    switch (e.type) {
        case 'llm':
            return { badge: 'LLM', tone: 'amber', text: `${String(p.model ?? 'model')} (${fmt.tokens(Number(p.tokens ?? 0))} tokens)` }
        case 'tool_use': {
            const name = String(p.name ?? 'tool')
            const command = typeof (p.input as Record<string, unknown> | undefined)?.command === 'string' ? String((p.input as Record<string, unknown>).command) : ''
            if (FILE_TOOLS.has(name)) return { badge: 'FILE', tone: 'purple', text: `${name} ${summarizeInput(p.input)}` }
            if (name === 'Bash' && /\bgit (commit|push)\b/.test(command)) return { badge: 'GIT', tone: 'purple', text: command.slice(0, 200) }
            return { badge: 'TOOL', tone: 'blue', text: `${name} ${summarizeInput(p.input)}` }
        }
        case 'agent': {
            const who = e.agent ?? 'sub-agent'
            if (p.phase === 'started') return { badge: 'AGENT', tone: 'teal', text: `Sub-agent ${who} started: ${String(p.description ?? '')}` }
            const stats = [p.durationMs !== undefined && fmt.duration(Number(p.durationMs)), p.tokens !== undefined && `${fmt.tokens(Number(p.tokens))} tokens`, p.toolUses !== undefined && `${Number(p.toolUses)} tool calls`].filter(Boolean).join(' · ')
            return { badge: 'AGENT', tone: p.phase === 'failed' ? 'red' : 'teal', text: `Sub-agent ${who} ${String(p.phase)}${stats ? ` (${stats})` : ''}` }
        }
        case 'status': {
            const status = String(p.status)
            if (status === 'running') return { badge: 'SESSION', tone: 'gray', text: 'Task started' }
            const stats = [`${Number(p.num_turns ?? 0)} turns`, `${fmt.tokens(Number(p.tokens ?? 0))} tokens`, fmt.duration(Number(p.duration_ms ?? 0))].join(' · ')
            return { badge: 'SESSION', tone: status === 'done' ? 'green' : 'gray', text: `Task ${status === 'done' ? 'completed' : status} (${stats})` }
        }
        case 'error':
            return { badge: 'ERROR', tone: 'red', text: String(p.error ?? p.status ?? 'failed').slice(0, 200) }
        case 'limits': {
            const five = p.five_hour as { used: number } | null
            const week = p.seven_day as { used: number } | null
            const parts = [five && `5h ${fmt.pct(five.used)}`, week && `week ${fmt.pct(week.used)}`].filter(Boolean).join(' · ')
            return { badge: 'LIMITS', tone: p.status === 'allowed' ? 'green' : 'amber', text: `Subscription windows: ${parts}${p.status !== 'allowed' ? ` · ${String(p.status)}` : ''}` }
        }
        default:
            return { badge: String(e.type).toUpperCase(), tone: 'gray', text: JSON.stringify(p).slice(0, 200) }
    }
}

function clock(iso: string): { time: string; day: string | null } {
    const d = new Date(iso)
    const time = d.toLocaleTimeString([], { hour12: false })
    const today = new Date().toDateString() === d.toDateString()
    return { time, day: today ? null : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) }
}

export function AuditPage() {
    // Filters live in the URL so that links from Overview and Agents can preset them.
    const [params, setParams] = useSearchParams()
    const period = (params.get('period') as AuditPeriod | null) ?? '24h'
    const kind = (params.get('kind') as AuditKind | null) ?? 'all'
    const agent = params.get('agent') ?? ''
    const project = params.get('project') ?? ''
    const setParam = (key: string, fallback: string) => (value: string) =>
        setParams(
            (prev) => {
                const next = new URLSearchParams(prev)
                if (value && value !== fallback) next.set(key, value)
                else next.delete(key)
                return next
            },
            { replace: true }
        )
    const setPeriod = setParam('period', '24h')
    const setKind = setParam('kind', 'all')
    const setAgent = setParam('agent', '')
    const setProject = setParam('project', '')
    const [open, setOpen] = useState<number | null>(null)
    const [more, setMore] = useState<AuditEvent[]>([])
    const [loadingMore, setLoadingMore] = useState(false)

    const audit = useAsync(() => api.audit({ period, kind, agent, project }), [period, kind, agent, project], 10_000)
    const d = audit.data
    const events = [...(d?.events ?? []), ...more]
    const last = events.at(-1)

    const loadMore = async () => {
        if (!last) return
        setLoadingMore(true)
        try {
            const page = await api.audit({ period, kind, agent, project, before: last.id })
            setMore((prev) => [...prev, ...page.events])
        } finally {
            setLoadingMore(false)
        }
    }
    const reset = (set: (v: string) => void) => (v: string) => {
        set(v)
        setMore([])
        setOpen(null)
    }

    return (
        <div className="page">
            <PageHead title="Audit log" sub="Every model call, tool call and sub-agent, attributed to the agent that did it and the project it worked in.">
                <select value={period} onChange={(e) => reset(setPeriod)(e.target.value)} style={{ width: 170 }}>
                    {PERIODS.map((p) => (
                        <option key={p.value} value={p.value}>
                            {p.label}
                        </option>
                    ))}
                </select>
            </PageHead>
            <ErrorBox error={audit.error} />

            <div className="card pad0">
                <div className="stat-row">
                    <Stat label="Events" value={d ? d.stats.events.toLocaleString() : '…'} />
                    <Stat label="Agents" value={d ? d.stats.agents : '…'} />
                    <Stat label="Tasks" value={d ? d.stats.tasks : '…'} />
                    <Stat label="Tokens" value={d ? fmt.tokens(d.stats.tokens) : '…'} />
                </div>
                <div className="audit-bar">
                    <div className="tabs">
                        {KINDS.map((k) => (
                            <button key={k.value} className={kind === k.value ? 'active' : ''} onClick={() => reset(setKind)(k.value)}>
                                {k.label}
                            </button>
                        ))}
                    </div>
                    <div className="row">
                        <select value={agent} onChange={(e) => reset(setAgent)(e.target.value)} style={{ width: 160 }}>
                            <option value="">all agents</option>
                            <option value="orchestrator">orchestrator</option>
                            {agent && agent !== 'orchestrator' && !d?.facets.agents.includes(agent) && <option value={agent}>{agent}</option>}
                            {d?.facets.agents.map((a) => (
                                <option key={a} value={a}>
                                    {a}
                                </option>
                            ))}
                        </select>
                        <select value={project} onChange={(e) => reset(setProject)(e.target.value)} style={{ width: 180 }}>
                            <option value="">all projects</option>
                            {project && !d?.facets.projects.includes(project) && <option value={project}>{project}</option>}
                            {d?.facets.projects.map((p) => (
                                <option key={p} value={p}>
                                    {p}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
                {events.length ? (
                    <div className="audit">
                        {events.map((e) => {
                            const { badge, tone, text } = describe(e)
                            const { time, day } = clock(e.ts)
                            const expanded = open === e.id
                            return (
                                <div key={e.id} className={`audit-row${expanded ? ' open' : ''}`}>
                                    <div className="audit-line" onClick={() => setOpen(expanded ? null : e.id)}>
                                        <span className="audit-time dim">
                                            {day && <span className="audit-day">{day} </span>}
                                            {time}
                                        </span>
                                        <span className={`badge plain ${tone} audit-badge`}>{badge}</span>
                                        <span className="audit-text">{text}</span>
                                        <span className="audit-meta">
                                            {e.project && <span className="badge plain">{e.project}</span>}
                                            <span className={`audit-agent${e.agent ? '' : ' dim'}`}>{e.agent ?? 'orchestrator'}</span>
                                        </span>
                                    </div>
                                    {expanded && (
                                        <div className="audit-detail">
                                            <div className="row wrap small dim" style={{ marginBottom: 6 }}>
                                                <span>{fmt.when(e.ts)}</span>
                                                <Link to={`/tasks/${e.task_id}`}>task {e.task_id.slice(0, 8)}</Link>
                                                <Link to={`/chat/${e.conversation_id}`}>conversation</Link>
                                                {e.session_id && <Link to={`/sessions/${e.session_id}`}>transcript</Link>}
                                                {e.parent_tool_use_id && <span>spawned by {e.parent_tool_use_id.slice(0, 14)}</span>}
                                            </div>
                                            <pre style={{ margin: 0, maxHeight: 360 }}>{JSON.stringify(e.payload, null, 2)}</pre>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                ) : (
                    <div className="empty">{audit.loading ? 'Loading…' : 'No events in this period.'}</div>
                )}
                <LoadMore hasMore={Boolean(d && d.stats.events > events.length)} loading={loadingMore} onMore={loadMore} shown={events.length} total={d?.stats.events} noun="events" />
            </div>
        </div>
    )
}

function Stat({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="stat">
            <div className="label">{label}</div>
            <div className="value" style={{ fontSize: 18 }}>
                {value}
            </div>
        </div>
    )
}
