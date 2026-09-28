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
    { to: '/settings', label: 'Settings', icon: '⚒', section: 'System' }
]

export function Layout() {
    const status = useAsync(() => api.status(), [], 10_000)
    const running = status.data?.stats.running ?? 0

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="brand">
                    <svg viewBox="0 0 100 100" aria-hidden>
                        <rect width="100" height="100" rx="20" fill="#0f172a" />
                        <path d="M22 72V40l14-10v14l14-10v14l14-10v34H22z" fill="#f59e0b" />
                    </svg>
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
                            <div>{status.data.claude.version ?? 'claude: not found'}</div>
                            <div>model: {status.data.claude.model ?? 'default'}</div>
                        </>
                    ) : (
                        <div className={status.error ? 'error' : ''}>{status.error ?? 'connecting…'}</div>
                    )}
                </div>
            </aside>
            <main className="main">
                <Outlet />
            </main>
        </div>
    )
}
