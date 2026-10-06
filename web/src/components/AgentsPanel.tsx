import { Link } from 'react-router-dom'

import { type AgentActivity, api, type CatalogEntry, fmt } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Tile } from './Tile'

export interface AgentRow {
    /** Agent name; 'orchestrator' for the main Claude Code process. */
    name: string
    description: string
    builtin: boolean
    activity: AgentActivity | undefined
    entry: CatalogEntry | undefined
}

/**
 * The factory's roster: the orchestrator, every agent file, and any other
 * sub-agent type the audit log saw in the period (Claude Code's built-ins).
 */
export function rosterOf(
    entries: CatalogEntry[] | undefined,
    activity: AgentActivity[] | undefined,
    queued = 0
): AgentRow[] {
    const byName = new Map((activity ?? []).map((a) => [a.agent ?? 'orchestrator', a]))
    const rows: AgentRow[] = [
        {
            name: 'orchestrator',
            description:
                queued > 0 ? `Claude Code itself · ${queued} queued` : 'Claude Code itself: plans, delegates, reports',
            builtin: true,
            activity: byName.get('orchestrator'),
            entry: undefined
        }
    ]
    for (const entry of entries ?? []) {
        rows.push({
            name: entry.name,
            description: String(entry.frontmatter.description ?? ''),
            builtin: false,
            activity: byName.get(entry.name),
            entry
        })
    }
    for (const a of activity ?? []) {
        if (a.agent && !rows.some((r) => r.name === a.agent)) {
            rows.push({
                name: a.agent,
                description:
                    'Ships with Claude Code; the orchestrator calls it through the Agent tool. Nothing to edit.',
                builtin: true,
                activity: a,
                entry: undefined
            })
        }
    }
    return rows
}

export function AgentStatus({ activity, queued }: { activity: AgentActivity | undefined; queued?: boolean }) {
    if (activity && activity.running > 0)
        return <span className='badge running'>Running{activity.running > 1 ? ` ×${activity.running}` : ''}</span>
    if (queued) return <span className='badge queued'>Queued</span>
    return <span className='badge cancelled'>Idle</span>
}

export const auditLink = (name: string, period = '7d') => `/audit?agent=${encodeURIComponent(name)}&period=${period}`

/** Overview card: who is on the team and who is working right now. `limit` keeps the panel a summary; the rest is on /agents. */
export function AgentsPanel({ limit }: { limit?: number }) {
    const entries = useAsync(() => api.list('agents'), [], 30_000)
    const activity = useAsync(() => api.agentActivity('7d'), [], 5_000)
    const status = useAsync(() => api.status(), [], 5_000)
    const queued = status.data?.stats.queued ?? 0
    const rows = rosterOf(entries.data, activity.data, queued)
    const running = rows.filter((r) => (r.activity?.running ?? 0) > 0).length
    // Working agents first, then by last activity, so a cut list shows who is doing things now.
    const last = (r: (typeof rows)[number]) =>
        r.activity?.last_active ? new Date(r.activity.last_active).getTime() : 0
    const shown = limit
        ? [...rows]
              .sort((a, b) => (b.activity?.running ?? 0) - (a.activity?.running ?? 0) || last(b) - last(a))
              .slice(0, limit)
        : rows

    return (
        <div className='card pad0'>
            <div className='card-head'>
                <span className='row'>
                    <Tile
                        icon='agents'
                        color='teal'
                        small
                    />
                    Team agents
                </span>
                <span className={`live${running > 0 ? '' : ' warn'}`}>
                    {running > 0 ? `${running} working` : 'Idle'}
                </span>
            </div>
            <div className='list'>
                {shown.map((r) => (
                    <Link
                        key={r.name}
                        to={auditLink(r.name)}
                        title='Open the audit log for this agent'
                    >
                        {r.name === 'orchestrator' ? (
                            <Tile
                                icon='control'
                                color='gray'
                            />
                        ) : (
                            <Tile
                                name={r.name}
                                kind='agents'
                            />
                        )}
                        <div className='grow'>
                            <div className='title'>
                                {r.name}
                                {r.builtin && r.name !== 'orchestrator' && (
                                    <span className='badge plain'>built-in</span>
                                )}
                            </div>
                            <div className='desc'>
                                {r.activity
                                    ? `${fmt.plural(r.activity.runs, 'run')} · ${fmt.tokens(r.activity.tokens)} tokens · last ${fmt.ago(r.activity.last_active)}`
                                    : r.description || 'no activity in 7 days'}
                            </div>
                        </div>
                        <AgentStatus
                            activity={r.activity}
                            queued={r.name === 'orchestrator' && queued > 0}
                        />
                    </Link>
                ))}
            </div>
            <div className='card-foot'>
                <span>
                    {shown.length < rows.length ? `${shown.length} of ${rows.length} agents` : `${rows.length} agents`}{' '}
                    · {running} working · last 7 days
                </span>
                <span className='row'>
                    <Link to='/agents'>Manage agents</Link>
                    <Link to='/audit?kind=agents&period=7d'>Audit log →</Link>
                </span>
            </div>
        </div>
    )
}
