import { Link } from 'react-router-dom'

import { PageHead, StatusBadge } from '../components/ui'
import { api, fmt } from '../lib/api'
import { useAsync } from '../lib/useAsync'

export function OverviewPage() {
    const status = useAsync(() => api.status(), [], 5_000)
    const tasks = useAsync(() => api.tasks(), [], 5_000)
    const agents = useAsync(() => api.list('agents'), [])
    const skills = useAsync(() => api.list('skills'), [])
    const projects = useAsync(() => api.list('projects'), [])
    const s = status.data?.stats
    const d = status.data

    return (
        <div className="page">
            <PageHead title="Overview" sub="What the factory is doing right now.">
                <Link className="btn" to="/chat">
                    New task
                </Link>
            </PageHead>

            <div className="card pad0">
                <div className="card-head">
                    <span className="row">
                        <span className="tile sm gray">◎</span>
                        Control plane
                    </span>
                    <span className={`live${d ? (d.claude.logged_in ? '' : ' warn') : ' off'}`}>{d ? (d.claude.logged_in ? 'Live' : 'Not logged in') : 'Offline'}</span>
                </div>
                <div className="stat-row">
                    <Stat label="Queued" value={s?.queued ?? '…'} />
                    <Stat label="Running" value={s?.running ?? '…'} />
                    <Stat label="Done today" value={s?.done_today ?? '…'} />
                    <Stat label="Failed today" value={s?.failed_today ?? '…'} />
                    <Stat label="Spend today" value={s ? fmt.cost(s.cost_today) : '…'} />
                    <Stat label="Spend total" value={s ? fmt.cost(s.cost_total) : '…'} />
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
                    <span>Cost is the CLI's list-price estimate — quota on a subscription, not money.</span>
                    <span>{d?.claude.version ?? ''}</span>
                </div>
            </div>

            <h2>Recent tasks</h2>
            <div className="card pad0">
                {tasks.data?.length ? (
                    <table>
                        <tbody>
                            {tasks.data.slice(0, 8).map((task) => (
                                <tr key={task.id}>
                                    <td style={{ width: 110 }}>
                                        <StatusBadge status={task.status} />
                                    </td>
                                    <td>
                                        <Link to={`/tasks/${task.id}`} style={{ color: 'var(--text)' }}>
                                            {task.prompt.slice(0, 110)}
                                        </Link>
                                    </td>
                                    <td style={{ width: 90 }}>
                                        <span className="badge plain">{task.source}</span>
                                    </td>
                                    <td className="dim nowrap" style={{ width: 150, textAlign: 'right' }}>
                                        {task.num_turns} turns · {fmt.cost(task.cost_usd)}
                                    </td>
                                    <td className="dim nowrap" style={{ width: 100, textAlign: 'right' }}>
                                        {fmt.ago(task.created_at)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="empty">No tasks yet. Send one from Telegram or start a chat.</div>
                )}
                <div className="card-foot">
                    <Link to="/tasks">All tasks →</Link>
                    <span>{tasks.data?.length ?? 0} total</span>
                </div>
            </div>

            <h2>Health</h2>
            <div className="card pad0">
                <Check ok={Boolean(d?.claude.version)} label="Claude Code CLI" detail={d?.claude.version ?? 'not on PATH'} />
                <Check ok={Boolean(d?.claude.logged_in)} label="Claude login" detail={d?.claude.logged_in ? 'CLAUDE_CODE_OAUTH_TOKEN present' : 'CLAUDE_CODE_OAUTH_TOKEN missing'} />
                <Check ok={Boolean(d?.github.token)} label="GitHub" detail={d?.github.token ? `GH_TOKEN set · ${d.github.cli}` : 'GH_TOKEN missing — no push / PR'} />
                <Check ok={Boolean(d?.telegram.enabled)} label="Telegram" detail={d?.telegram.enabled ? `bot enabled · ${d.telegram.allowed_user_ids.length} allowed user(s)` : 'TELEGRAM_BOT_TOKEN missing — web only'} warn />
                <Check ok={Boolean(d?.stt.enabled)} label="Voice input" detail={d?.stt.enabled ? d.stt.model : 'GROQ_API_KEY missing — text only'} warn />
                <Check ok={(d?.workspaces.length ?? 0) > 0} label="Workspaces" detail={`${d?.workspaces.length ?? 0} repositories in ${d?.paths.workspaces ?? '…'}`} />
            </div>
        </div>
    )
}

function Stat({ label, value, to }: { label: string; value: string | number; to?: string }) {
    const body = (
        <>
            <div className="label">{label}</div>
            <div className="value" style={{ fontSize: 18 }}>
                {value}
            </div>
        </>
    )
    return to ? (
        <Link to={to} className="stat" style={{ color: 'inherit' }}>
            {body}
        </Link>
    ) : (
        <div className="stat">{body}</div>
    )
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
