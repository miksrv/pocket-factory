import { Link, useParams } from 'react-router-dom'

import { Empty, ErrorBox, PageHead } from '../components/ui'
import { api, fmt, type TranscriptEntry } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { useAsync } from '../lib/useAsync'

export function SessionsPage() {
    const sessions = useAsync(() => api.sessions(), [], 15_000)
    return (
        <div className="page">
            <PageHead title="Sessions" sub="Claude Code transcripts on the volume — the log of record. Nothing is duplicated; this reads the JSONL files." />
            <ErrorBox error={sessions.error} />
            <div className="card pad0">
                {sessions.data?.length ? (
                    <table>
                        <thead>
                            <tr>
                                <th>Session</th>
                                <th>First prompt</th>
                                <th>Workspace</th>
                                <th>Size</th>
                                <th>Updated</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sessions.data.map((s) => (
                                <tr key={s.session_id}>
                                    <td className="mono">
                                        <Link to={`/sessions/${s.session_id}`}>{s.session_id.slice(0, 8)}</Link>
                                    </td>
                                    <td className="col-main">
                                        {s.first_prompt ?? <span className="dim">—</span>}
                                        {s.task_id && (
                                            <span className="dim small">
                                                {' '}
                                                · <Link to={`/tasks/${s.task_id}`}>task</Link>
                                            </span>
                                        )}
                                    </td>
                                    <td className="dim mono small">{s.workspace}</td>
                                    <td className="dim">{fmt.bytes(s.size)}</td>
                                    <td className="dim nowrap">{fmt.ago(s.updated_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <Empty>{sessions.loading ? 'Loading…' : 'No transcripts yet.'}</Empty>
                )}
            </div>
        </div>
    )
}

function textOf(content: NonNullable<TranscriptEntry['message']>['content']): string {
    if (typeof content === 'string') return content
    return (content ?? [])
        .map((block) => {
            const b = block as Record<string, unknown>
            if (b.type === 'text') return String(b.text ?? '')
            if (b.type === 'tool_use') return `\n\`▸ ${String(b.name)}\` ${JSON.stringify(b.input).slice(0, 300)}\n`
            if (b.type === 'tool_result') {
                const inner = b.content
                const text = typeof inner === 'string' ? inner : Array.isArray(inner) ? inner.map((p) => String((p as Record<string, unknown>).text ?? '')).join('') : ''
                return text ? `\n\`\`\`\n${text.slice(0, 1500)}${text.length > 1500 ? '\n…' : ''}\n\`\`\`\n` : ''
            }
            return ''
        })
        .join('')
}

export function SessionPage() {
    const { id = '' } = useParams()
    const session = useAsync(() => api.session(id), [id], 5_000)
    const s = session.data
    if (session.error) return <div className="page"><ErrorBox error={session.error} /></div>
    if (!s) return <div className="page dim">Loading…</div>

    const usage = s.entries.reduce(
        (acc, e) => {
            const u = e.message?.usage
            if (u) {
                acc.in += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
                acc.out += u.output_tokens ?? 0
            }
            return acc
        },
        { in: 0, out: 0 }
    )
    const turns = s.entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && e.message)

    return (
        <div className="page">
            <PageHead
                title={`Session ${s.session_id.slice(0, 8)}`}
                sub={
                    <span className="row wrap">
                        <span className="mono dim small">{s.path}</span>
                    </span>
                }
            />
            <div className="cards" style={{ marginBottom: 16 }}>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{turns.length}</div><div className="label">Messages</div></div>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{usage.in.toLocaleString()}</div><div className="label">Input tokens (incl. cache)</div></div>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{usage.out.toLocaleString()}</div><div className="label">Output tokens</div></div>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{fmt.when(s.updated_at)}</div><div className="label">Last activity</div></div>
            </div>
            <div className="card">
                {turns.map((entry, i) => {
                    const role = entry.message?.role ?? entry.type
                    const text = textOf(entry.message?.content)
                    if (!text.trim()) return null
                    return (
                        <div key={entry.uuid ?? i} className={`turn ${role}${entry.isSidechain ? ' sidechain' : ''}`}>
                            <div className="who">
                                {entry.isSidechain ? 'sub-agent · ' : ''}
                                {role}
                                {entry.message?.model ? ` · ${entry.message.model}` : ''}
                                {entry.timestamp ? ` · ${new Date(entry.timestamp).toLocaleTimeString()}` : ''}
                            </div>
                            <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
