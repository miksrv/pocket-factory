import { ArrowDown, SendHorizontal } from 'lucide-react'
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'

import { AssistantTurn } from '../components/AssistantTurn'
import { Channel } from '../components/Icon'
import { LoadMore } from '../components/LoadMore'
import { api, type Conversation, fmt, streamConversation, type Task, type TaskEvent } from '../lib/api'
import { usePaged } from '../lib/usePaged'

const PAGE = 50

export function ChatPage() {
    const { id } = useParams()
    const navigate = useNavigate()
    const conversations = usePaged((before) => api.conversations(before, PAGE), {
        key: (c) => c.id,
        cursor: (c) => c.updated_at,
        pageSize: PAGE,
        deps: [id],
        pollMs: 10_000
    })

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
                    {conversations.items.map((c) => (
                        <NavLink key={c.id} to={`/chat/${c.id}`}>
                            <div className="grow">
                                <div className="title">{c.title ?? 'Untitled'}</div>
                                <div className="desc">
                                    <Channel channel={c.channel} />
                                    {c.project ? ` · ${c.project}` : ''} · {fmt.ago(c.updated_at)}
                                </div>
                            </div>
                        </NavLink>
                    ))}
                    {conversations.items.length === 0 && !conversations.loading && <div className="empty">No conversations yet.</div>}
                    {(conversations.hasMore || conversations.items.length > PAGE) && (
                        <LoadMore hasMore={conversations.hasMore} loading={conversations.loading} onMore={conversations.loadMore} shown={conversations.items.length} noun="conversations" />
                    )}
                </div>
            </div>
            {id ? (
                <Thread
                    key={id}
                    id={id}
                    onSent={conversations.reload}
                    onDeleted={() => {
                        conversations.reload()
                        navigate('/chat')
                    }}
                />
            ) : (
                <Intro onNew={startNew} />
            )}
        </div>
    )
}

function Intro({ onNew }: { onNew: () => void }) {
    return (
        <div className="thread intro">
            <div className="empty">
                <p>Talk to Claude Code exactly as from Telegram — same rules, same projects, same session continuity.</p>
                <button className="primary" onClick={onNew}>
                    Start a conversation
                </button>
            </div>
        </div>
    )
}

const NEAR_BOTTOM = 80

