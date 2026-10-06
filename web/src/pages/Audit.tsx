import { useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { summarizeInput } from '../components/EventFeed'
import { LoadMore } from '../components/LoadMore'
import { Empty, ErrorBox, FilterSelect, PageHead, Stat, Tabs } from '../components/ui'
import { api, type Audit, type AuditEvent, type AuditKind, type AuditPeriod, fmt } from '../lib/api'
import { usePaged } from '../lib/usePaged'

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
const PAGE = 200

/** Badge label and colour, then the one-line description, for each event. */
function describe(e: AuditEvent): { badge: string; tone: string; text: string } {
    const p = e.payload
    switch (e.type) {
        case 'llm':
            return {
                badge: 'LLM',
                tone: 'amber',
                text: `${String(p.model ?? 'model')} (${fmt.tokens(Number(p.tokens ?? 0))} tokens)`
            }
        case 'tool_use': {
            const name = String(p.name ?? 'tool')
            const command =
                typeof (p.input as Record<string, unknown> | undefined)?.command === 'string'
                    ? String((p.input as Record<string, unknown>).command)
                    : ''
            if (FILE_TOOLS.has(name))
                return { badge: 'FILE', tone: 'purple', text: `${name} ${summarizeInput(p.input)}` }
            if (name === 'Bash' && /\bgit (commit|push)\b/.test(command))
                return { badge: 'GIT', tone: 'purple', text: command.slice(0, 200) }
            return { badge: 'TOOL', tone: 'blue', text: `${name} ${summarizeInput(p.input)}` }
        }
        case 'agent': {
            const who = e.agent ?? 'sub-agent'
            if (p.phase === 'started')
                return {
                    badge: 'AGENT',
                    tone: 'teal',
                    text: `Sub-agent ${who} started: ${String(p.description ?? '')}`
                }
            const stats = [
                p.durationMs !== undefined && fmt.duration(Number(p.durationMs)),
                p.tokens !== undefined && `${fmt.tokens(Number(p.tokens))} tokens`,
                p.toolUses !== undefined && `${Number(p.toolUses)} tool calls`
            ]
                .filter(Boolean)
                .join(' · ')
            return {
                badge: 'AGENT',
                tone: p.phase === 'failed' ? 'red' : 'teal',
                text: `Sub-agent ${who} ${String(p.phase)}${stats ? ` (${stats})` : ''}`
            }
        }
        case 'status': {
            const status = String(p.status)
            if (status === 'queued')
                return {
                    badge: 'SESSION',
                    tone: 'gray',
                    text: p.note ? `Task re-queued · ${String(p.note)}` : 'Task queued'
                }
            if (status === 'running')
                return {
                    badge: 'SESSION',
                    tone: 'gray',
                    text: p.note ? `Task started · ${String(p.note)}` : 'Task started'
                }
            const stats = [
                `${Number(p.num_turns ?? 0)} turns`,
                `${fmt.tokens(Number(p.tokens ?? 0))} tokens`,
                fmt.duration(Number(p.duration_ms ?? 0))
            ].join(' · ')
            return {
                badge: 'SESSION',
                tone: status === 'done' ? 'green' : 'gray',
                text: `Task ${status === 'done' ? 'completed' : status} (${stats})`
            }
        }
        case 'error':
            return { badge: 'ERROR', tone: 'red', text: String(p.error ?? p.status ?? 'failed').slice(0, 200) }
        case 'limits': {
            const five = p.five_hour as { used: number } | null
            const week = p.seven_day as { used: number } | null
            const parts = [five && `5h ${fmt.pct(five.used)}`, week && `week ${fmt.pct(week.used)}`]
                .filter(Boolean)
                .join(' · ')
            return {
                badge: 'LIMITS',
                tone: p.status === 'allowed' ? 'green' : 'amber',
                text: `Subscription windows: ${parts}${p.status !== 'allowed' ? ` · ${String(p.status)}` : ''}`
            }
        }
        case 'ask': {
            const questions = ((p.input as { questions?: Array<{ question?: string }> } | undefined)?.questions ?? [])
                .map((q) => q.question ?? '')
                .filter(Boolean)
            return p.kind === 'question'
                ? { badge: 'ASK', tone: 'amber', text: `Asked the owner: ${questions.join(' · ')}`.slice(0, 200) }
                : {
                      badge: 'ASK',
                      tone: 'amber',
                      text: `Asked permission for ${String(p.tool_name)} ${summarizeInput(p.input)}`.slice(0, 200)
                  }
        }
        case 'answer': {
            const answers = Object.values((p.answers ?? {}) as Record<string, string>)
            return p.kind === 'question'
                ? { badge: 'ANSWER', tone: 'green', text: `Owner answered: ${answers.join(' · ')}`.slice(0, 200) }
                : {
                      badge: 'ANSWER',
                      tone: p.behavior === 'allow' ? 'green' : 'red',
                      text: `Owner ${p.behavior === 'allow' ? 'allowed' : 'denied'} ${String(p.tool_name)}`
                  }
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

const isPeriod = (v: string | null): v is AuditPeriod => PERIODS.some((p) => p.value === v)
const isKind = (v: string | null): v is AuditKind => KINDS.some((k) => k.value === v)

export function AuditPage() {
    // Filters live in the URL so that links from Overview and Agents can preset them.
    const [params, setParams] = useSearchParams()
    const rawPeriod = params.get('period')
    const rawKind = params.get('kind')
    const period = isPeriod(rawPeriod) ? rawPeriod : '24h'
    const kind = isKind(rawKind) ? rawKind : 'all'
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
    // Totals and facets come with the first page; the list itself is keyset-paged by event id.
    const [summary, setSummary] = useState<Pick<Audit, 'stats' | 'facets'> | null>(null)
    const hasMoreRef = useRef(false)
    // usePaged drops a page requested under older filters, but the side effects below run
    // regardless: they apply only when the request's filters are still the current ones.
    const filters = JSON.stringify([period, kind, agent, project])
    const current = useRef(filters)
    current.current = filters
    const events = usePaged(
        (before) =>
            api.audit({ period, kind, agent, project, before: before ? Number(before.id) : undefined }).then((page) => {
                if (filters === current.current) {
                    if (!before) setSummary({ stats: page.stats, facets: page.facets })
                    hasMoreRef.current = page.has_more
                }
                return page.events
            }),
        {
            key: (e) => String(e.id),
            cursor: (e) => e.ts,
            pageSize: PAGE,
            deps: [period, kind, agent, project],
            pollMs: 10_000,
            hasMore: () => hasMoreRef.current
        }
    )
    const d = summary

    return (
        <div className='page fill'>
            <PageHead
                title='Audit log'
                sub='Every model call, tool call and sub-agent, attributed to the agent that did it and the project it worked in.'
            >
                <select
                    className='filter'
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                    aria-label='Period'
                >
                    {PERIODS.map((p) => (
                        <option
                            key={p.value}
                            value={p.value}
                        >
                            {p.label}
                        </option>
                    ))}
                </select>
            </PageHead>
            <ErrorBox error={events.error} />

            <div className='card pad0'>
                <div className='stat-row'>
                    <Stat
                        label='Events'
                        value={d ? d.stats.events.toLocaleString() : '…'}
                    />
                    <Stat
                        label='Agents'
                        value={d ? d.stats.agents : '…'}
                    />
                    <Stat
                        label='Tasks'
                        value={d ? d.stats.tasks : '…'}
                    />
                    <Stat
                        label='Tokens'
                        value={d ? fmt.tokens(d.stats.tokens) : '…'}
                    />
                </div>
                <div className='audit-bar'>
                    <Tabs
                        items={KINDS}
                        value={kind}
                        onChange={setKind}
                    />
                    <div className='row'>
                        <FilterSelect
                            label='Agent'
                            all='all agents'
                            value={agent}
                            onChange={setAgent}
                            options={['orchestrator', ...(d?.facets.agents ?? [])]}
                        />
                        <FilterSelect
                            label='Project'
                            all='all projects'
                            value={project}
                            onChange={setProject}
                            options={d?.facets.projects ?? []}
                        />
                    </div>
                </div>
                <div className='card-scroll'>
                    {events.items.length ? (
                        <div className='audit'>
                            {events.items.map((e) => {
                                const { badge, tone, text } = describe(e)
                                const { time, day } = clock(e.ts)
                                const expanded = open === e.id
                                return (
                                    <div
                                        key={e.id}
                                        className={`audit-row${expanded ? ' open' : ''}`}
                                    >
                                        <div
                                            className='audit-line'
                                            role='button'
                                            tabIndex={0}
                                            aria-expanded={expanded}
                                            onClick={() => setOpen(expanded ? null : e.id)}
                                            onKeyDown={(k) => {
                                                if (k.key === 'Enter' || k.key === ' ') {
                                                    k.preventDefault()
                                                    setOpen(expanded ? null : e.id)
                                                }
                                            }}
                                        >
                                            <span className='audit-time dim'>
                                                {day && <span className='audit-day'>{day} </span>}
                                                {time}
                                            </span>
                                            <span className={`badge plain ${tone} audit-badge`}>{badge}</span>
                                            <span className='audit-text'>{text}</span>
                                            <span className='audit-meta'>
                                                {e.project && <span className='badge plain'>{e.project}</span>}
                                                <span className={`audit-agent${e.agent ? '' : ' dim'}`}>
                                                    {e.agent ?? 'orchestrator'}
                                                </span>
                                            </span>
                                        </div>
                                        {expanded && (
                                            <div className='audit-detail'>
                                                <div
                                                    className='row wrap small dim'
                                                    style={{ marginBottom: 6 }}
                                                >
                                                    <span>{fmt.when(e.ts)}</span>
                                                    <Link to={`/tasks/${e.task_id}`}>task {e.task_id.slice(0, 8)}</Link>
                                                    <Link to={`/chat/${e.conversation_id}`}>conversation</Link>
                                                    {e.session_id && (
                                                        <Link to={`/sessions/${e.session_id}`}>transcript</Link>
                                                    )}
                                                    {e.parent_tool_use_id && (
                                                        <span>spawned by {e.parent_tool_use_id.slice(0, 14)}</span>
                                                    )}
                                                </div>
                                                <pre className='audit-payload'>
                                                    {JSON.stringify(e.payload, null, 2)}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <Empty>{events.loading ? 'Loading…' : 'No events in this period.'}</Empty>
                    )}
                    <LoadMore
                        hasMore={events.hasMore}
                        loading={events.loading}
                        onMore={events.loadMore}
                        shown={events.items.length}
                        total={d?.stats.events}
                        noun='events'
                    />
                </div>
            </div>
        </div>
    )
}
