import { Link } from 'react-router-dom'

import { PageHead, StatusBadge } from '../components/ui'
import { api, fmt } from '../lib/api'
import { useAsync } from '../lib/useAsync'

export function OverviewPage() {
    const status = useAsync(() => api.status(), [], 5_000)
    const tasks = useAsync(() => api.tasks(), [], 5_000)
    const s = status.data?.stats

    return (
        <div className="page">
            <PageHead title="Overview" sub="What the factory is doing right now.">
                <Link className="btn" to="/chat">
                    New task
                </Link>
            </PageHead>

            <div className="cards">
                <Stat label="Queued" value={s?.queued ?? '…'} />
                <Stat label="Running" value={s?.running ?? '…'} />
                <Stat label="Done today" value={s?.done_today ?? '…'} />
                <Stat label="Failed today" value={s?.failed_today ?? '…'} />
                <Stat label="Spend today" value={s ? fmt.cost(s.cost_today) : '…'} hint="CLI list-price estimate" />
                <Stat label="Spend total" value={s ? fmt.cost(s.cost_total) : '…'} />
            </div>

            <h2>Recent tasks</h2>
            <div className="card pad0">
                {tasks.data?.length ? (
                    <table>
                        <thead>
                            <tr>
                                <th>Status</th>
                                <th>Task</th>
                                <th>Source</th>
                                <th className="nowrap">Turns</th>
                                <th className="nowrap">Cost</th>
                                <th className="nowrap">When</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tasks.data.slice(0, 10).map((task) => (
                                <tr key={task.id}>
                                    <td>
                                        <StatusBadge status={task.status} />
                                    </td>
                                    <td>
                                        <Link to={`/tasks/${task.id}`}>{task.prompt.slice(0, 100)}</Link>
                                    </td>
                                    <td className="dim">{task.source}</td>
                                    <td>{task.num_turns}</td>
                                    <td>{fmt.cost(task.cost_usd)}</td>
                                    <td className="dim nowrap">{fmt.ago(task.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="empty">No tasks yet. Send one from Telegram or start a chat.</div>
                )}
            </div>

            <h2>Health</h2>
            <div className="cards">
                <Check ok={Boolean(status.data?.claude.version)} label="Claude Code CLI" detail={status.data?.claude.version ?? 'not on PATH'} />
                <Check ok={Boolean(status.data?.claude.logged_in)} label="Claude login" detail={status.data?.claude.logged_in ? 'token present' : 'CLAUDE_CODE_OAUTH_TOKEN missing'} />
                <Check ok={Boolean(status.data?.github.token)} label="GitHub" detail={status.data?.github.token ? 'GH_TOKEN set' : 'GH_TOKEN missing — no push / PR'} />
                <Check ok={Boolean(status.data?.stt.enabled)} label="Voice input" detail={status.data?.stt.enabled ? status.data.stt.model : 'GROQ_API_KEY missing'} warn />
                <Check ok={(status.data?.workspaces.length ?? 0) > 0} label="Workspaces" detail={`${status.data?.workspaces.length ?? 0} repositories`} />
            </div>
        </div>
    )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
    return (
        <div className="card stat">
            <div className="value">{value}</div>
            <div className="label">{label}</div>
            {hint && <div className="dim small">{hint}</div>}
        </div>
    )
}

function Check({ ok, label, detail, warn }: { ok: boolean; label: string; detail: string; warn?: boolean }) {
    const color = ok ? 'var(--ok)' : warn ? 'var(--warn)' : 'var(--err)'
    return (
        <div className="card row">
            <span style={{ color, fontSize: 18 }}>●</span>
            <div>
                <div style={{ fontWeight: 500 }}>{label}</div>
                <div className="dim small">{detail}</div>
            </div>
        </div>
    )
}