function Thread({ id, onSent, onDeleted }: { id: string; onSent: () => void; onDeleted: () => void }) {
    const [conversation, setConversation] = useState<Conversation | null>(null)
    const [tasks, setTasks] = useState<Map<string, Task>>(new Map())
    const [events, setEvents] = useState<TaskEvent[]>([])
    const [hasEarlier, setHasEarlier] = useState(false)
    const [loadingEarlier, setLoadingEarlier] = useState(false)
    const [prompt, setPrompt] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [pinned, setPinned] = useState(true) // the view follows new output while the reader is at the bottom
    const [unseen, setUnseen] = useState(false)
    const messages = useRef<HTMLDivElement>(null)
    const composer = useRef<HTMLTextAreaElement>(null)
    const lastEvent = useRef(0)
    const keepScroll = useRef<number | null>(null)

    useEffect(() => {
        let stop = () => {}
        api.conversation(id)
            .then((detail) => {
                setConversation(detail)
                setTasks(new Map(detail.tasks.map((t) => [t.id, t])))
                setEvents(detail.events)
                setHasEarlier(detail.has_more)
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

    const scrollToBottom = () => {
        const el = messages.current
        if (el) el.scrollTop = el.scrollHeight
        setPinned(true)
        setUnseen(false)
    }

    // New output scrolls the view only while it sits at the bottom; prepended
    // history keeps the viewport in place; otherwise a "new messages" button appears.
    useLayoutEffect(() => {
        const el = messages.current
        if (!el) return
        if (keepScroll.current !== null) {
            el.scrollTop += el.scrollHeight - keepScroll.current
            keepScroll.current = null
            return
        }
        if (pinned) el.scrollTop = el.scrollHeight
        else setUnseen(true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [events, tasks])

    const onScroll = () => {
        const el = messages.current
        if (!el) return
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
        setPinned(atBottom)
        if (atBottom) setUnseen(false)
    }

    // The composer grows with the draft, up to a few lines.
    useLayoutEffect(() => {
        const el = composer.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`
    }, [prompt])

    const loadEarlier = async () => {
        const oldest = [...tasks.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0]
        if (!oldest || loadingEarlier) return
        setLoadingEarlier(true)
        try {
            const page = await api.conversationHistory(id, oldest.created_at)
            keepScroll.current = messages.current?.scrollHeight ?? null
            setTasks((prev) => {
                const next = new Map(prev)
                for (const task of page.tasks) next.set(task.id, task)
                return next
            })
            setEvents((prev) => [...page.events, ...prev])
            setHasEarlier(page.has_more)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoadingEarlier(false)
        }
    }

    const remove = async () => {
        if (!window.confirm('Remove this conversation from the list? Its tasks stay in Tasks and the Audit log.')) return
        try {
            await api.deleteConversation(id)
            onDeleted()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const send = async (e?: FormEvent) => {
        e?.preventDefault()
        const text = prompt.trim()
        if (!text) return
        setPrompt('')
        setPinned(true)
        try {
            const task = await api.sendMessage(id, text)
            setTasks((prev) => new Map(prev).set(task.id, task))
            onSent()
        } catch (err) {
            setError((err as Error).message)
        }
    }

    const ordered = [...tasks.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    const byTask = new Map<string, TaskEvent[]>()
    for (const event of events) {
        const list = byTask.get(event.task_id)
        if (list) list.push(event)
        else byTask.set(event.task_id, [event])
    }
    const running = ordered.find((t) => t.status === 'running' || t.status === 'queued')
    const active = Boolean(running)

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
                            {conversation && <Channel channel={conversation.channel} />}
                            {conversation?.project ? ` · ${conversation.project}` : ''} · session{' '}
                            {conversation?.session_id ? <Link to={`/sessions/${conversation.session_id}`}>{conversation.session_id.slice(0, 8)}</Link> : 'none yet'}
                        </div>
                    </div>
                </div>
                <div className="row">
                    {active ? (
                        <button className="sm danger" onClick={() => running && void api.stopTask(running.id)}>
                            Stop
                        </button>
                    ) : (
                        <button className="sm" onClick={remove} title="Remove from the list; tasks and audit events stay">
                            Delete
                        </button>
                    )}
                </div>
            </div>
            <div className="messages-wrap">
                <div className="messages" ref={messages} onScroll={onScroll}>
                    {hasEarlier && (
                        <div className="load-earlier">
                            <button className="sm" onClick={loadEarlier} disabled={loadingEarlier}>
                                {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
                            </button>
                        </div>
                    )}
                    {ordered.length === 0 && conversation && <div className="empty">Nothing here yet. Describe the first task below.</div>}
                    {ordered.map((task) => (
                        <div key={task.id} className="exchange">
                            <div className="msg user">
                                <div className="bubble">{task.prompt}</div>
                                <div className="meta" title={fmt.when(task.created_at)}>
                                    {task.source !== conversation?.channel ? `${task.source} · ` : ''}
                                    {fmt.ago(task.created_at)}
                                </div>
                            </div>
                            <AssistantTurn task={task} events={byTask.get(task.id) ?? []} />
                        </div>
                    ))}
                    {error && <div className="tool error">{error}</div>}
                </div>
                {unseen && (
                    <button className="jump" onClick={scrollToBottom}>
                        <ArrowDown size={14} /> New messages
                    </button>
                )}
            </div>
            <form className="composer" onSubmit={send}>
                <textarea
                    ref={composer}
                    value={prompt}
                    placeholder={active ? 'Queued after the running task…' : 'Describe the task…'}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault()
                            void send()
                        }
                    }}
                    rows={1}
                    autoFocus
                />
                <button className="primary send" type="submit" disabled={!prompt.trim()} title="Send (Enter)">
                    <SendHorizontal size={16} />
                </button>
                <div className="composer-hint dim">
                    Enter to send · Shift+Enter for a new line{active ? ' · a task is running, yours will queue' : ''}
                </div>
            </form>
        </div>
    )
}
