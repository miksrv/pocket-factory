import { Link } from 'react-router-dom'

import { AgentsPanel } from '../components/AgentsPanel'
import { LimitsCard } from '../components/Limits'
import { Tile } from '../components/Tile'
import { Button, Empty, PageHead, Stat, StatusBadge } from '../components/ui'
import { api, fmt, type McpEntry, type Status, type Task, taskTokens } from '../lib/api'
import { useAsync } from '../lib/useAsync'

export function OverviewPage() {
    const status = useAsync(() => api.status(), [], 5_000)
    const tasks = useAsync(() => api.tasks({ limit: 7 }), [], 5_000)
    const agents = useAsync(() => api.list('agents'), [])
    const skills = useAsync(() => api.list('skills'), [])
    const projects = useAsync(() => api.list('projects'), [])
    const mcp = useAsync(() => api.mcp(), [], 30_000)
    const s = status.data?.stats
    const d = status.data

    return (
        <div className="page">
            <PageHead title="Overview" sub="What the factory is doing right now.">
                <Button variant="primary" to="/chat/new">New task</Button>
            </PageHead>

            <div className="card pad0">
                <div className="card-head">
                    <span className="row">
                        <Tile icon="control" color="gray" small />
                        Control plane
                    </span>
                    <span className={`live${d ? (d.claude.logged_in ? '' : ' warn') : ' off'}`}>{d ? (d.claude.logged_in ? 'Live' : 'Not logged in') : 'Offline'}</span>
                </div>
                <div className="stat-row">
                    <Stat label="Queued" value={s?.queued ?? '…'} />
                    <Stat label="Running" value={s?.running ?? '…'} />
                    <Stat label="Done today" value={s?.done_today ?? '…'} />
                    <Stat label="Failed today" value={s?.failed_today ?? '…'} />
                    <Stat label="Tokens today" value={s ? fmt.tokens(s.tokens_today) : '…'} />
                    <Stat label="Tokens total" value={s ? fmt.tokens(s.tokens_total) : '…'} />
                </div>
                <div className="stat-row">
                    <Stat label="Agents" value={agents.data?.length ?? '…'} to="/agents" />
                    <Stat label="Skills" value={skills.data?.length ?? '…'} to="/skills" />
                    <Stat label="Projects" value={projects.data?.length ?? '…'} to="/projects" />
                    <Stat label="Workspaces" value={d?.workspaces.length ?? '…'} to="/settings" />
                    <Stat label="Model" value={d?.claude.model ?? '…'} />
                    <Stat label="Max sessions" value={d?.max_concurrent_sessions ?? '…'} />
                </div>
                <div className="card-foot">
                    <span>Tokens include cache reads and writes — the subscription meters windows, not money.</span>
                    <span>{d?.claude.version ?? ''}</span>
                </div>
            </div>

            <h2>Subscription</h2>
            <LimitsCard limits={d?.limits} onChange={(limits) => d && status.setData({ ...d, limits })} />

            <div className="overview-grid">
                <div>
                    <h2>Team agents</h2>
                    <AgentsPanel limit={6} />
                </div>
                <div>
                    <h2>Recent tasks</h2>
                    <RecentTasks tasks={tasks.data} doneToday={s?.done_today} />
                </div>
            </div>

            <div className="overview-grid even">
                <div>
                    <h2>Health</h2>
                    <div className="card pad0">
                        <Check ok={Boolean(d?.claude.version)} label="Claude Code CLI" detail={d?.claude.version ?? 'not on PATH'} />
                        <Check ok={Boolean(d?.claude.logged_in)} label="Claude login" detail={d?.claude.login === 'token' ? 'CLAUDE_CODE_OAUTH_TOKEN — no claude.ai connectors' : d?.claude.login === 'none' ? 'not logged in — claude auth login in the container' : (d?.claude.login ?? '…')} />
                <Check ok={Boolean(d && (d.github.token || d.github.owners.length))} label="GitHub" detail={githubDetail(d?.github)} />
                <Check ok={Boolean(d?.telegram.enabled)} label="Telegram" detail={d?.telegram.enabled ? `bot enabled · ${d.telegram.allowed_user_ids.length} allowed user(s)` : 'TELEGRAM_BOT_TOKEN missing — web only'} warn />
                <Check ok={Boolean(d?.stt.enabled)} label="Voice input" detail={d?.stt.enabled ? d.stt.model : 'GROQ_API_KEY missing — text only'} warn />
                        <Check ok={(d?.workspaces.length ?? 0) > 0} label="Workspaces" detail={`${d?.workspaces.length ?? 0} repositories in ${d?.paths.workspaces ?? '…'}`} />
                        <div className="card-foot">
                            <span>From .env; edit on the host, restart to apply.</span>
                            <Link to="/settings" className="quiet">
                                Settings →
                            </Link>
                        </div>
                    </div>
                </div>
                <div>
                    <h2>MCP servers</h2>
                    <McpConnected servers={mcp.data?.servers} />
                </div>
            </div>
        </div>
    )
}

