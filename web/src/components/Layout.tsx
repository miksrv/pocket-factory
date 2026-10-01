import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'

import { api } from '../lib/api'
import { setFaviconBadge } from '../lib/favicon'
import { notificationsBlocked, notificationsEnabled, notificationsSupported, notify, toggleNotifications } from '../lib/notify'
import { useLeaveGuard } from '../lib/unsaved'
import { useAsync } from '../lib/useAsync'
import { Icon, type IconName } from './Icon'
import { LimitsInline } from './Limits'
import { Button, CloseButton } from './ui'

const NAV: Array<{ to: string; label: string; icon: IconName; section?: string }> = [
    { to: '/', label: 'Overview', icon: 'overview' },
    { to: '/tasks', label: 'Tasks', icon: 'tasks' },
    { to: '/chat', label: 'Chat', icon: 'chat' },
    { to: '/sessions', label: 'Sessions', icon: 'sessions' },
    { to: '/audit', label: 'Audit log', icon: 'audit' },
    { to: '/agents', label: 'Agents', icon: 'agents', section: 'Factory' },
    { to: '/skills', label: 'Skills', icon: 'skills' },
    { to: '/projects', label: 'Projects', icon: 'projects' },
    { to: '/schedules', label: 'Schedules', icon: 'schedules' },
    { to: '/presets', label: 'Presets', icon: 'presets' },
    { to: '/settings', label: 'Settings', icon: 'settings', section: 'System' }
]

const STORAGE_KEY = 'pf.sidebar.collapsed'

/** Dispatched on `window` by a page that changed what the sidebar badges show, so they refresh before the next poll. */
export const STATUS_CHANGED = 'pf:status-changed'

