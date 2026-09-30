import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type HostKey, type HostsOverview, type HostTarget, type HostTest, type HostView, type InlineHost, isHostRef, type ProjectHost, type SharedHost, type SshKeys } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Modal, useConfirm } from './Modal'
import { Button, GrowingTextarea } from './ui'

/**
 * Shared SSH hosts, the way an IDE keeps SSH configurations once: the list
 * lives in Settings → Hosts (`data/config/hosts.yaml`), a project picks a
 * host from it and adds only what is its own (path, notes). The pieces here
 * serve both screens: the fields of a host, the connection test, the dialog
 * that creates one, the Settings list and the project form's section.
 */

const EMPTY: SharedHost = { name: '', ssh: '', key: '' }

/** The key in data/secrets/ssh that opens the host; the empty choice leaves it to ssh's own config. */
function KeySelect({ value, onChange, keys }: { value: string; onChange: (key: string) => void; keys: SshKeys | undefined }) {
    const names = keys?.keys ?? []
    return (
        <>
            <select value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">default (~/.ssh/config or id_*)</option>
                {value && !names.some((k) => k.name === value) && <option value={value}>{value} (missing)</option>}
                {names.map((k) => (
                    <option key={k.name} value={k.name}>
                        {k.name}
                    </option>
                ))}
            </select>
            {keys && names.length === 0 && <span className="dim">No keys yet: `ssh-keygen -t ed25519 -f data/secrets/ssh/id_ed25519 -C pocket-factory`, add the .pub to the host.</span>}
        </>
    )
}

/** The fields of a shared host — the connection only: a name, the target, the key. Paths and notes belong to the projects. */
export function HostFields({
    value,
    onChange,
    keys,
    autoFocus,
    compact
}: {
    value: SharedHost
    onChange: (patch: Partial<SharedHost>) => void
    keys: SshKeys | undefined
    autoFocus?: boolean
    compact?: boolean
}) {
    return (
        <div className={`host-card connection${compact ? ' compact' : ''}`}>
            <label className="field">
                <span>Name</span>
                <input placeholder="staging-eu" value={value.name} onChange={(e) => onChange({ name: e.target.value })} autoFocus={autoFocus} />
            </label>
            <label className="field">
                <span>SSH target</span>
                <input className="mono" placeholder="deploy@203.0.113.10 or deploy@host:2222" value={value.ssh} onChange={(e) => onChange({ ssh: e.target.value })} />
            </label>
            <label className="field">
                <span>Key</span>
                <KeySelect value={value.key ?? ''} onChange={(key) => onChange({ key })} keys={keys} />
            </label>
        </div>
    )
}

/**
 * "Test connection": `ssh -o BatchMode=yes … echo ok` for a target and key,
 * or for a shared host by name; the outcome sits next to the button. The one
 * failure the UI settles by itself is the server's key: when the server is
 * not in the factory's known_hosts yet (or its key changed), a second button
 * scans its keys, shows the fingerprints and, once confirmed, writes them and
 * runs the test again — no shell on the box that runs the factory.
 */
export function TestConnection({ target }: { target: HostTarget }) {
    const [test, setTest] = useState<{ busy: boolean } & Partial<HostTest>>({ busy: false })
    const [trusting, setTrusting] = useState(false)
    const confirm = useConfirm()
    const ready = 'name' in target ? Boolean(target.name) : Boolean(target.ssh.trim())
    const run = async () => {
        setTest({ busy: true })
        try {
            setTest({ busy: false, ...(await api.testHost(target)) })
        } catch (e) {
            setTest({ busy: false, ok: false, output: (e as Error).message })
        }
    }
    const changed = test.host_key === 'changed'
    const trust = async () => {
        setTrusting(true)
        try {
            const scan = await api.keyscanHost(target)
            const where = scan.port ? `${scan.host}:${scan.port}` : scan.host
            const done = await confirm({
                title: changed ? `Replace the host key of ${where}?` : `Trust ${where}?`,
                message: <Fingerprints keys={scan.keys} changed={changed} />,
                action: changed ? 'Replace key' : 'Trust',
                pending: 'Writing…',
                danger: changed,
                icon: 'host',
                onConfirm: async () => {
                    await api.trustHost(
                        target,
                        scan.keys.map((k) => k.line),
                        changed
                    )
                }
            })
            if (done) await run()
        } catch (e) {
            setTest({ busy: false, ok: false, output: (e as Error).message })
        } finally {
            setTrusting(false)
        }
    }
    return (
        <>
            <Button size="sm" onClick={run} disabled={test.busy || trusting || !ready} title="ssh -o BatchMode=yes <target> echo ok">
                {test.busy ? 'Connecting…' : 'Test connection'}
            </Button>
            {test.ok === true && <span className="badge done">reachable · {test.ms} ms</span>}
            {test.ok === false && <span className="badge failed">{changed ? 'host key changed' : test.host_key ? 'server not trusted yet' : 'failed'}</span>}
            {test.host_key && (
                <Button size="sm" variant={changed ? 'danger' : undefined} onClick={trust} disabled={trusting || test.busy} title="ssh-keyscan the server, show its fingerprints, write them to known_hosts once you confirm">
                    {trusting ? 'Scanning…' : changed ? 'Replace host key…' : 'Trust host key…'}
                </Button>
            )}
            {test.output && !test.host_key && (
                <code className="host-output" title={test.output}>
                    {test.output.split('\n').at(-1)}
                </code>
            )}
        </>
    )
}

