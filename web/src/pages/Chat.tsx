import { ArrowDown, SendHorizontal } from 'lucide-react'
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { AssistantTurn } from '../components/AssistantTurn'
import { Channel } from '../components/Icon'
import { STATUS_CHANGED } from '../components/Layout'
import { LoadEarlier, LoadMore } from '../components/LoadMore'
import { useConfirm } from '../components/Modal'
import { Button, Empty, FilterSelect, Intro, StopButton } from '../components/ui'
import { api, type CatalogEntry, type Conversation, fmt, streamConversation, type Task, type TaskEvent } from '../lib/api'
import { readDraft, writeDraft } from '../lib/drafts'
import { useAsync } from '../lib/useAsync'
import { usePaged } from '../lib/usePaged'

const PAGE = 50

export function ChatPage() {
    const { id } = useParams()
    const navigate = useNavigate()
    // Not keyed on the open thread: switching threads must not rebuild the
    // list and drop the pages the reader scrolled to.
    const conversations = usePaged((before) => api.conversations(before, PAGE), {
        key: (c) => c.id,
        cursor: (c) => c.updated_at,
        pageSize: PAGE,
        pollMs: 10_000
    })
    const [error, setError] = useState<string | null>(null)
    const [params] = useSearchParams()
    const projects = useAsync(() => api.list('projects'), [])
    const [project, setProject] = useState('')

    const startNew = async (slug: string | null = project || null) => {
        try {
            const conversation = await api.createConversation(undefined, slug)
            conversations.reload()
            navigate(`/chat/${conversation.id}`, { replace: id === 'new' })
        } catch (e) {
            setError((e as Error).message)
        }
    }

    // `/chat/new[?project=slug]` (the Overview's "New task") creates a conversation and opens it.
    // Once per visit: StrictMode runs the effect twice in dev, which must not make two conversations.
    const creating = id === 'new'
    const started = useRef(false)
    useEffect(() => {
        if (!creating) {
            started.current = false
            return
        }
        if (started.current) return
        started.current = true
        void startNew(params.get('project'))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [creating])

    return (
        <div className={`chat${id && !creating ? ' has-thread' : ''}`}>
            <div className="side">
                <div className="card-head">
                    <span>Conversations</span>
                    <Button variant="primary" size="sm" onClick={() => startNew(null)}>
                        New
                    </Button>
                </div>
                <div className="list">
                    {(error || conversations.error) && <div className="error small" style={{ padding: '8px 14px' }}>{error ?? conversations.error}</div>}
                    {conversations.items.map((c) => (
                        <NavLink key={c.id} to={`/chat/${c.id}`} className={({ isActive }) => `${isActive ? 'active' : ''}${c.active ? ' running' : ''}${c.unread ? ' unread' : ''}${c.needs_reply ? ' needs-reply' : ''}`}>
                            <div className="grow">
                                <div className="title" title={c.title ?? undefined}>{c.title ?? 'Untitled'}</div>
                                <div className="desc">
                                    <Channel channel={c.channel} schedule={Boolean(c.external_id?.startsWith('schedule:'))} />
                                    {c.project ? ` · ${c.project}` : ''} · {fmt.ago(c.updated_at)}
                                </div>
                            </div>
                            {c.needs_reply && (
                                <span className="mark ask" title="Waiting for your answer">
                                    ?
                                </span>
                            )}
                            {c.unread && <span className="dot unread" title="New reply" />}
                            {c.active && !c.needs_reply && !c.unread && <span className="dot running" title="A task is running" />}
                        </NavLink>
                    ))}
                    {conversations.items.length === 0 && !conversations.loading && <Empty>No conversations yet.</Empty>}
                    {(conversations.hasMore || conversations.items.length > PAGE) && (
                        <LoadMore hasMore={conversations.hasMore} loading={conversations.loading} onMore={conversations.loadMore} shown={conversations.items.length} noun="conversations" />
                    )}
                </div>
            </div>
            {id && !creating ? (
                <Thread
                    key={id}
                    id={id}
                    onSent={conversations.reload}
                    onRead={conversations.refresh}
                    onDeleted={() => {
                        conversations.reload()
                        navigate('/chat')
                    }}
                    projects={projects.data ?? []}
                />
            ) : (
                <div className="thread">
                    {creating ? (
                        <Empty>Starting a conversation…</Empty>
                    ) : (
                        <Intro
                            text="Talk to Claude Code exactly as from Telegram — same rules, same projects, same session continuity."
                            action="Start a conversation"
                            onAction={() => startNew()}
                            note="Bound to a project, the conversation runs from its checkout: the repository's MCP servers, agents and rules apply."
                        >
                            <ProjectSelect value={project} onChange={setProject} projects={projects.data ?? []} />
                        </Intro>
                    )}
                </div>
            )}
        </div>
    )
}

const NEAR_BOTTOM = 80

/** Order of a task's life, so a stale row can never replace a newer one. */
const rank = (status: Task['status']) => (status === 'queued' ? 0 : status === 'running' ? 1 : 2)

/** "workspaces root" or one of the project files. */
function ProjectSelect({ value, onChange, projects, disabled }: { value: string; onChange: (slug: string) => void; projects: CatalogEntry[]; disabled?: boolean }) {
    return <FilterSelect label="Project" all="no project (workspaces root)" value={value} onChange={onChange} options={projects.map((p) => p.name)} disabled={disabled} />
}

function Thread({ id, onSent, onRead, onDeleted, projects }: { id: string; onSent: () => void; onRead: () => void; onDeleted: () => void; projects: CatalogEntry[] }) {
    const [conversation, setConversation] = useState<Conversation | null>(null)
    const [tasks, setTasks] = useState<Map<string, Task>>(new Map())
    const [events, setEvents] = useState<TaskEvent[]>([])
    const [hasEarlier, setHasEarlier] = useState(false)
    const [loadingEarlier, setLoadingEarlier] = useState(false)
    const [prompt, setPrompt] = useState(() => readDraft(id)) // an unsent message survives leaving the page
    const [error, setError] = useState<string | null>(null)
    const [pinned, setPinned] = useState(true) // the view follows new output while the reader is at the bottom
    const confirm = useConfirm()
    const [unseen, setUnseen] = useState(false)
    const messages = useRef<HTMLDivElement>(null)
    const composer = useRef<HTMLTextAreaElement>(null)
    const lastEvent = useRef(0)
    /** Newest event id the reader has been shown or told about; only an event beyond it is "new". */
    const seen = useRef(0)
    const keepScroll = useRef<number | null>(null)
    const tasksRef = useRef(tasks)
    tasksRef.current = tasks

    // A task row is replaced only by a newer state of itself: the POST
    // response ("queued") may arrive after the stream already said "running".
    const mergeTask = (task: Task) =>
        setTasks((prev) => {
            const known = prev.get(task.id)
            if (known && rank(known.status) > rank(task.status)) return prev
            return new Map(prev).set(task.id, task)
        })

    // The thread on screen is read: when it opens, when a reply lands while
    // it is shown, and when the owner comes back to the tab. A reply that
    // arrives while the tab is hidden keeps its "unread" mark until then.
    // The list is refetched rather than patched in place: on a fresh page
    // the 204 lands before the list's body is parsed, and the stale list
    // would overwrite a local patch.
    const onReadRef = useRef(onRead)
    onReadRef.current = onRead
    const markRead = () => {
        if (document.visibilityState !== 'visible') return
        api.markConversationRead(id)
            .then(() => {
                onReadRef.current()
                window.dispatchEvent(new Event(STATUS_CHANGED))
            })
            .catch(() => undefined)
    }
    const markReadRef = useRef(markRead)
    markReadRef.current = markRead
    useEffect(() => {
        const onVisible = () => document.visibilityState === 'visible' && markReadRef.current()
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
    }, [])

    useEffect(() => {
        let cancelled = false
        let stop = () => {}
        api.conversation(id)
            .then((detail) => {
                if (cancelled) return // unmounted before the load finished: never open a stream nobody closes
                setConversation(detail)
                markReadRef.current()
                setTasks(new Map(detail.tasks.map((t) => [t.id, t])))
                setEvents(detail.events)
                setHasEarlier(detail.has_more)
                lastEvent.current = detail.events.at(-1)?.id ?? 0
                const refresh = (taskId: string) =>
                    api
                        .task(taskId)
                        .then((task) => {
                            mergeTask(task)
                            if (task.status === 'done' || task.status === 'failed') markReadRef.current()
                        })
                        .catch(() => undefined)
                stop = streamConversation(id, () => lastEvent.current, {
                    onTask: mergeTask,
                    onEvent: (event) => {
                        if (event.id <= lastEvent.current) return
                        lastEvent.current = event.id
                        setEvents((prev) => [...prev, event])
                        // The stream replays events but not task rows: a terminal event is the cue to refetch the task.
                        if (event.type === 'status' || event.type === 'error') void refresh(event.task_id)
                    },
                    onReconnect: () => {
                        for (const task of tasksRef.current.values()) if (task.status === 'running' || task.status === 'queued') void refresh(task.id)
                    }
                })
            })
            .catch((e: Error) => !cancelled && setError(e.message))
        return () => {
            cancelled = true
            stop()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id])

    const scrollToBottom = () => {
        const el = messages.current
        if (el) el.scrollTop = el.scrollHeight
        setPinned(true)
        setUnseen(false)
    }

    // New output scrolls the view only while it sits at the bottom; prepended
    // history keeps the viewport in place; otherwise a "new messages" button
    // appears — for new events only, not for a task row that merely changed.
    useLayoutEffect(() => {
        const el = messages.current
        if (!el) return
        if (keepScroll.current !== null) {
            el.scrollTop += el.scrollHeight - keepScroll.current
            keepScroll.current = null
            return
        }
        const newest = events.at(-1)?.id ?? 0
        const grew = newest > seen.current
        seen.current = Math.max(seen.current, newest)
        if (pinned) el.scrollTop = el.scrollHeight
        else if (grew) setUnseen(true)
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

    // Every keystroke lands in storage; sending (or a restored draft that is emptied) removes it.
    useEffect(() => writeDraft(id, prompt), [id, prompt])
    // A restored draft opens with the caret at its end, where typing continues.
    useEffect(() => {
        const el = composer.current
        if (el && el.value) el.setSelectionRange(el.value.length, el.value.length)
    }, [])

    const ordered = [...tasks.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    const running = ordered.find((t) => t.status === 'running' || t.status === 'queued')
    const active = Boolean(running)
    // The agent asked a question: the next message answers it (the "Other" choice) instead of queueing a task.
    const answering = running?.status === 'running' && running.ask?.kind === 'question'

    const loadEarlier = async () => {
        const oldest = ordered[0]
        if (!oldest || loadingEarlier) return
        setLoadingEarlier(true)
        try {
            const page = await api.conversationHistory(id, { ts: oldest.created_at, id: oldest.id })
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

    const rebind = async (slug: string) => {
        try {
            setConversation(await api.setConversationProject(id, slug || null))
            setError(null)
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const remove = () =>
        void confirm({
            title: 'Delete this conversation?',
            message: 'It leaves the list. Its tasks stay in Tasks and the Audit log.',
            action: 'Delete',
            pending: 'Deleting…',
            danger: true,
            icon: 'delete',
            onConfirm: async () => {
                await api.deleteConversation(id)
                writeDraft(id, '')
                onDeleted()
            }
        })

    const [sending, setSending] = useState(false)
    const send = async (e?: FormEvent) => {
        e?.preventDefault()
        const text = prompt.trim()
        if (!text || sending) return
        setSending(true)
        setPinned(true)
        try {
            const task = await api.sendMessage(id, text)
            mergeTask(task)
            setPrompt('') // only once it is queued: a failed send keeps the draft
            setError(null)
            onSent()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSending(false)
        }
    }

    const byTask = new Map<string, TaskEvent[]>()
    for (const event of events) {
        const list = byTask.get(event.task_id)
        if (list) list.push(event)
        else byTask.set(event.task_id, [event])
    }
    return (
        <div className="thread">
            <div className="thread-head">
                <div className="row">
                    <Button to="/chat" className="mobile-only" aria-label="All conversations">
                        ‹
                    </Button>
                    <div>
                        <strong title={conversation?.title ?? undefined}>{conversation ? (conversation.title ?? 'New conversation') : '…'}</strong>
                        <div className="dim small row" style={{ gap: 6 }}>
                            {conversation && <Channel channel={conversation.channel} schedule={Boolean(conversation.external_id?.startsWith('schedule:'))} />}
                            <span>·</span>
                            <ProjectSelect value={conversation?.project ?? ''} onChange={rebind} projects={projects} disabled={!conversation || active} />
                            <span>· session {conversation?.session_id ? <Link to={`/sessions/${conversation.session_id}`}>{conversation.session_id.slice(0, 8)}</Link> : 'none yet'}</span>
                        </div>
                    </div>
                </div>
                <div className="row">
                    {running ? (
                        <StopButton taskId={running.id} size="sm" />
                    ) : (
                        <Button size="sm" onClick={remove} title="Remove from the list; tasks and audit events stay">
                            Delete
                        </Button>
                    )}
                </div>
            </div>
            <div className="messages-wrap">
                <div className="messages" ref={messages} onScroll={onScroll}>
                    {hasEarlier && <LoadEarlier loading={loadingEarlier} onMore={loadEarlier} label="Load earlier messages" />}
                    {ordered.length === 0 && conversation && <Empty>Nothing here yet. Describe the first task below.</Empty>}
                    {ordered.map((task) => (
                        <div key={task.id} className="exchange">
                            <div className="msg user">
                                <div className="bubble">{task.prompt}</div>
                                <div className="meta" title={fmt.when(task.created_at)}>
                                    {task.source !== conversation?.channel ? `${task.source} · ` : ''}
                                    {fmt.ago(task.created_at)}
                                </div>
                            </div>
                            <AssistantTurn task={task} events={byTask.get(task.id) ?? []} onTask={mergeTask} />
                        </div>
                    ))}
                    {error && <div className="tool error">{error}</div>}
                </div>
                {unseen && (
                    <Button variant="primary" className="jump" onClick={scrollToBottom}>
                        <ArrowDown size={14} /> New messages
                    </Button>
                )}
            </div>
            <form className="composer" onSubmit={send}>
                <textarea
                    ref={composer}
                    value={prompt}
                    placeholder={answering ? 'Type your answer to the question above…' : active ? 'Queued after the running task…' : 'Describe the task…'}
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
                <Button variant="primary" className="send" type="submit" disabled={!prompt.trim() || sending} title="Send (Enter)" aria-label="Send">
                    <SendHorizontal size={16} />
                </Button>
                <div className="composer-hint dim">
                    Enter to send · Shift+Enter for a new line{answering ? ' · the agent is waiting: your message is the answer' : active ? ' · a task is running, yours will queue' : ''}
                </div>
            </form>
        </div>
    )
}