/** The servers the agents can use right now: those the CLI last reported as connected. The rest live in Settings → MCP. */
function McpConnected({ servers }: { servers: McpEntry[] | undefined }) {
    const connected = (servers ?? []).filter((s) => s.status === 'connected')
    const rest = (servers?.length ?? 0) - connected.length
    const shown = connected.slice(0, 6)
    const more = connected.length - shown.length
    return (
        <div className="card pad0">
            {connected.length ? (
                shown.map((s) => (
                    <div key={s.key} className="row" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                        <span className="live" style={{ fontWeight: 600 }}>
                            {s.label}
                        </span>
                        <span className="grow" />
                        <span className="dim small">{s.tools ? `${s.tools} tools` : s.source === 'connector' ? 'connector' : (s.source ?? '')}</span>
                    </div>
                ))
            ) : (
                <Empty>{servers ? 'No authorized MCP servers yet.' : '…'}</Empty>
            )}
            <div className="card-foot">
                <span>{[more > 0 ? `${more} more authorized` : '', rest > 0 ? `${rest} need authentication` : ''].filter(Boolean).join(' · ') || 'Every known server is authorized'}</span>
                <Link to="/settings" className="quiet">
                    Settings → MCP
                </Link>
            </div>
        </div>
    )
}

function RecentTasks({ tasks, doneToday }: { tasks: Task[] | undefined; doneToday: number | undefined }) {
    return (
        <div className="card pad0">
            {tasks?.length ? (
                <div className="list">
                    {tasks.map((task) => (
                        <Link key={task.id} to={`/tasks/${task.id}`} title={task.prompt.slice(0, 300)}>
                            <StatusBadge status={task.status} />
                            <div className="grow">
                                <div className="title">{task.prompt}</div>
                                <div className="desc">
                                    {task.source} · {fmt.plural(task.num_turns, 'turn')} · {fmt.tokens(taskTokens(task))} tokens
                                </div>
                            </div>
                            <span className="dim small nowrap">{fmt.ago(task.created_at)}</span>
                        </Link>
                    ))}
                </div>
            ) : (
                <Empty>No tasks yet. Send one from Telegram or start a chat.</Empty>
            )}
            <div className="card-foot">
                <Link to="/tasks">All tasks →</Link>
                <span>{doneToday !== undefined ? `${doneToday} done today` : ''}</span>
            </div>
        </div>
    )
}

function githubDetail(github: Status['github'] | undefined): string {
    if (!github) return '…'
    const parts: string[] = []
    if (github.token) parts.push('GH_TOKEN')
    if (github.owners.length) parts.push(`${fmt.plural(github.owners.length, 'owner token')} (${github.owners.join(', ')})`)
    if (!parts.length) return 'GH_TOKEN / GH_TOKEN_<OWNER> missing — no push / PR'
    return `${parts.join(' + ')} · ${github.cli ?? 'gh not found'}`
}

function Check({ ok, label, detail, warn }: { ok: boolean; label: string; detail: string; warn?: boolean }) {
    return (
        <div className="row" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <span className={`live${ok ? '' : warn ? ' warn' : ' off'}`} style={{ width: 170, fontWeight: 600 }}>
                {label}
            </span>
            <span className="dim small">{detail}</span>
        </div>
    )
}
