import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { LoadMore } from '../components/LoadMore'
import { Empty, ErrorBox, PageHead } from '../components/ui'
import { api, fmt, type SessionDetail, type TranscriptEntry } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { usePaged } from '../lib/usePaged'

const PAGE = 50
const WINDOW = 200

export function SessionsPage() {
    const sessions = usePaged((before) => api.sessions(before, PAGE), {
        key: (s) => s.session_id,
        cursor: (s) => s.updated_at,
        pageSize: PAGE,
        pollMs: 15_000
    })
    return (
        <div className="page">
            <PageHead title="Sessions" sub="Claude Code transcripts on the volume — the log of record. Nothing is duplicated; this reads the JSONL files." />
            <ErrorBox error={sessions.error} />
            <div className="card pad0">
                {sessions.items.length ? (
                    <table>
                        <thead>
                            <tr>
                                <th>Session</th>
                                <th>First prompt</th>
                                <th>Project</th>
                                <th>Size</th>
                                <th>Updated</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sessions.items.map((s) => (
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
                                    <td title={s.cwd ?? s.workspace}>
                                        <Project project={s.project} fallback={s.workspace} />
                                    </td>
                                    <td className="dim">{fmt.bytes(s.size)}</td>
                                    <td className="dim nowrap">{fmt.ago(s.updated_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <Empty>{sessions.loading ? 'Loading…' : 'No transcripts yet.'}</Empty>
                )}
                <LoadMore hasMore={sessions.hasMore} loading={sessions.loading} onMore={sessions.loadMore} shown={sessions.items.length} noun="sessions" />
            </div>
        </div>
    )
}

/** The cwd relative to the workspaces root: a repository name, the root itself, or a path outside it. */
function Project({ project, fallback }: { project: string | null; fallback: string }) {
    if (project === null) return <span className="dim mono small">{fallback}</span>
    if (project === '.') return <span className="dim">workspaces root</span>
    if (project.startsWith('/')) return <span className="dim mono small">{project}</span>
    return <span className="badge plain">{project}</span>
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

/**
 * A transcript is shown as a window that starts at the end: the last 200
 * entries, then earlier ones on demand. While the session is live, the tail
 * is polled and appended.
 */
export function SessionPage() {
    const { id = '' } = useParams()
    const [session, setSession] = useState<SessionDetail | null>(null)
    const [entries, setEntries] = useState<TranscriptEntry[]>([])
    const [range, setRange] = useState({ start: 0, end: 0 })
    const [error, setError] = useState<string | undefined>()
    const [loadingEarlier, setLoadingEarlier] = useState(false)
    const keepScroll = useRef<number | null>(null)
    // The poll closure outlives renders; read the loaded range through a ref.
    const rangeRef = useRef(range)
    rangeRef.current = range

    useEffect(() => {
        let cancelled = false
        const tail = () =>
            api
                .session(id, undefined, WINDOW)
                .then((detail) => {
                    if (cancelled) return
                    setSession(detail)
                    setError(undefined)
                    setEntries((prev) => {
                        if (prev.length === 0) return detail.entries
                        // Append only what lies beyond the loaded range.
                        const fresh = detail.entries.filter((_, i) => detail.offset + i >= rangeRef.current.end)
                        return fresh.length ? [...prev, ...fresh] : prev
                    })
                    setRange((prev) => (prev.end === 0 ? { start: detail.offset, end: detail.offset + detail.entries.length } : { ...prev, end: Math.max(prev.end, detail.offset + detail.entries.length) }))
                })
                .catch((e: Error) => !cancelled && setError(e.message))
        void tail()
        const timer = setInterval(tail, 5_000)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [id])

    useEffect(() => {
        if (keepScroll.current === null) return
        window.scrollBy(0, document.documentElement.scrollHeight - keepScroll.current)
        keepScroll.current = null
    }, [entries])

    const loadEarlier = async () => {
        if (range.start === 0 || loadingEarlier) return
        setLoadingEarlier(true)
        try {
            const page = await api.session(id, range.start, WINDOW)
            keepScroll.current = document.documentElement.scrollHeight
            setEntries((prev) => [...page.entries, ...prev])
            setRange((prev) => ({ ...prev, start: page.offset }))
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoadingEarlier(false)
        }
    }

    if (error && !session) return <div className="page"><ErrorBox error={error} /></div>
    if (!session) return <div className="page dim">Loading…</div>
    const s = session
    const turns = entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && e.message)

    return (
        <div className="page">
            <PageHead
                title={`Session ${s.session_id.slice(0, 8)}`}
                sub={
                    <span className="row wrap">
                        {s.cwd && <span className="mono dim small">{s.cwd}</span>}
                        <span className="mono dim small">{s.path}</span>
                    </span>
                }
            />
            <ErrorBox error={error} />
            <div className="cards" style={{ marginBottom: 16 }}>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{s.stats.messages}</div><div className="label">Messages</div></div>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{fmt.tokens(s.stats.tokens_in)}</div><div className="label">Input tokens (incl. cache)</div></div>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{fmt.tokens(s.stats.tokens_out)}</div><div className="label">Output tokens</div></div>
                <div className="card stat"><div className="value" style={{ fontSize: 18 }}>{fmt.when(s.updated_at)}</div><div className="label">Last activity</div></div>
            </div>
            <div className="card">
                {range.start > 0 && (
                    <div className="load-earlier">
                        <button className="sm" onClick={loadEarlier} disabled={loadingEarlier}>
                            {loadingEarlier ? 'Loading…' : `Load earlier entries (${range.start.toLocaleString()} before this)`}
                        </button>
                    </div>
                )}
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
                <div className="dim small" style={{ marginTop: 10 }}>
                    entries {range.start + 1}–{range.end} of {s.stats.total.toLocaleString()}
                </div>
            </div>
        </div>
    )
}
