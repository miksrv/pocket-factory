import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { api } from '../lib/api'
import { useLeaveGuard } from '../lib/unsaved'
import { useAsync } from '../lib/useAsync'
import { Icon, type IconName } from './Icon'
import { LimitsInline } from './Limits'
import { Button } from './ui'

const NAV: Array<{ to: string; label: string; icon: IconName; section?: string }> = [
    { to: '/', label: 'Overview', icon: 'overview' },
    { to: '/tasks', label: 'Tasks', icon: 'tasks' },
    { to: '/chat', label: 'Chat', icon: 'chat' },
    { to: '/sessions', label: 'Sessions', icon: 'sessions' },
    { to: '/audit', label: 'Audit log', icon: 'audit' },
    { to: '/agents', label: 'Agents', icon: 'agents', section: 'Factory' },
    { to: '/skills', label: 'Skills', icon: 'skills' },
    { to: '/projects', label: 'Projects', icon: 'projects' },
    { to: '/presets', label: 'Presets', icon: 'presets' },
    { to: '/settings', label: 'Settings', icon: 'settings', section: 'System' }
]

const STORAGE_KEY = 'pf.sidebar.collapsed'

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
    const [collapsed, setCollapsed] = useState(readCollapsed)
    const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('menu') === 'open') // mobile drawer
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
                    <Button className="icon-btn mobile-only" aria-label="Close menu" onClick={() => setOpen(false)}>
                        ×
                    </Button>
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
                            </NavLink>
                        </div>
                    ))}
                </nav>
                <div className="foot">
                    <div className={`live${live}`} title={liveText}>
                        <span className="label">{liveText}</span>
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
    return (
        <span className="tile">
            <svg viewBox="0 0 100 100" aria-hidden>
                <path d="M18 78V38l18-12v16l18-12v16l18-12v44H18z" fill="#fff" />
            </svg>
        </span>
    )
}