/** The keys a server offers, for the owner to compare with what the server prints for itself before trusting them. */
function Fingerprints({ keys, changed }: { keys: HostKey[]; changed: boolean }) {
    return (
        <div className="stack">
            <span>
                {changed
                    ? 'The key on record differs from what the server offers now: a reinstalled server, or someone in between. Replace it only if you know why it changed.'
                    : 'The factory has not seen this server before. To be sure it is the right one, compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server:'}
            </span>
            <ul className="host-fingerprints">
                {keys.map((k) => (
                    <li key={k.fingerprint}>
                        <span className="badge plain">{k.type.replace(/^ssh-|-sha2/g, '').replace(/@openssh\.com$/, '')}</span>
                        <code>{k.fingerprint}</code>
                    </li>
                ))}
            </ul>
            <span className="dim small">Written to data/config/known_hosts; forgotten again once no host points at this server.</span>
        </div>
    )
}

/**
 * One window for a shared host: create it, edit it (`editing` = its current
 * name; a changed name renames it and the projects follow), or move a host
 * written inside a project file into the list. The host itself is the
 * connection; with `project` the dialog also carries the project's part —
 * its path and notes on that server — which stays in the project file.
 * Test connection sits in the footer, left of Cancel / Save, the way an IDE's
 * SSH configuration window does: it checks the whole form, not one field.
 */
export function HostDialog({
    open,
    title,
    initial,
    editing,
    keys,
    project,
    onClose,
    onSaved
}: {
    open: boolean
    title: string
    initial?: Partial<SharedHost>
    /** The saved name of the host being edited; absent when creating. */
    editing?: string
    keys: SshKeys | undefined
    /** Present = moving an inline host: the project's path and notes come along and stay with the project. */
    project?: { path?: string; notes?: string }
    onClose: () => void
    onSaved: (host: HostView, project: { path?: string; notes?: string }) => void
}) {
    const [host, setHost] = useState<SharedHost>({ ...EMPTY, ...initial })
    const [own, setOwn] = useState<{ path: string; notes: string }>({
        path: '',
        notes: ''
    })
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        if (open) {
            setHost({ ...EMPTY, ...initial })
            setOwn({ path: project?.path ?? '', notes: project?.notes ?? '' })
            setError(null)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open])
    const save = async () => {
        const name = host.name.trim()
        if (!name || !host.ssh.trim()) {
            setError('a name and an SSH target are required')
            return
        }
        setBusy(true)
        try {
            const saved = await api.saveHost(editing ?? name, {
                name,
                ssh: host.ssh,
                key: host.key
            })
            setError(null)
            onSaved(saved, {
                path: own.path.trim() || undefined,
                notes: own.notes.trim() || undefined
            })
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={title}
            icon="host"
            size="wide"
            description={
                project
                    ? 'The connection goes into the shared list (Settings → Hosts) and this project refers to it by name; the path and notes stay with the project.'
                    : editing
                      ? 'The connection every project on this server uses. A new name renames it in those projects too.'
                      : 'The connection is saved to Settings → Hosts; any project can pick it and add its own path and notes.'
            }
            busy={busy}
            footer={
                <>
                    <span className="modal-foot-aside">
                        <TestConnection target={{ ssh: host.ssh, key: host.key }} />
                    </span>
                    <Button onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button variant="primary" onClick={save} disabled={busy || !host.name.trim() || !host.ssh.trim()}>
                        {busy ? 'Saving…' : editing ? 'Save' : 'Save host'}
                    </Button>
                </>
            }
        >
            <div className="stack">
                <HostFields value={host} onChange={(patch) => setHost((h) => ({ ...h, ...patch }))} keys={keys} autoFocus compact />
                {project && (
                    <div className="host-card compact">
                        <div className="wide dim small">Stays with this project:</div>
                        <label className="field">
                            <span>Path for this project</span>
                            <input className="mono" placeholder="/srv/app" value={own.path} onChange={(e) => setOwn((o) => ({ ...o, path: e.target.value }))} />
                        </label>
                        <label className="field wide">
                            <span>Notes for this project</span>
                            <GrowingTextarea
                                placeholder="what runs there for this project, how deploys work, where the logs are, what never to touch"
                                value={own.notes}
                                onChange={(e) => setOwn((o) => ({ ...o, notes: e.target.value }))}
                            />
                        </label>
                    </div>
                )}
                {error && <div className="error small">{error}</div>}
            </div>
        </Modal>
    )
}