/** Initial state: `?sidebar=collapsed|expanded` wins (bookmarkable), then the remembered choice. */
function readCollapsed(): boolean {
    const param = new URLSearchParams(window.location.search).get('sidebar')
    if (param === 'collapsed') return true
    if (param === 'expanded') return false
    try {
        return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

export function Layout() {
    const status = useAsync(() => api.status(), [], 10_000)
    const running = status.data?.stats.running ?? 0
    const unread = status.data?.stats.chat_unread ?? 0
    const needsReply = status.data?.stats.chat_needs_reply ?? 0
    const chatActive = status.data?.stats.chat_active ?? 0
    // One badge per item: the Chat item shows what needs the owner first —
    // replies not seen yet, then questions waiting for an answer, then work in progress.
    const chatBadge =
        unread > 0
            ? { kind: 'unread' as const, count: unread, title: `${unread} unread` }
            : needsReply > 0
              ? { kind: 'ask' as const, count: needsReply, title: `${needsReply} waiting for your answer` }
              : chatActive > 0
                ? { kind: 'running' as const, count: chatActive, title: `${chatActive} working` }
                : null

    // A page that changed what the badges show (the Chat marking a thread read) asks for a fresh reading at once.
    useEffect(() => {
        window.addEventListener(STATUS_CHANGED, status.reload)
        return () => window.removeEventListener(STATUS_CHANGED, status.reload)
    }, [status.reload])

    // The browser tab tells too: that is where the owner looks when the app is in another tab.
    // The title counts unread replies (truncated once many tabs are open), the icon carries the
    // same badge as the Chat item (visible even on a pinned tab).
    useEffect(() => {
        document.title = unread > 0 ? `(${unread}) Pocket Factory` : 'Pocket Factory'
    }, [unread])
    const [collapsed, setCollapsed] = useState(readCollapsed)
    const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('menu') === 'open') // mobile drawer
    useEffect(() => {
        setFaviconBadge(chatBadge ? (chatBadge.kind === 'running' ? { kind: 'running' } : { kind: chatBadge.kind, count: chatBadge.count }) : null)
    }, [chatBadge?.kind, chatBadge?.count]) // eslint-disable-line react-hooks/exhaustive-deps

    // A desktop notification when a reply lands or a question opens while the tab is hidden
    // (notify() does nothing while it is visible). Only on a rise: a count that stays is old news.
    const navigate = useNavigate()
    const seen = useRef<{ unread: number; ask: number } | null>(null)
    useEffect(() => {
        if (!status.data) return
        const prev = seen.current
        seen.current = { unread, ask: needsReply }
        if (!prev) return // the first reading after a load is not news
        // Titled with the thread it is about and opening it on click; the others, if any, are one line in the body.
        const { chat_unread_latest: unreadLatest, chat_needs_reply_latest: askLatest } = status.data.stats
        if (unread > prev.unread) {
            const more = unread > 1 ? ` · ${unread - 1} more unread` : ''
            notify(unreadLatest?.title ?? 'Pocket Factory', `A task finished — reply to read${more}`, 'pf-unread', () =>
                navigate(unreadLatest ? `/chat/${unreadLatest.id}` : '/chat')
            )
        }
        if (needsReply > prev.ask) {
            const more = needsReply > 1 ? ` · ${needsReply - 1} more waiting` : ''
            notify(askLatest?.title ?? 'Pocket Factory', `A task is waiting for your answer${more}`, 'pf-ask', () =>
                navigate(askLatest ? `/chat/${askLatest.id}` : '/chat')
            )
        }
    }, [status.data, unread, needsReply, navigate])
    const [notifyOn, setNotifyOn] = useState(notificationsEnabled)
    const notifyTitle = !notificationsSupported
        ? 'Desktop notifications need https (or localhost)'
        : notificationsBlocked()
          ? 'Notifications are blocked for this site in the browser'
          : notifyOn
            ? 'Desktop notifications on — click to turn off'
            : 'Notify me when a task finishes while this tab is hidden'
    const location = useLocation()
    const { guard } = useLeaveGuard()

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
        } catch {
            // private mode etc.
        }
    }, [collapsed])

    // Close the drawer on navigation (not on mount) and on Escape.
    const firstRender = useRef(true)
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false
            return
        }
        setOpen(false)
    }, [location.pathname])
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    const live = status.data ? (status.data.claude.logged_in ? '' : ' warn') : status.error ? ' off' : ' warn'
    const liveText = status.data ? (status.data.claude.logged_in ? 'Live' : 'Not logged in') : status.error ? 'API unreachable' : 'connecting…'

    return (
        <div className={`app${collapsed ? ' collapsed' : ''}${open ? ' drawer-open' : ''}`}>
            <header className="topbar">
                <Button className="icon-btn" aria-label="Menu" onClick={() => setOpen(true)}>
                    ☰
                </Button>
                <span className="brand" style={{ padding: 0 }}>
                    <Logo />
                    Pocket Factory
                </span>
                <span className={`live${live}`} title={liveText} />
            </header>
            <div className="scrim" onClick={() => setOpen(false)} />
            <aside className="sidebar">
                <div className="brand">
                    <Logo />
                    <span className="label">Pocket Factory</span>
                    <CloseButton className="icon-btn mobile-only" label="Close menu" onClick={() => setOpen(false)} />
                </div>
                <nav className="nav">
                    {NAV.map((item) => (
                        <div key={item.to}>
                            {item.section && <div className="section">{collapsed ? '·' : item.section}</div>}
                            <NavLink to={item.to} end={item.to === '/'} title={item.label} onClick={guard(item.to)}>
                                <span className="icon">
                                    <Icon name={item.icon} />
                                </span>
                                <span className="grow label">{item.label}</span>
                                {item.to === '/tasks' && running > 0 && <span className="badge running count">{running}</span>}
                                {item.to === '/chat' && chatBadge && (
                                    <span className={`badge ${chatBadge.kind} count`} title={chatBadge.title}>
                                        {chatBadge.count}
                                    </span>
                                )}
                            </NavLink>
                        </div>
                    ))}
                </nav>
                <div className="foot">
                    <div className="foot-row">
                        <div className={`live${live}`} title={liveText}>
                            <span className="label">{liveText}</span>
                        </div>
                        <Button
                            variant="ghost"
                            className={`notify-toggle${notifyOn ? ' on' : ''}`}
                            title={notifyTitle}
                            aria-label={notifyTitle}
                            aria-pressed={notifyOn}
                            disabled={!notificationsSupported || notificationsBlocked()}
                            onClick={() => toggleNotifications().then(setNotifyOn)}
                        >
                            <Icon name={notifyOn ? 'bell' : 'bellOff'} size={14} />
                        </Button>
                    </div>
                    <div className="label" style={{ marginTop: 4 }}>
                        {status.data?.claude.version ?? ''}
                    </div>
                    <div className="label">{status.data ? `model: ${status.data.claude.model ?? 'default'}` : ''}</div>
                    <NavLink to="/" className="label limits-foot" title="Subscription limits — see Overview">
                        <LimitsInline limits={status.data?.limits} />
                    </NavLink>
                </div>
                <Button variant="ghost" className="collapse desktop-only" onClick={() => setCollapsed((v) => !v)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar">
                    {collapsed ? '»' : '«'}
                    <span className="label"> Collapse</span>
                </Button>
            </aside>
            <main className="main">
                <PageBoundary key={location.pathname.split('/')[1] ?? ''} resetKey={location.pathname}>
                    <Outlet />
                </PageBoundary>
            </main>
        </div>
    )
}

/**
 * A page that throws while rendering (an unexpected API shape, say) shows
 * its error inside the layout instead of blanking the whole app. Keyed on the
 * first path segment only: a page keeps its state across its own routes (the
 * chat's thread list, the editor's list), and a path change within the
 * section clears a shown error through `resetKey`.
 */
class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
    state = { error: null as Error | null }

    static getDerivedStateFromError(error: Error) {
        return { error }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('page crashed', error, info.componentStack)
    }

    componentDidUpdate(prev: { resetKey: string }) {
        if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
    }

    render() {
        if (!this.state.error) return this.props.children
        return (
            <div className="page">
                <div className="card error">
                    <strong>This page hit an error.</strong>
                    <pre style={{ marginBottom: 0 }}>{this.state.error.message}</pre>
                    <Button size="sm" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>
                        Try again
                    </Button>
                </div>
            </div>
        )
    }
}

function Logo() {
    return <img className="logo" src="/icon-192.png" alt="" width={30} height={30} />
}
