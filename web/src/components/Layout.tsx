import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'

const NAV: Array<{ to: string; label: string; icon: string; section?: string }> = [
    { to: '/', label: 'Overview', icon: '◎' },
    { to: '/tasks', label: 'Tasks', icon: '☰' },
    { to: '/chat', label: 'Chat', icon: '✎' },
    { to: '/sessions', label: 'Sessions', icon: '⧉' },
    { to: '/agents', label: 'Agents', icon: '⚙', section: 'Factory' },
    { to: '/skills', label: 'Skills', icon: '⚡' },
    { to: '/projects', label: 'Projects', icon: '▤' },
    { to: '/presets', label: 'Presets', icon: '⊞' },
    { to: '/history', label: 'History', icon: '↺' },
    { to: '/settings', label: 'Settings', icon: '⚒', section: 'System' }
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
                <button className="icon-btn" aria-label="Menu" onClick={() => setOpen(true)}>
                    ☰
                </button>
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
                    <button className="icon-btn mobile-only" aria-label="Close menu" onClick={() => setOpen(false)} style={{ marginLeft: 'auto' }}>
                        ×
                    </button>
                </div>
                <nav className="nav">
                    {NAV.map((item) => (
                        <div key={item.to}>
                            {item.section && <div className="section">{collapsed ? '·' : item.section}</div>}
                            <NavLink to={item.to} end={item.to === '/'} title={item.label}>
                                <span className="icon">{item.icon}</span>
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
                </div>
                <button className="collapse desktop-only" onClick={() => setCollapsed((v) => !v)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar">
                    {collapsed ? '»' : '«'}
                    <span className="label"> Collapse</span>
                </button>
            </aside>
            <main className="main">
                <Outlet />
            </main>
        </div>
    )
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
