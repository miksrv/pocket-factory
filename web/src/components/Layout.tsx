import { NavLink, Outlet } from 'react-router-dom'

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

export function Layout() {
    const status = useAsync(() => api.status(), [], 10_000)
    const running = status.data?.stats.running ?? 0

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="brand">
                    <span className="tile">
                        <svg viewBox="0 0 100 100" aria-hidden>
                            <path d="M18 78V38l18-12v16l18-12v16l18-12v44H18z" fill="#fff" />
                        </svg>
                    </span>
                    Pocket Factory
                </div>
                <nav className="nav">
                    {NAV.map((item) => (
                        <div key={item.to}>
                            {item.section && <div className="section">{item.section}</div>}
                            <NavLink to={item.to} end={item.to === '/'}>
                                <span className="icon">{item.icon}</span>
                                <span className="grow">{item.label}</span>
                                {item.to === '/tasks' && running > 0 && <span className="badge running">{running}</span>}
                            </NavLink>
                        </div>
                    ))}
                </nav>
                <div className="foot">
                    {status.data ? (
                        <>
                            <div className={`live${status.data.claude.logged_in ? '' : ' warn'}`}>{status.data.claude.logged_in ? 'Live' : 'Not logged in'}</div>
                            <div style={{ marginTop: 4 }}>{status.data.claude.version ?? 'claude: not found'}</div>
                            <div>model: {status.data.claude.model ?? 'default'}</div>
                        </>
                    ) : (
                        <div className={`live ${status.error ? 'off' : 'warn'}`}>{status.error ? 'API unreachable' : 'connecting…'}</div>
                    )}
                </div>
            </aside>
            <main className="main">
                <Outlet />
            </main>
        </div>
    )
}
