import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { EventFeed } from '../components/EventFeed'
import { Empty, ErrorBox, PageHead, StatusBadge } from '../components/ui'
import { api, fmt, type TaskStatus } from '../lib/api'
import { useAsync } from '../lib/useAsync'

const FILTERS: Array<TaskStatus | 'all'> = ['all', 'running', 'queued', 'done', 'failed', 'cancelled']

export function TasksPage() {
    const [filter, setFilter] = useState<TaskStatus | 'all'>('all')
    const tasks = useAsync(() => api.tasks(filter === 'all' ? undefined : filter), [filter], 5_000)

    return (
        <div className="page">
            <PageHead title="Tasks" sub="Every task from every channel — Telegram, web, later cron and webhooks.">
                <select value={filter} onChange={(e) => setFilter(e.target.value as TaskStatus | 'all')} style={{ width: 160 }}>
                    {FILTERS.map((f) => (
                        <option key={f} value={f}>
                            {f}
                        </option>
                    ))}
                </select>
            </PageHead>
            <ErrorBox error={tasks.error} />
            <div className="card pad0">
                {tasks.data?.length ? (
                    <table>
                        <thead>
                            <tr>
                                <th>Status</th>
                                <th>Task</th>
                                <th>Source</th>
                                <th>Turns</th>
                                <th>Cost</th>
                                <th>Time</th>
                                <th>Created</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {tasks.data.map((task) => (
                                <tr key={task.id}>
                                    <td>
                                        <StatusBadge status={task.status} />
                                    </td>
                                    <td>
                                        <Link to={`/tasks/${task.id}`}>{task.prompt.slice(0, 120)}</Link>
                                        {task.error && task.status === 'failed' && <div className="error small">{task.error.slice(0, 160)}</div>}
                                    </td>
                                    <td className="dim">{task.source}</td>
                                    <td>{task.num_turns}</td>
                                    <td>{fmt.cost(task.cost_usd)}</td>
                                    <td>{fmt.duration(task.duration_ms)}</td>
                                    <td className="dim nowrap">{fmt.ago(task.created_at)}</td>
                                    <td>
                                        {(task.status === 'running' || task.status === 'queued') && (
                                            <button className="sm danger" onClick={() => api.stopTask(task.id).then(tasks.reload)}>
                                                Stop
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <Empty>{tasks.loading ? 'Loading…' : 'No tasks.'}</Empty>
                )}
            </div>
        </div>
    )
}

export function TaskPage() {
    const { id = '' } = useParams()
    const task = useAsync(() => api.task(id), [id], 3_000)
    const t = task.data

    if (task.error) return <div className="page"><ErrorBox error={task.error} /></div>
    if (!t) return <div className="page dim">Loading…</div>

    return (
        <div className="page">
            <PageHead
                title="Task"
                sub={
                    <span className="row wrap">
                        <StatusBadge status={t.status} />
                        <span className="dim">{t.source}</span>
                        <span className="dim">{fmt.when(t.created_at)}</span>
                        {t.conversation && <Link to={`/chat/${t.conversation_id}`}>open conversation</Link>}
                        {t.session_id && <Link to={`/sessions/${t.session_id}`}>transcript</Link>}
                    </span>
                }
            >
                {(t.status === 'running' || t.status === 'queued') && (
                    <button className="danger" onClick={() => api.stopTask(t.id).then(task.reload)}>
                        Stop
                    </button>
                )}
            </PageHead>

            <div className="cards" style={{ marginBottom: 16 }}>
                <Kv label="Turns" value={t.num_turns} />
                <Kv label="Cost" value={fmt.cost(t.cost_usd)} />
                <Kv label="Duration" value={fmt.duration(t.duration_ms)} />
                <Kv label="Tokens" value={`${t.input_tokens} in · ${t.output_tokens} out`} />
            </div>

            <h2>Prompt</h2>
            <div className="card" style={{ whiteSpace: 'pre-wrap' }}>
                {t.prompt}
            </div>

            <h2>Output</h2>
            <div className="card">
                <EventFeed events={t.events} finalText={t.status === 'done' ? t.result : null} error={t.status === 'failed' ? t.error : null} />
            </div>
        </div>
    )
}

function Kv({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="card stat">
            <div className="value" style={{ fontSize: 18 }}>
                {value}
            </div>
            <div className="label">{label}</div>
        </div>
    )
}
