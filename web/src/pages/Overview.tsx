import { Link } from 'react-router-dom'

import { AgentsPanel } from '../components/AgentsPanel'
import { LimitsCard } from '../components/Limits'
import { Tile } from '../components/Tile'
import { Button, Empty, PageHead, Stat, StatusBadge } from '../components/ui'
import { api, fmt, type Task, taskTokens } from '../lib/api'
import { useAsync } from '../lib/useAsync'

export function OverviewPage() {
    const status = useAsync(() => api.status(), [], 5_000)
    const tasks = useAsync(() => api.tasks({ limit: 8 }), [], 5_000)
    const agents = useAsync(() => api.list('agents'), [])
    const skills = useAsync(() => api.list('skills'), [])
    const projects = useAsync(() => api.list('projects'), [])
    const s = status.data?.stats
    const d = status.data

    return (
        <div className="page">
            <PageHead title="Overview" sub="What the factory is doing right now.">
                <Button to="/chat">New task</Button>
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
                    <AgentsPanel />
                </div>
                <div>
                    <h2>Recent tasks</h2>
                    <RecentTasks tasks={tasks.data} doneToday={s?.done_today} />
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

function RecentTasks({ tasks, doneToday }: { tasks: Task[] | undefined; doneToday: number | undefined }) {
    return (
        <div className="card pad0">
            {tasks?.length ? (
                <table>
                    <tbody>
                        {tasks.map((task) => (
                            <tr key={task.id}>
                                <td style={{ width: 110 }}>
                                    <StatusBadge status={task.status} />
                                </td>
                                <td className="col-main">
                                    <Link to={`/tasks/${task.id}`} className="quiet">
                                        {task.prompt.slice(0, 110)}
                                    </Link>
                                </td>
                                <td style={{ width: 90 }}>
                                    <span className="badge plain">{task.source}</span>
                                </td>
                                <td className="dim nowrap" style={{ width: 150, textAlign: 'right' }}>
                                    {fmt.plural(task.num_turns, 'turn')} · {fmt.tokens(taskTokens(task))}
                                </td>
                                <td className="dim nowrap" style={{ width: 100, textAlign: 'right' }}>
                                    {fmt.ago(task.created_at)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
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
