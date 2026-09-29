import { useEffect, useState } from 'react'

import { Button, ErrorBox, PageHead, useToast } from '../components/ui'
import { type McpOverview, type McpServer, type McpServerConfig, type McpStatus } from '../lib/api'
import { api } from '../lib/api'
import { setUnsaved } from '../lib/unsaved'
import { useAsync } from '../lib/useAsync'

export function SettingsPage() {
    const status = useAsync(() => api.status(), [], 10_000)
    const mcp = useAsync(() => api.mcp(), [], 30_000)
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
                        <Row k="Caps per task" v={`${s.claude.max_turns} turns · $${s.claude.max_budget_usd} by the CLI's list-price estimate (a safety stop, not a bill)`} />
                        <Row k="Concurrent sessions" v={String(s.max_concurrent_sessions)} />
                        <Row k="Config dir" v={s.claude.config_dir} mono />
                    </Section>
                    <Section title="GitHub">
                        <Row k="gh CLI" v={s.github.cli ?? 'not found'} />
                        <Row k="Default token" v={s.github.token ? 'GH_TOKEN set (fine-grained PAT)' : s.github.owners.length ? 'GH_TOKEN not set — only the owners below' : 'GH_TOKEN missing — push and PR creation will fail'} />
                        <Row k="Owner tokens" v={s.github.owners.length ? s.github.owners.map((o) => `GH_TOKEN_${o.toUpperCase()}`).join(', ') : 'none — one GH_TOKEN_<OWNER> per user / organization'} mono />
                        <Row k="git" v={s.git.version ?? 'not found'} />
                    </Section>
                    <Section title="Telegram">
                        <Row k="Bot" v={s.telegram.enabled ? 'enabled (long polling)' : 'disabled — TELEGRAM_BOT_TOKEN not set, web only'} />
                        <Row k="Allowed user ids" v={s.telegram.allowed_user_ids.join(', ')} mono />
                        <Row k="Voice input" v={s.stt.enabled ? `${s.stt.model}${s.stt.language ? ` · ${s.stt.language}` : ' · autodetect'}` : 'disabled (GROQ_API_KEY missing)'} />
                    </Section>
                    <Section title="MCP servers">
                        <McpSection data={mcp.data} error={mcp.error} onSaved={mcp.reload} />
                    </Section>
                    <Section title="Paths">
                        <Row k="Data" v={s.paths.data} mono />
                        <Row k="Workspaces" v={s.paths.workspaces} mono />
                        <Row k="Config" v={s.paths.config} mono />
                    </Section>
                    <Section title={`Workspaces (${s.workspaces.length})`}>
                        <div className="row wrap">
                            {s.workspaces.map((w) => (
                                <span key={w.name} className="badge plain" title={w.git ? 'git repository' : 'not a git repository'}>
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

/** `kept`: the API withheld this value, so an emptied field means "keep what is stored", not "clear it". */
type Pair = { k: string; v: string; kept?: boolean }
interface Draft {
    name: string
    type: 'http' | 'sse' | 'stdio'
    url: string
    command: string
    args: string
    headers: Pair[]
    env: Pair[]
}

const KEPT = '<kept>'
const isRef = (v: string) => /\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/.test(v)
const pairs = (record?: Record<string, string>): Pair[] => Object.entries(record ?? {}).map(([k, v]) => ({ k, v, kept: v === KEPT }))
const record = (list: Pair[]): Record<string, string> | undefined => {
    const entries = list.filter((p) => p.k.trim()).map((p) => [p.k.trim(), p.v] as const)
    return entries.length ? Object.fromEntries(entries) : undefined
}
const toDraft = (name: string, c: McpServerConfig): Draft => ({
    name,
    type: c.type ?? (c.command ? 'stdio' : 'http'),
    url: c.url ?? '',
    command: c.command ?? '',
    args: (c.args ?? []).join(' '),
    headers: pairs(c.headers),
    env: pairs(c.env)
})
const fromDraft = (d: Draft): McpServerConfig =>
    d.type === 'stdio'
        ? { type: 'stdio', command: d.command, args: d.args.trim() ? d.args.trim().split(/\s+/) : undefined, env: record(d.env) }
        : { type: d.type, url: d.url, headers: record(d.headers), env: record(d.env) }
const draftsOf = (config: Record<string, McpServerConfig>): Draft[] => Object.entries(config).map(([name, c]) => toDraft(name, c))

/**
 * Servers as the factory sees them: the owner's own from data/config/mcp.json,
 * editable here (every session gets them), and each project's .mcp.json
 * (sessions bound to it), read-only. Header / env values that are not
 * `${VAR}` references never come back from the API: they show as kept and
 * stay unless replaced.
 */
function McpSection({ data, error, onSaved }: { data: McpOverview | undefined; error?: string; onSaved: () => void }) {
    // A failed poll must not unmount the editor (and the owner's draft with it): the error shows above it.
    if (!data) return error ? <div className="error small">{error}</div> : <div className="dim small">…</div>
    return (
        <div className="stack">
            {error && <div className="error small">{error}</div>}
            <McpEditor file={data.global.file} config={data.global.config} status={data.global.last_session} fileError={data.global.error} onSaved={onSaved} />
            {data.projects.filter((p) => p.servers.length || p.error).map((p) => (
                <div key={p.slug}>
                    <div className="small">
                        <strong>{p.slug}</strong> <span className="dim mono">{p.path}/.mcp.json</span>
                        {!p.checkout && <span className="badge failed" style={{ marginLeft: 8 }}>checkout missing</span>}
                    </div>
                    {p.error && <div className="error small">{p.error}</div>}
                    <McpList servers={p.servers} status={p.last_session} />
                </div>
            ))}
        </div>
    )
}

function McpEditor({ file, config, status, fileError, onSaved }: { file: string; config: Record<string, McpServerConfig>; status: McpStatus[] | null; fileError: string | null; onSaved: () => void }) {
    const [drafts, setDrafts] = useState<Draft[]>(() => draftsOf(config))
    // The server state the drafts were last taken from; edits are measured against it, not the polled prop.
    const [seed, setSeed] = useState(() => JSON.stringify(draftsOf(config)))
    const [json, setJson] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [toast, showToast] = useToast()
    const dirty = JSON.stringify(drafts) !== seed
    const editing = dirty || json !== null
    const update = (i: number, patch: Partial<Draft>) => setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)))
    /** Adopt a saved or parsed set of servers as the clean state. */
    const adopt = (servers: Record<string, McpServerConfig>) => {
        const next = draftsOf(servers)
        setDrafts(next)
        setSeed(JSON.stringify(next))
    }

    useEffect(() => {
        setUnsaved(editing)
        return () => setUnsaved(false)
    }, [editing])

    // A poll (or the reload after a save) brings the file as it is on disk — possibly changed by an
    // agent. An untouched form follows it; a form with edits keeps them.
    useEffect(() => {
        if (editing) return
        const fresh = draftsOf(config)
        const stamp = JSON.stringify(fresh)
        if (stamp === seed) return
        setDrafts(fresh)
        setSeed(stamp)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config])

    const save = async () => {
        setBusy(true)
        setError(null)
        try {
            let servers: Record<string, McpServerConfig>
            if (json !== null) {
                const parsed = JSON.parse(json) as { mcpServers?: Record<string, McpServerConfig> } | Record<string, McpServerConfig>
                servers = ('mcpServers' in parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : parsed) as Record<string, McpServerConfig>
            } else {
                servers = Object.fromEntries(drafts.map((d) => [d.name.trim(), fromDraft(d)]))
            }
            await api.saveMcp(servers)
            adopt(servers)
            setJson(null)
            showToast(`Saved ${file}`)
            onSaved()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const toggleJson = () => {
        if (json === null) setJson(JSON.stringify({ mcpServers: Object.fromEntries(drafts.map((d) => [d.name, fromDraft(d)])) }, null, 2))
        else {
            try {
                const parsed = JSON.parse(json) as { mcpServers?: Record<string, McpServerConfig> }
                setDrafts(draftsOf(parsed.mcpServers ?? {}))
                setJson(null)
                setError(null)
            } catch (e) {
                setError(`JSON: ${(e as Error).message}`)
            }
        }
    }

    return (
        <div className="stack">
            <div className="row between wrap">
                <span className="dim small mono">{file}</span>
                <span className="row">
                    <Button size="sm" onClick={toggleJson}>
                        {json === null ? 'Edit as JSON' : 'Back to the form'}
                    </Button>
                    <Button size="sm" onClick={() => setDrafts((prev) => [...prev, { name: '', type: 'http', url: '', command: '', args: '', headers: [], env: [] }])} disabled={json !== null}>
                        Add server
                    </Button>
                    <Button size="sm" variant="primary" onClick={save} disabled={busy || (!dirty && json === null)}>
                        {busy ? 'Saving…' : 'Save'}
                    </Button>
                </span>
            </div>
            {fileError && <div className="error small">The file on disk is not valid JSON ({fileError}); saving replaces it.</div>}
            {error && <div className="error small">{error}</div>}
            {json !== null ? (
                <textarea className="mono" value={json} onChange={(e) => setJson(e.target.value)} rows={12} spellCheck={false} />
            ) : drafts.length === 0 ? (
                <div className="dim small">No factory-wide servers yet. Add one: an HTTP server needs a URL, a stdio server a command; secrets only as {'${VAR}'} with the value in .env.</div>
            ) : (
                drafts.map((d, i) => <McpCard key={i} draft={d} status={status?.find((s) => s.name === d.name)} onChange={(patch) => update(i, patch)} onRemove={() => setDrafts((prev) => prev.filter((_, j) => j !== i))} />)
            )}
            {toast}
        </div>
    )
}

function McpCard({ draft, status, onChange, onRemove }: { draft: Draft; status: McpStatus | undefined; onChange: (patch: Partial<Draft>) => void; onRemove: () => void }) {
    const tone = (s: string) => (s === 'connected' ? 'done' : s === 'needs-auth' ? 'queued' : s === 'failed' ? 'failed' : 'cancelled')
    return (
        <div className="host-card">
            <label className="field">
                <span>Name</span>
                <input className="mono" placeholder="trac" value={draft.name} onChange={(e) => onChange({ name: e.target.value })} />
            </label>
            <label className="field">
                <span>Type</span>
                <select value={draft.type} onChange={(e) => onChange({ type: e.target.value as Draft['type'] })}>
                    <option value="http">http (remote)</option>
                    <option value="sse">sse (remote, legacy)</option>
                    <option value="stdio">stdio (a command in the container)</option>
                </select>
            </label>
            {draft.type === 'stdio' ? (
                <>
                    <label className="field">
                        <span>Command</span>
                        <input className="mono" placeholder="npx" value={draft.command} onChange={(e) => onChange({ command: e.target.value })} />
                    </label>
                    <label className="field">
                        <span>Arguments</span>
                        <input className="mono" placeholder="-y @example/mcp-server" value={draft.args} onChange={(e) => onChange({ args: e.target.value })} />
                    </label>
                </>
            ) : (
                <label className="field" style={{ gridColumn: 'span 2' }}>
                    <span>URL</span>
                    <input className="mono" placeholder="https://mcp.example.com/mcp" value={draft.url} onChange={(e) => onChange({ url: e.target.value })} />
                </label>
            )}
            {draft.type !== 'stdio' && <PairsField label="Headers" hint="Authorization: Bearer ${MY_TOKEN}" list={draft.headers} onChange={(headers) => onChange({ headers })} />}
            <PairsField label="Environment" hint="API_KEY = ${MY_API_KEY}" list={draft.env} onChange={(env) => onChange({ env })} />
            <div className="host-foot wide">
                {status && <span className={`badge ${tone(status.status)}`}>{status.status} in the last session</span>}
                <span className="grow" />
                <Button size="sm" variant="danger" onClick={onRemove}>
                    Remove
                </Button>
            </div>
        </div>
    )
}

/** Key / value rows for headers or env; a literal value that is not a `${VAR}` reference is flagged, a withheld one shows as kept. */
function PairsField({ label, hint, list, onChange }: { label: string; hint: string; list: Pair[]; onChange: (list: Pair[]) => void }) {
    const set = (i: number, patch: Partial<Pair>) => onChange(list.map((p, j) => (j === i ? { ...p, ...patch } : p)))
    return (
        <div className="field wide">
            <span>
                {label} <span className="dim">· {hint}</span>
            </span>
            {list.map((p, i) => (
                <div key={i} className="row">
                    <input className="mono" style={{ flex: 1 }} placeholder="name" value={p.k} onChange={(e) => set(i, { k: e.target.value })} />
                    <input className="mono" style={{ flex: 2 }} placeholder="${VAR}" value={p.v === KEPT ? '' : p.v} onChange={(e) => set(i, { v: e.target.value || (p.kept ? KEPT : '') })} />
                    {p.v === KEPT ? <span className="badge plain">stored value kept</span> : p.v && !isRef(p.v) ? <span className="badge plain amber" title="A literal value is written to mcp.json in clear; put it in .env and reference it as ${VAR}.">literal</span> : null}
                    <Button size="sm" variant="ghost" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label="Remove row">
                        ×
                    </Button>
                </div>
            ))}
            <div>
                <Button size="sm" onClick={() => onChange([...list, { k: '', v: '' }])}>
                    Add {label.toLowerCase() === 'headers' ? 'header' : 'variable'}
                </Button>
            </div>
        </div>
    )
}

function McpList({ servers, status }: { servers: Array<McpServer & { enabled?: boolean }>; status: McpStatus[] | null }) {
    const tone = (s: string) => (s === 'connected' ? 'done' : s === 'needs-auth' ? 'queued' : s === 'failed' ? 'failed' : 'cancelled')
    return (
        <div>
            {servers.map((server) => {
                const seen = status?.find((s) => s.name === server.name)
                return (
                    <div key={server.name} className="kv">
                        <span>
                            {server.name} <span className="dim">{server.type}</span>
                        </span>
                        <span className="row wrap small">
                            <span className="mono dim">{server.target}</span>
                            {server.enabled === false && <span className="badge plain">off for this project</span>}
                            {seen && <span className={`badge ${tone(seen.status)}`}>{seen.status}</span>}
                            {server.variables.map((v) => (
                                <span key={v.name} className={`badge plain ${v.set ? 'green' : 'red'}`} title={v.set ? 'set in the environment' : 'missing — add it to .env'}>
                                    {'${' + v.name + '}'} {v.set ? 'set' : 'missing'}
                                </span>
                            ))}
                        </span>
                    </div>
                )
            })}
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
        <div className="kv">
            <span>{k}</span>
            <span className={mono ? 'mono' : ''}>{v}</span>
        </div>
    )
}
