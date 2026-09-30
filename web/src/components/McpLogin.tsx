import { useEffect, useRef, useState } from 'react'

import { api, type McpEntry, type McpLogin } from '../lib/api'
import { Modal } from './Modal'
import { Button } from './ui'

/**
 * The sign-in window for an MCP server: runs `claude mcp login <name>` in the
 * factory through the API and shows the authorization link. A claude.ai
 * connector is authorized on claude.ai, and the window ends with "Refresh
 * statuses". A project's OAuth server sends the browser, after approval, to
 * an address on localhost that cannot load from the laptop: the owner copies
 * it from the address bar and pastes it here, and the CLI finishes the
 * exchange. The window polls while the CLI waits (on the host, the CLI's own
 * callback may finish the sign-in without a paste) and cancels the sign-in
 * when closed early.
 */
export function McpLoginDialog({ server, onClose, onChanged }: { server: McpEntry; onClose: () => void; onChanged: () => void }) {
    const [login, setLogin] = useState<McpLogin | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [pasted, setPasted] = useState('')
    const [busy, setBusy] = useState(false)
    const [copied, setCopied] = useState(false)
    const loginRef = useRef<McpLogin | null>(null)
    loginRef.current = login
    const open = login?.state === 'starting' || login?.state === 'waiting'

    // Start once; cancel on unmount while the CLI still waits.
    useEffect(() => {
        let alive = true
        api.startMcpLogin(server.name)
            .then(({ login }) => alive && setLogin(login))
            .catch((e: Error) => alive && setError(e.message))
        return () => {
            alive = false
            const current = loginRef.current
            if (current && (current.state === 'starting' || current.state === 'waiting')) void api.cancelMcpLogin(current.id).catch(() => {})
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [server.name])

    // Follow the CLI while it waits.
    useEffect(() => {
        if (!login || !open) return
        const timer = setInterval(() => {
            api.mcpLogin(login.id)
                .then(({ login }) => setLogin(login))
                .catch(() => {})
        }, 2000)
        return () => clearInterval(timer)
    }, [login?.id, open]) // eslint-disable-line react-hooks/exhaustive-deps

    // A finished redirect sign-in changed the server's status: reload the list behind the window.
    useEffect(() => {
        if (login?.state === 'done' && login.mode === 'redirect') onChanged()
    }, [login?.state, login?.mode]) // eslint-disable-line react-hooks/exhaustive-deps

    const complete = async () => {
        if (!login || !pasted.trim()) return
        setBusy(true)
        setError(null)
        try {
            const { login: next } = await api.completeMcpLogin(login.id, pasted.trim())
            setLogin(next)
            setPasted('')
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const refresh = async () => {
        setBusy(true)
        setError(null)
        try {
            await api.refreshMcp()
            onChanged()
            onClose()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const copy = async () => {
        if (!login?.url) return
        try {
            await navigator.clipboard.writeText(login.url)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            // no clipboard on plain http from another host: the link itself is still there
        }
    }

    const finished = login?.state === 'done' || login?.state === 'failed' || login?.state === 'cancelled'
    const footer =
        login?.mode === 'connector' && login.state === 'done' ? (
            <>
                <Button onClick={onClose} disabled={busy}>
                    Later
                </Button>
                <Button variant="primary" onClick={refresh} disabled={busy}>
                    {busy ? 'Asking the CLI…' : 'Refresh statuses'}
                </Button>
            </>
        ) : login?.state === 'waiting' ? (
            <>
                <Button onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
                <Button variant="primary" onClick={complete} disabled={busy || !pasted.trim()}>
                    {busy ? 'Completing…' : 'Complete sign-in'}
                </Button>
            </>
        ) : (
            <Button onClick={onClose} disabled={busy} data-autofocus={finished || undefined}>
                {finished || error ? 'Close' : 'Cancel'}
            </Button>
        )

    return (
        <Modal open onClose={onClose} title={`Authorize ${server.label}`} icon="key" busy={busy} closeButton={false} footer={footer}>
            <div className="stack" style={{ marginTop: 8 }}>
                {!login && !error && <div className="dim small">Asking the CLI for the sign-in link… (a few seconds)</div>}
                {login?.url && (
                    <div className="row wrap" style={{ gap: 8 }}>
                        <a href={login.url} target="_blank" rel="noopener noreferrer" data-autofocus>
                            Open the sign-in page ↗
                        </a>
                        <Button size="sm" onClick={copy}>
                            {copied ? 'Copied' : 'Copy link'}
                        </Button>
                    </div>
                )}
                {login?.state === 'starting' && login.url && <div className="dim small">Waiting for the CLI to say what comes next…</div>}
                {login?.mode === 'connector' && login.state === 'done' && (
                    <div className="modal-text">Sign in on claude.ai in that tab. Once it says the connector is connected, refresh the statuses here: the agents get its tools from the next session on.</div>
                )}
                {login?.state === 'waiting' && (
                    <>
                        <div className="modal-text">
                            After you approve, the browser is sent to an address starting with <code>http://localhost</code> that cannot load from here. Copy that whole address from the address bar and paste it below.
                        </div>
                        <input
                            className="mono"
                            value={pasted}
                            onChange={(e) => setPasted(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && void complete()}
                            placeholder="http://localhost:12345/callback?code=…&state=…"
                            spellCheck={false}
                            disabled={busy}
                        />
                    </>
                )}
                {login?.state === 'done' && login.mode === 'redirect' && <div className="small" style={{ color: 'var(--green)' }}>Authorized — {login.message}</div>}
                {login?.state === 'failed' && <div className="error small">{login.message ?? 'The sign-in failed'}</div>}
                {login?.state === 'cancelled' && <div className="dim small">{login.message ?? 'Cancelled.'}</div>}
                {error && (
                    <div className="error small modal-error" role="alert">
                        {error}
                    </div>
                )}
            </div>
        </Modal>
    )
}
