import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { EventFeed } from '../components/EventFeed'
import { LoadMore } from '../components/LoadMore'
import { Empty, ErrorBox, FilterSelect, PageHead, Stat, StatusBadge, StopButton, Tabs } from '../components/ui'
import { api, fmt, taskTokens, type TaskStatus } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { usePaged } from '../lib/usePaged'

const FILTERS = (['all', 'running', 'queued', 'done', 'failed', 'cancelled'] as const).map((value) => ({ value, label: value }))
const PAGE = 50

export function TasksPage() {
    const [filter, setFilter] = useState<TaskStatus | 'all'>('all')
    const [project, setProject] = useState('')
    const projects = useAsync(() => api.taskProjects(), [], 30_000)
    const tasks = usePaged((before) => api.tasks({ status: filter === 'all' ? undefined : filter, project: project || undefined, before, limit: PAGE }), {
        key: (t) => t.id,
        cursor: (t) => t.created_at,
        pageSize: PAGE,
        deps: [filter, project],
        pollMs: 5_000
    })

    return (
        <div className="page fill">
            <PageHead title="Tasks" sub="Every task from every channel — Telegram, web, later cron and webhooks." />
            <ErrorBox error={tasks.error} />
            <div className="card pad0">
                <div className="audit-bar">
                    <Tabs items={FILTERS} value={filter} onChange={setFilter} />
                    <FilterSelect label="Project" all="all projects" value={project} onChange={setProject} options={projects.data ?? []} />
                </div>
                <div className="card-scroll">
                    {tasks.items.length ? (
                        <table>
                            <thead>
                                <tr>
                                    <th>Status</th>
                                    <th>Task</th>
                                    <th>Project</th>
                                    <th>Source</th>
                                    <th>Turns</th>
                                    <th>Tokens</th>
                                    <th>Window</th>
                                    <th>Time</th>
                                    <th>Created</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {tasks.items.map((task) => (
                                    <tr key={task.id}>
                                        <td>
                                            <StatusBadge status={task.status} />
                                        </td>
                                        <td className="col-main">
                                            <Link to={`/tasks/${task.id}`}>{task.prompt.slice(0, 120)}</Link>
                                            {task.error && task.status === 'failed' && <div className="error small">{task.error.slice(0, 160)}</div>}
                                        </td>
                                        <td>{task.project ? <span className="badge plain">{task.project}</span> : <span className="dim">—</span>}</td>
                                        <td>
                                            <span className="badge plain">{task.source}</span>
                                        </td>
                                        <td>{task.num_turns}</td>
                                        <td className="nowrap">{fmt.tokens(taskTokens(task))}</td>
                                        <td className="dim nowrap">{fmt.windowDelta(task.window_5h_delta) ?? '—'}</td>
                                        <td className="nowrap">{fmt.duration(task.duration_ms)}</td>
                                        <td className="dim nowrap">{fmt.ago(task.created_at)}</td>
                                        <td>
                                            {(task.status === 'running' || task.status === 'queued') && <StopButton taskId={task.id} size="sm" onStopped={tasks.reload} />}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <Empty>{tasks.loading ? 'Loading…' : 'No tasks.'}</Empty>
                    )}
                    <LoadMore hasMore={tasks.hasMore} loading={tasks.loading} onMore={tasks.loadMore} shown={tasks.items.length} noun="tasks" />
                </div>
            </div>
        </div>
    )
}

export function TaskPage() {
    const { id = '' } = useParams()
    // Poll while the task can still change; a finished task is read once.
    const [live, setLive] = useState(true)
    const task = useAsync(() => api.task(id), [id], live ? 3_000 : undefined)
    const t = task.data
    const active = t?.status === 'running' || t?.status === 'queued'
    useEffect(() => setLive(!t || active), [t, active])

    // A transient poll error must not replace the task on screen: it shows above it.
    if (task.error && !t) return <div className="page"><ErrorBox error={task.error} /></div>
    if (!t) return <div className="page dim">Loading…</div>

    return (
        <div className="page">
            <ErrorBox error={task.error} />
            <PageHead
                title="Task"
                sub={
                    <span className="row wrap">
                        <StatusBadge status={t.status} />
                        {t.project && <span className="badge plain">{t.project}</span>}
                        <span className="dim">{t.source}</span>
                        <span className="dim">{fmt.when(t.created_at)}</span>
                        {t.conversation && <Link to={`/chat/${t.conversation_id}`}>open conversation</Link>}
                        {t.session_id && <Link to={`/sessions/${t.session_id}`}>transcript</Link>}
                    </span>
                }
            >
                {(t.status === 'running' || t.status === 'queued') && <StopButton taskId={t.id} onStopped={task.reload} />}
            </PageHead>

            <div className="cards" style={{ marginBottom: 16 }}>
                <Stat card label="Turns" value={t.num_turns} />
                <Stat card label="Duration" value={fmt.duration(t.duration_ms)} />
                <Stat card label="Tokens" value={fmt.tokens(taskTokens(t))} sub={`${fmt.tokens(t.input_tokens)} in · ${fmt.tokens(t.output_tokens)} out · ${fmt.tokens(t.cache_read_tokens)} cache read · ${fmt.tokens(t.cache_creation_tokens)} cache write`} />
                <Stat card label="5-hour window" value={fmt.windowDelta(t.window_5h_delta) ?? '—'} sub={t.window_5h_delta === null ? 'not reported by the CLI' : 'share of the window this task consumed'} />
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
