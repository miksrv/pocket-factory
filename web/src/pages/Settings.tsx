import { ErrorBox, PageHead } from '../components/ui'
import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'

export function SettingsPage() {
    const status = useAsync(() => api.status(), [], 10_000)
    const s = status.data
    return (
        <div className="page">
            <PageHead title="Settings" sub="Read-only view of the running configuration. Everything here comes from .env; edit it on the host and restart the container." />
            <ErrorBox error={status.error} />
            {s && (
                <div className="stack">
                    <Section title="Claude Code">
                        <Row k="CLI" v={s.claude.version ?? 'not found'} />
                        <Row k="Login" v={s.claude.logged_in ? 'token present (CLAUDE_CODE_OAUTH_TOKEN)' : 'not logged in'} />
                        <Row k="Model" v={s.claude.model ?? 'CLI default'} />
                        <Row k="Permission mode" v={s.claude.permission_mode} />
                        <Row k="Limits per task" v={`${s.claude.max_turns} turns · $${s.claude.max_budget_usd} budget`} />
                        <Row k="Concurrent sessions" v={String(s.max_concurrent_sessions)} />
                        <Row k="Config dir" v={s.claude.config_dir} mono />
                    </Section>
                    <Section title="GitHub">
                        <Row k="gh CLI" v={s.github.cli ?? 'not found'} />
                        <Row k="Token" v={s.github.token ? 'GH_TOKEN set (fine-grained PAT)' : 'GH_TOKEN missing — push and PR creation will fail'} />
                        <Row k="git" v={s.git.version ?? 'not found'} />
                    </Section>
                    <Section title="Telegram">
                        <Row k="Allowed user ids" v={s.telegram.allowed_user_ids.join(', ')} mono />
                        <Row k="Voice input" v={s.stt.enabled ? `${s.stt.model}${s.stt.language ? ` · ${s.stt.language}` : ' · autodetect'}` : 'disabled (GROQ_API_KEY missing)'} />
                    </Section>
                    <Section title="Paths">
                        <Row k="Data" v={s.paths.data} mono />
                        <Row k="Workspaces" v={s.paths.workspaces} mono />
                        <Row k="Config" v={s.paths.config} mono />
                    </Section>
                    <Section title={`Workspaces (${s.workspaces.length})`}>
                        <div className="row wrap">
                            {s.workspaces.map((w) => (
                                <span key={w.name} className="badge tag" title={w.git ? 'git repository' : 'not a git repository'}>
                                    {w.git ? '' : '⚠ '}
                                    {w.name}
                                </span>
                            ))}
                        </div>
                    </Section>
                </div>
            )}
        </div>
    )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="card">
            <h3 style={{ marginTop: 0 }}>{title}</h3>
            {children}
        </div>
    )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
    return (
        <div className="row" style={{ padding: '4px 0' }}>
            <span className="dim" style={{ width: 180, flexShrink: 0 }}>
                {k}
            </span>
            <span className={mono ? 'mono small' : ''}>{v}</span>
        </div>
    )
}