// ---- Settings → Hosts -------------------------------------------------------

/** Everything the factory can reach over SSH, with the projects on each server; add, edit, test and delete in one place. */
export function HostsSection() {
    const data = useAsync(() => api.hosts(), [], 30_000)
    const keys = useAsync(() => api.sshKeys(), [])
    const [dialog, setDialog] = useState<{ editing?: HostView } | null>(null)
    const confirm = useConfirm()
    const overview = data.data

    const remove = (h: HostView) =>
        void confirm({
            title: `Delete host ${h.name}?`,
            message: h.projects.length
                ? `${h.projects.map((p) => p.project).join(', ')} refer to it and lose the entry. The server itself is not touched; its key is forgotten unless another host uses it.`
                : 'It leaves the shared list; the server itself is not touched, and its key is forgotten unless another host uses it.',
            action: h.projects.length ? 'Delete and detach' : 'Delete',
            pending: 'Deleting…',
            danger: true,
            icon: 'delete',
            onConfirm: async () => {
                await api.deleteHost(h.name, true)
                data.reload()
            }
        })

    return (
        <div className="stack">
            {data.error && <div className="error small">{data.error}</div>}
            {overview?.error && <div className="error small">The file on disk is not valid YAML ({overview.error}); saving a host replaces it.</div>}
            <div className="row between wrap">
                <span className="dim small">
                    {overview ? (overview.hosts.length ? `${overview.hosts.length} shared host${overview.hosts.length === 1 ? '' : 's'}` : 'No shared hosts yet') : 'Loading…'} · connections only,
                    reached with the keys in {keys.data?.dir ?? 'data/secrets/ssh/'}; each project keeps its own path and notes · passwords are not supported on purpose
                </span>
                <Button size="sm" variant="primary" onClick={() => setDialog({})}>
                    Add host
                </Button>
            </div>
            {overview && overview.hosts.length > 0 && (
                <div className="host-list">
                    {overview.hosts.map((h) => (
                        <div key={h.name} className="host-row">
                            <span className="host-id">
                                <strong>{h.name}</strong>
                                {h.ssh ? <span className="mono dim small">{h.ssh}</span> : <span className="badge failed">not in hosts.yaml</span>}
                                {h.key && <span className="badge plain">key {h.key}</span>}
                            </span>
                            <span className="host-projects">
                                {h.projects.length === 0 && <span className="dim small">no project yet</span>}
                                {h.projects.map((p) => (
                                    <Link key={p.project} to={`/projects/${encodeURIComponent(p.project)}`} className="badge plain" title={p.path ? `path ${p.path}` : undefined}>
                                        {p.project}
                                    </Link>
                                ))}
                            </span>
                            <span className="host-actions">
                                {h.ssh && <TestConnection target={{ name: h.name }} />}
                                {h.ssh && (
                                    <Button size="sm" onClick={() => setDialog({ editing: h })}>
                                        Edit
                                    </Button>
                                )}
                                <Button size="sm" variant="danger" onClick={() => remove(h)}>
                                    Delete
                                </Button>
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {overview && overview.inline.length > 0 && (
                <details className="tool-more" open>
                    <summary className="dim">Written inside project files ({overview.inline.length}) — not shared; open the project to move one into the list</summary>
                    <div className="host-list" style={{ marginTop: 6 }}>
                        {overview.inline.map((i) => (
                            <div key={`${i.project}-${i.index}`} className="host-row">
                                <span className="host-id">
                                    <strong>{i.host.name || i.host.ssh || 'unnamed'}</strong>
                                    <span className="mono dim small">{i.host.ssh}</span>
                                    {i.host.key && <span className="badge plain">key {i.host.key}</span>}
                                    {i.same_as && <span className="dim small">· same as shared {i.same_as}</span>}
                                </span>
                                <span className="host-projects">
                                    <Link to={`/projects/${encodeURIComponent(i.project)}`} className="badge plain">
                                        {i.project}
                                    </Link>
                                </span>
                            </div>
                        ))}
                    </div>
                </details>
            )}
            <div className="dim small mono">{overview?.file}</div>
            <HostDialog
                open={dialog !== null}
                title={dialog?.editing ? `Edit host ${dialog.editing.name}` : 'New shared host'}
                initial={dialog?.editing}
                editing={dialog?.editing?.name}
                keys={keys.data}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null)
                    data.reload()
                }}
            />
        </div>
    )
}

// ---- Project form → Hosts --------------------------------------------------

/**
 * The project's hosts: shared ones picked by name (the card shows the server
 * and edits only the project's own path and notes), plus any host still
 * written inside this file, with a way to move or link it. "Add host" offers
 * the shared list and a new one.
 */
export function ProjectHosts({
    value,
    onChange,
    shared,
    onSharedChanged,
    keys
}: {
    value: ProjectHost[]
    onChange: (next: ProjectHost[]) => void
    shared: HostsOverview | undefined
    onSharedChanged: () => void
    keys: SshKeys | undefined
}) {
    const [dialog, setDialog] = useState<{
        index: number | null
        initial?: Partial<SharedHost>
        project?: { path?: string; notes?: string }
    } | null>(null)
    const attached = new Set(value.filter(isHostRef).map((h) => h.host))
    const available = (shared?.hosts ?? []).filter((h) => h.ssh && !attached.has(h.name))
    const update = (i: number, next: ProjectHost | null) => onChange(next ? value.map((h, j) => (j === i ? next : h)) : value.filter((_, j) => j !== i))

    return (
        <div className="field wide hosts">
            <div className="field-head">
                <span>
                    Hosts — servers this project runs on
                    <span className="dim"> · the connection is shared across projects (Settings → Hosts); path and notes are this project's</span>
                </span>
            </div>
            <select
                className="filter add-host"
                value=""
                aria-label="Add host"
                onChange={(e) => {
                    const pick = e.target.value
                    if (pick === '__new') setDialog({ index: null })
                    else if (pick) onChange([...value, { host: pick }])
                }}
            >
                <option value="">Add host…</option>
                {available.map((h) => (
                    <option key={h.name} value={h.name}>
                        {h.name} — {h.ssh}
                    </option>
                ))}
                <option value="__new">＋ New shared host…</option>
            </select>
            {value.length === 0 && <div className="dim small">No hosts. The agent can still work on the repository; host checks need at least one.</div>}
            {value.map((h, i) =>
                isHostRef(h) ? (
                    <SharedHostCard
                        key={`ref-${h.host}`}
                        entry={h}
                        host={shared?.hosts.find((s) => s.name === h.host)}
                        onChange={(patch) => update(i, { ...h, ...patch })}
                        onRemove={() => update(i, null)}
                    />
                ) : (
                    <InlineHostCard
                        key={`inline-${i}`}
                        host={h}
                        keys={keys}
                        sameAs={shared?.hosts.find((s) => s.ssh === (h.ssh ?? '').trim() && (s.key ?? '') === (h.key ?? ''))}
                        onChange={(patch) => update(i, { ...h, ...patch })}
                        onRemove={() => update(i, null)}
                        onMove={() =>
                            setDialog({
                                index: i,
                                initial: {
                                    name: h.name || (h.ssh ?? '').split('@').at(-1)?.split(':')[0],
                                    ssh: h.ssh,
                                    key: h.key
                                },
                                project: { path: h.path, notes: h.notes }
                            })
                        }
                        onLink={(name) =>
                            update(i, {
                                host: name,
                                ...(h.path ? { path: h.path } : {}),
                                ...(h.notes ? { notes: h.notes } : {})
                            })
                        }
                    />
                )
            )}
            <HostDialog
                open={dialog !== null}
                title={dialog?.index === null ? 'New shared host' : 'Move host to the shared list'}
                initial={dialog?.initial}
                keys={keys}
                project={dialog?.project}
                onClose={() => setDialog(null)}
                onSaved={(saved, own) => {
                    const ref = {
                        host: saved.name,
                        ...(own.path ? { path: own.path } : {}),
                        ...(own.notes ? { notes: own.notes } : {})
                    }
                    if (dialog?.index === null || dialog?.index === undefined) onChange([...value, ref])
                    else update(dialog.index, ref)
                    setDialog(null)
                    onSharedChanged()
                }}
            />
        </div>
    )
}

/** A shared host in a project: the server as read-only facts, the project's own path and notes editable. */
function SharedHostCard({
    entry,
    host,
    onChange,
    onRemove
}: {
    entry: { host: string; path?: string; notes?: string }
    host: HostView | undefined
    onChange: (patch: { path?: string; notes?: string }) => void
    onRemove: () => void
}) {
    return (
        <div className="host-card shared">
            <div className="host-shared-head">
                <strong>{entry.host}</strong>
                {host?.ssh ? (
                    <>
                        <span className="mono dim">{host.ssh}</span>
                        {host.key && <span className="badge plain">key {host.key}</span>}
                    </>
                ) : (
                    <span className="badge failed" title="No shared host of this name in hosts.yaml">
                        missing in Settings → Hosts
                    </span>
                )}
                <span className="grow" />
                <Link to="/settings#hosts" className="small">
                    Edit in Settings
                </Link>
            </div>
            <label className="field wide">
                <span>Path for this project</span>
                <input className="mono" placeholder="/srv/app" value={entry.path ?? ''} onChange={(e) => onChange({ path: e.target.value || undefined })} />
            </label>
            <label className="field wide">
                <span>Notes for this project</span>
                <GrowingTextarea
                    placeholder="what runs there for this project, how deploys work, where the logs are, what never to touch"
                    value={entry.notes ?? ''}
                    onChange={(e) => onChange({ notes: e.target.value || undefined })}
                />
            </label>
            <div className="host-foot wide">
                {host?.ssh && <TestConnection target={{ name: host.name }} />}
                <span className="grow" />
                <Button size="sm" onClick={onRemove} title="The project stops referring to it; the host stays in Settings">
                    Detach
                </Button>
            </div>
        </div>
    )
}

/** A host written inside this file: still editable, with the way out — move it to the shared list, or link the identical shared host. */
function InlineHostCard({
    host,
    keys,
    sameAs,
    onChange,
    onRemove,
    onMove,
    onLink
}: {
    host: InlineHost
    keys: SshKeys | undefined
    sameAs: HostView | undefined
    onChange: (patch: InlineHost) => void
    onRemove: () => void
    onMove: () => void
    onLink: (name: string) => void
}) {
    return (
        <div className="host-card">
            <div className="host-legacy wide">
                <span>Written in this project only.</span>
                {sameAs ? (
                    <Button size="sm" onClick={() => onLink(sameAs.name)} title={`${sameAs.ssh} is already the shared host ${sameAs.name}: refer to it and keep these notes as the project's`}>
                        Link to shared host {sameAs.name}
                    </Button>
                ) : (
                    <Button size="sm" onClick={onMove}>
                        Move to shared hosts
                    </Button>
                )}
            </div>
            <label className="field">
                <span>Name</span>
                <input placeholder="production" value={host.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} />
            </label>
            <label className="field">
                <span>SSH target</span>
                <input className="mono" placeholder="deploy@203.0.113.10 or deploy@host:2222" value={host.ssh ?? ''} onChange={(e) => onChange({ ssh: e.target.value })} />
            </label>
            <label className="field">
                <span>Key</span>
                <KeySelect value={host.key ?? ''} onChange={(key) => onChange({ key: key || undefined })} keys={keys} />
            </label>
            <label className="field">
                <span>Path</span>
                <input className="mono" placeholder="/srv/app" value={host.path ?? ''} onChange={(e) => onChange({ path: e.target.value })} />
            </label>
            <label className="field wide">
                <span>Notes</span>
                <GrowingTextarea placeholder="how to restart, where the logs are, what never to touch" value={host.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value })} />
            </label>
            <div className="host-foot wide">
                <TestConnection target={{ ssh: host.ssh ?? '', key: host.key }} />
                <span className="grow" />
                <Button size="sm" variant="danger" onClick={onRemove} aria-label="Remove host">
                    Remove
                </Button>
            </div>
        </div>
    )
}
