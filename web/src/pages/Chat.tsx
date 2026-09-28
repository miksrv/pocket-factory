import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'

import { Event } from '../components/EventFeed'
import { StatusBadge } from '../components/ui'
import { api, type Conversation, fmt, streamConversation, type Task, type TaskEvent, taskTokens } from '../lib/api'
import { useAsync } from '../lib/useAsync'

export function ChatPage() {
    const { id } = useParams()
    const navigate = useNavigate()
    const conversations = useAsync(() => api.conversations(), [id], 10_000)

    const startNew = async () => {
        const conversation = await api.createConversation()
        navigate(`/chat/${conversation.id}`)
    }

    return (
        <div className={`chat${id ? ' has-thread' : ''}`}>
            <div className="side">
                <div className="card-head" style={{ padding: '12px 14px' }}>
                    <span>Conversations</span>
                    <button className="sm primary" onClick={startNew}>
                        New
                    </button>
                </div>
                <div className="list">
                    {conversations.data?.map((c) => (
                        <NavLink key={c.id} to={`/chat/${c.id}`}>
                            <div className="grow">
                                <div className="title">{c.title ?? 'Untitled'}</div>
                                <div className="desc">
                                    {c.channel === 'telegram' ? '✈ telegram' : '✎ web'} · {fmt.ago(c.updated_at)}
                                </div>
                            </div>
                        </NavLink>
                    ))}
                    {conversations.data?.length === 0 && <div className="empty">No conversations yet.</div>}
                </div>
            </div>
            {id ? <Thread key={id} id={id} onSent={conversations.reload} /> : <Intro onNew={startNew} />}
        </div>
    )
}

function Intro({ onNew }: { onNew: () => void }) {
    return (
        <div className="thread">
            <div className="empty" style={{ marginTop: 80 }}>
                <p>Talk to Claude Code exactly as from Telegram — same rules, same projects, same session continuity.</p>
                <button className="primary" onClick={onNew}>
                    Start a conversation
                </button>
            </div>
        </div>
    )
}

interface Item {
    kind: 'task' | 'event'
    task?: Task
    event?: TaskEvent
}

function Thread({ id, onSent }: { id: string; onSent: () => void }) {
    const [conversation, setConversation] = useState<Conversation | null>(null)
    const [tasks, setTasks] = useState<Map<string, Task>>(new Map())
    const [events, setEvents] = useState<TaskEvent[]>([])
    const [prompt, setPrompt] = useState('')
    const [error, setError] = useState<string | null>(null)
    const bottom = useRef<HTMLDivElement>(null)
    const lastEvent = useRef(0)

    useEffect(() => {
        let stop = () => {}
        api.conversation(id)
            .then((detail) => {
                setConversation(detail)
                setTasks(new Map(detail.tasks.map((t) => [t.id, t])))
                setEvents(detail.events)
                lastEvent.current = detail.events.at(-1)?.id ?? 0
                stop = streamConversation(id, lastEvent.current, {
                    onTask: (task) => setTasks((prev) => new Map(prev).set(task.id, task)),
                    onEvent: (event) => {
                        if (event.id <= lastEvent.current) return
                        lastEvent.current = event.id
                        setEvents((prev) => [...prev, event])
                    }
                })
            })
            .catch((e: Error) => setError(e.message))
        return () => stop()
    }, [id])

    useEffect(() => {
        bottom.current?.scrollIntoView({ block: 'end' })
    }, [events, tasks])

    const send = async (e?: FormEvent) => {
        e?.preventDefault()
        const text = prompt.trim()
        if (!text) return
        setPrompt('')
        try {
            const task = await api.sendMessage(id, text)
            setTasks((prev) => new Map(prev).set(task.id, task))
            onSent()
        } catch (err) {
            setError((err as Error).message)
        }
    }

    // Interleave: each task's prompt, then the events that belong to it.
    const ordered = [...tasks.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    const items: Item[] = []
    for (const task of ordered) {
        items.push({ kind: 'task', task })
        for (const event of events) if (event.task_id === task.id) items.push({ kind: 'event', event })
    }
    const active = ordered.some((t) => t.status === 'running' || t.status === 'queued')

    return (
        <div className="thread">
            <div className="thread-head">
                <div className="row">
                    <Link to="/chat" className="btn mobile-only" style={{ textDecoration: 'none' }}>
                        ‹
                    </Link>
                    <div>
                    <strong>{conversation?.title ?? '…'}</strong>
                    <div className="dim small">
                        {conversation?.channel} · session {conversation?.session_id ? <Link to={`/sessions/${conversation.session_id}`}>{conversation.session_id.slice(0, 8)}</Link> : 'none yet'}
                    </div>
                    </div>
                </div>
                {active && (
                    <button
                        className="sm danger"
                        onClick={() => {
                            const running = ordered.find((t) => t.status === 'running' || t.status === 'queued')
                            if (running) void api.stopTask(running.id)
                        }}
                    >
                        Stop
                    </button>
                )}
            </div>
            <div className="messages">
                {items.map((item) =>
                    item.kind === 'task' ? (
                        <div key={item.task!.id} className="msg user">
                            {item.task!.prompt}
                            <div className="meta row">
                                <StatusBadge status={item.task!.status} />
                                {item.task!.status !== 'queued' && item.task!.status !== 'running' && (
                                    <span>
                                        {item.task!.num_turns} turns · {fmt.tokens(taskTokens(item.task!))} · {fmt.windowDelta(item.task!.window_5h_delta) ?? 'window n/a'} · {fmt.duration(item.task!.duration_ms)}
                                    </span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div key={item.event!.id} className="msg assistant">
                            <Event event={item.event!} />
                        </div>
                    )
                )}
                {error && <div className="tool error">{error}</div>}
                <div ref={bottom} />
            </div>
            <form className="composer" onSubmit={send}>
                <textarea
                    value={prompt}
                    placeholder={active ? 'Queued after the running task…' : 'Describe the task. Enter to send, Shift+Enter for a new line.'}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void send()
                        }
                    }}
                    rows={2}
                />
                <button className="primary" type="submit" disabled={!prompt.trim()}>
                    Send
                </button>
            </form>
        </div>
    )
}
