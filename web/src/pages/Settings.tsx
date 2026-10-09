import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { HostsSection } from '../components/Hosts'
import { McpLoginDialog } from '../components/McpLogin'
import { McpServersField } from '../components/McpServers'
import { SecuritySection } from '../components/Security'
import { ToolchainsSection } from '../components/Toolchains'
import { Button, ErrorBox, PageHead, useToast } from '../components/ui'
import { type McpEntry, type McpOverview, type McpServerConfig } from '../lib/api'
import { api } from '../lib/api'
import { onThemeChange, setTheme, THEME_CHOICES, themeChoice } from '../lib/theme'
import { setUnsaved } from '../lib/unsaved'
import { useAsync } from '../lib/useAsync'

export function SettingsPage() {
    const status = useAsync(() => api.status(), [], 10_000)
    const mcp = useAsync(() => api.mcp(), [], 30_000)
    const toolchains = useAsync(() => api.toolchains(), [], 60_000)
    const s = status.data
    // `/settings#hosts` opens the page scrolled to that section (the links "Edit in Settings", "Settings → MCP").
    // The sections exist only once the status has loaded, and the MCP list above Hosts grows when its
    // data lands, so the scroll repeats on each of those until the layout is settled.
    // The glow is a class, not `:target`: the router changes the hash with pushState, which browsers do not
    // count as a fragment navigation, so `:target` never matches. Once the MCP data is in, the layout is
    // settled and the hash is done: the polls that refresh `s` and `mcp.data` every few seconds must not
    // scroll or glow again.
    const { hash } = useLocation()
    const settled = useRef<string | null>(null)
    useEffect(() => {
        if (!hash || !s || settled.current === hash) return
        const el = document.getElementById(hash.slice(1))
        if (!el) return
        el.scrollIntoView({ block: 'start' })
        el.classList.remove('flash')
        void el.offsetWidth // restart the animation when the same section is targeted again
        el.classList.add('flash')
        const timer = setTimeout(() => el.classList.remove('flash'), 2200)
        if (mcp.data) settled.current = hash
        return () => clearTimeout(timer)
    }, [hash, s, mcp.data])
    return (
        <div className='page'>
            <PageHead
                title='Settings'
                sub='The running configuration. The model is chosen here (or with /model in Telegram); the rest comes from .env — edit it on the host and restart the container.'
            />
            <ErrorBox error={status.error} />
            {s && (
                <div className='stack'>
                    <Section
                        id='claude'
                        title='Claude Code'
                    >
                        <Row
                            k='CLI'
                            v={s.claude.version ?? 'not found'}
                        />
                        <Row
                            k='Login'
                            v={
                                s.claude.login === 'token'
                                    ? 'CLAUDE_CODE_OAUTH_TOKEN — model calls only, no claude.ai connectors'
                                    : s.claude.login === 'none'
                                      ? 'not logged in — docker compose run --rm -it supervisor claude auth login'
                                      : s.claude.login
                            }
                        />
                        <ModelRow
                            model={s.claude.model}
                            onSaved={status.reload}
                        />
                        <Row
                            k='Permission mode'
                            v={s.claude.permission_mode}
                        />
                        <Row
                            k='Caps per task'
                            v={`${s.claude.max_turns} turns; no dollar budget, the subscription's windows are the limit`}
                        />
                        <Row
                            k='Concurrent sessions'
                            v={String(s.max_concurrent_sessions)}
                        />
                        <Row
                            k='Config dir'
                            v={s.claude.config_dir}
                            mono
                        />
                    </Section>
                    <Section
                        id='appearance'
                        title='Appearance'
                    >
                        <ThemeRow />
                    </Section>
                    <Section
                        id='security'
                        title='Security'
                    >
                        <SecuritySection telegram={s.telegram.enabled} />
                    </Section>
                    <Section
                        id='github'
                        title='GitHub'
                    >
                        <Row
                            k='gh CLI'
                            v={s.github.cli ?? 'not found'}
                        />
                        <Row
                            k='Default token'
                            v={
                                s.github.token
                                    ? 'GH_TOKEN set (fine-grained PAT)'
                                    : s.github.owners.length
                                      ? 'GH_TOKEN not set — only the owners below'
                                      : 'GH_TOKEN missing — push and PR creation will fail'
                            }
                        />
                        <Row
                            k='Owner tokens'
                            v={
                                s.github.owners.length
                                    ? s.github.owners.map((o) => `GH_TOKEN_${o.toUpperCase()}`).join(', ')
                                    : 'none — one GH_TOKEN_<OWNER> per user / organization'
                            }
                            mono
                        />
                        <Row
                            k='git'
                            v={s.git.version ?? 'not found'}
                        />
                    </Section>
                    <Section
                        id='telegram'
                        title='Telegram'
                    >
                        <Row
                            k='Bot'
                            v={
                                s.telegram.enabled
                                    ? 'enabled (long polling)'
                                    : 'disabled — TELEGRAM_BOT_TOKEN not set, web only'
                            }
                        />
                        <Row
                            k='Allowed user ids'
                            v={s.telegram.allowed_user_ids.join(', ')}
                            mono
                        />
                        <Row
                            k='Voice input'
                            v={
                                s.stt.enabled
                                    ? `${s.stt.model}${s.stt.language ? ` · ${s.stt.language}` : ' · autodetect'}`
                                    : 'disabled (GROQ_API_KEY missing)'
                            }
                        />
                    </Section>
                    <Section
                        id='mcp'
                        title='MCP servers'
                    >
                        <McpSection
                            data={mcp.data}
                            error={mcp.error}
                            onSaved={mcp.reload}
                        />
                    </Section>
                    <Section
                        id='toolchains'
                        title='Toolchains'
                    >
                        <ToolchainsSection
                            data={toolchains.data}
                            error={toolchains.error}
                            onChanged={toolchains.reload}
                        />
                    </Section>
                    <Section
                        id='hosts'
                        title='Hosts'
                    >
                        <HostsSection />
                    </Section>
                    <Section
                        id='paths'
                        title='Paths'
                    >
                        <Row
                            k='Data'
                            v={s.paths.data}
                            mono
                        />
                        <Row
                            k='Workspaces'
                            v={s.paths.workspaces}
                            mono
                        />
                        <Row
                            k='Config'
                            v={s.paths.config}
                            mono
                        />
                    </Section>
                    <Section
                        id='workspaces'
                        title={`Workspaces (${s.workspaces.length})`}
                    >
                        <div className='row wrap'>
                            {s.workspaces.map((w) => (
                                <span
                                    key={w.name}
                                    className='badge plain'
                                    title={w.git ? 'git repository' : 'not a git repository'}
                                >
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

/** `connected` → green, `needs-auth` → amber, `failed` → red, anything else grey. */
const tone = (status: string) =>
    status === 'connected' ? 'done' : status === 'needs-auth' ? 'queued' : status === 'failed' ? 'failed' : 'cancelled'
/** `claude mcp login` knows connectors and project servers; a plugin's stdio server has no sign-in and the owner's own file is not on its list. */
const canSignIn = (s: McpEntry) => s.status !== 'connected' && s.source !== 'plugin' && s.source !== 'factory'
const sourceLabel = (source: string | null) =>
    source === 'connector'
        ? 'claude.ai connector'
        : source === 'plugin'
          ? 'plugin'
          : source === 'factory'
            ? 'data/config/mcp.json'
            : source?.startsWith('project:')
              ? `project ${source.slice(8)}`
              : (source ?? 'seen in a session')

/**
 * One list for everything the agents can reach: the claude.ai connectors of the
 * account, synced plugins, the servers of project checkouts and the owner's own,
 * each with the status the CLI last reported. Session starts update it for
 * free; Refresh asks the CLI (`claude mcp list`) and also lists the servers
 * that still need authentication. The owner's own file stays editable below.
 */
function McpSection({ data, error, onSaved }: { data: McpOverview | undefined; error?: string; onSaved: () => void }) {
    const [busy, setBusy] = useState(false)
    const [refreshError, setRefreshError] = useState<string | null>(null)
    // The server whose sign-in dialog is open.
    const [signingIn, setSigningIn] = useState<McpEntry | null>(null)
    // A failed poll must not unmount the editor (and the owner's draft with it): the error shows above it.
    if (!data) return error ? <div className='error small'>{error}</div> : <div className='dim small'>…</div>
    const refresh = async () => {
        setBusy(true)
        setRefreshError(null)
        try {
            await api.refreshMcp()
            onSaved()
        } catch (e) {
            setRefreshError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    // A project or factory server with a connector's URL is that connector under another name: one row, with the other names on it.
    const twins = new Map<string, McpEntry[]>()
    for (const s of data.servers)
        if (s.duplicate_of) twins.set(s.duplicate_of, [...(twins.get(s.duplicate_of) ?? []), s])
    const servers = data.servers.filter((s) => !s.duplicate_of)
    const connected = servers.filter((s) => s.status === 'connected').length
    return (
        <div className='stack'>
            {error && <div className='error small'>{error}</div>}
            <div className='row between wrap'>
                <span className='dim small'>
                    {servers.length ? `${connected} of ${servers.length} authorized` : 'No servers seen yet'} ·
                    Authorize starts the sign-in from here (a connector can also be authorized at claude.ai → Settings →
                    Connectors)
                </span>
                <Button
                    size='sm'
                    onClick={refresh}
                    disabled={busy}
                    title='Runs `claude mcp list` in the factory; takes about 15 seconds'
                >
                    {busy ? 'Asking the CLI…' : 'Refresh statuses'}
                </Button>
            </div>
            {refreshError && <div className='error small'>{refreshError}</div>}
            {servers.length > 0 && (
                <div className='mcp-list'>
                    {[...servers]
                        .sort(
                            (a, b) =>
                                Number(b.status === 'connected') - Number(a.status === 'connected') ||
                                a.label.localeCompare(b.label)
                        )
                        .map((s) => (
                            <div
                                key={s.key}
                                className='mcp-row'
                            >
                                <span className='grow'>
                                    <strong>{s.label}</strong>{' '}
                                    <span className='dim small'>· {sourceLabel(s.source)}</span>
                                    {twins.get(s.key)?.map((t) => (
                                        <span
                                            key={t.key}
                                            className='dim small'
                                            title={`${t.name} in ${sourceLabel(t.source)} has the same URL: it is this server, and the connector already serves every session`}
                                        >
                                            {' '}
                                            · also <code>{t.name}</code> in {sourceLabel(t.source)}
                                        </span>
                                    ))}
                                </span>
                                <span className='dim small'>{s.tools ? `${s.tools} tools` : ''}</span>
                                <span className={`badge ${tone(s.status)}`}>
                                    {s.status === 'needs-auth' ? 'needs authentication' : s.status}
                                </span>
                                {canSignIn(s) && (
                                    <Button
                                        size='sm'
                                        onClick={() => setSigningIn(s)}
                                        title={`Runs \`claude mcp login\` in the factory and shows the sign-in link`}
                                    >
                                        Authorize
                                    </Button>
                                )}
                            </div>
                        ))}
                </div>
            )}
            {signingIn && (
                <McpLoginDialog
                    server={signingIn}
                    onClose={() => setSigningIn(null)}
                    onChanged={onSaved}
                />
            )}
            <details className='tool-more'>
                <summary className='dim'>
                    Your own servers — {data.global.file} ({data.global.servers.length}); every session loads them
                </summary>
                <div style={{ marginTop: 10 }}>
                    <McpEditor
                        file={data.global.file}
                        config={data.global.config}
                        fileError={data.global.error}
                        onSaved={onSaved}
                    />
                </div>
            </details>
        </div>
    )
}

function McpEditor({
    file,
    config,
    fileError,
    onSaved
}: {
    file: string
    config: Record<string, McpServerConfig>
    fileError: string | null
    onSaved: () => void
}) {
    const [servers, setServers] = useState(config)
    // The server state the edits are measured against, not the polled prop.
    const [seed, setSeed] = useState(() => JSON.stringify(config))
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [toast, showToast] = useToast()
    const dirty = JSON.stringify(servers) !== seed

    useEffect(() => {
        setUnsaved(dirty)
        return () => setUnsaved(false)
    }, [dirty])

    // A poll (or the reload after a save) brings the file as it is on disk — possibly changed by an
    // agent. An untouched form follows it; a form with edits keeps them.
    useEffect(() => {
        if (dirty) return
        const fresh = JSON.stringify(config)
        if (fresh === seed) return
        setServers(config)
        setSeed(fresh)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config])

    const save = async () => {
        setBusy(true)
        setError(null)
        try {
            await api.saveMcp(servers)
            setSeed(JSON.stringify(servers))
            showToast(`Saved ${file}`)
            onSaved()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='stack'>
            <div className='row between wrap'>
                <span className='dim small mono'>{file}</span>
                <Button
                    size='sm'
                    variant='primary'
                    onClick={save}
                    disabled={busy || !dirty}
                >
                    {busy ? 'Saving…' : 'Save'}
                </Button>
            </div>
            {fileError && (
                <div className='error small'>The file on disk is not valid JSON ({fileError}); saving replaces it.</div>
            )}
            {error && <div className='error small'>{error}</div>}
            <McpServersField
                value={servers}
                onChange={setServers}
                empty='No factory-wide servers yet. Add one: an HTTP server needs a URL, a stdio server a command; secrets only as ${VAR} with the value in .env.'
            />
            {toast}
        </div>
    )
}

/** A card with an anchor: `/settings#<id>` scrolls to it, and the heading is a link to itself, so a section can be shared. */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
    return (
        <div
            className='card section'
            id={id}
        >
            <h3 style={{ marginTop: 0 }}>
                <a
                    href={`#${id}`}
                    className='anchor'
                >
                    {title}
                </a>
            </h3>
            {children}
        </div>
    )
}

/**
 * The orchestrator's model: one alias for the whole factory, applied to the next task in every
 * conversation (a running task keeps its own); the same value Telegram `/model` sets. Sub-agents keep
 * the `model:` of their files, `inherit` among them follows this one. The list is the CLI's aliases,
 * which it resolves to the subscription's current model of that tier.
 */
/** Light / dark / system for this browser; the sidebar's sun / moon flips between the first two. */
function ThemeRow() {
    const [choice, setChoice] = useState(themeChoice)
    // The sidebar's sun / moon changes the choice too: follow it.
    useEffect(() => onThemeChange(() => setChoice(themeChoice())), [])
    const pick = (value: (typeof THEME_CHOICES)[number]['value']) => {
        setTheme(value)
        setChoice(value)
    }
    return (
        <div className='kv'>
            <span>Theme</span>
            <span
                className='row wrap'
                style={{ gap: 10 }}
            >
                <span
                    className='row'
                    style={{ gap: 4 }}
                    role='radiogroup'
                    aria-label='Theme'
                >
                    {THEME_CHOICES.map((t) => (
                        <Button
                            key={t.value}
                            size='sm'
                            className={`chip${choice === t.value ? ' on' : ''}`}
                            role='radio'
                            aria-checked={choice === t.value}
                            title={t.hint}
                            onClick={() => pick(t.value)}
                        >
                            {t.label}
                        </Button>
                    ))}
                </span>
                <span className='dim small'>
                    this browser only, kept in its storage; the sun / moon in the sidebar foot flips between light and
                    dark
                </span>
            </span>
        </div>
    )
}

function ModelRow({ model, onSaved }: { model: string; onSaved: () => void }) {
    const [toast, showToast] = useToast()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const change = async (value: string) => {
        setBusy(true)
        setError(null)
        try {
            const saved = await api.setModel(value)
            showToast(`Model: ${saved.model} from the next task on`)
            onSaved()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }
    return (
        <div className='kv'>
            <span>Model</span>
            <span
                className='row wrap'
                style={{ gap: 10 }}
            >
                <select
                    value={model}
                    disabled={busy}
                    onChange={(e) => void change(e.target.value)}
                    aria-label='Orchestrator model'
                >
                    {MODEL_ALIASES.map((a) => (
                        <option
                            key={a.value}
                            value={a.value}
                        >
                            {a.label}
                        </option>
                    ))}
                </select>
                <span className='dim small'>
                    the orchestrator, every next task in every chat; sub-agents keep their own
                </span>
                {error && (
                    <span
                        className='small'
                        style={{ color: 'var(--red)' }}
                    >
                        {error}
                    </span>
                )}
                {toast}
            </span>
        </div>
    )
}

const MODEL_ALIASES: Array<{ value: string; label: string }> = [
    { value: 'sonnet', label: 'sonnet — current Sonnet' },
    { value: 'opus', label: 'opus — current Opus' },
    { value: 'haiku', label: 'haiku — current Haiku' },
    { value: 'fable', label: 'fable — current Fable (Max plans)' }
]

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
    return (
        <div className='kv'>
            <span>{k}</span>
            <span className={mono ? 'mono' : ''}>{v}</span>
        </div>
    )
}
