import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'

import { api, type CatalogEntry, fmt, type Kind } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { useAsync } from '../lib/useAsync'
import { Tile } from './Tile'
import { Empty, ErrorBox, PageHead, useToast } from './ui'

export interface EditorProps {
    kind: Kind
    title: string
    sub: string
    /** Renders the frontmatter form; receives current values and a setter. */
    form: (fm: Record<string, unknown>, set: (patch: Record<string, unknown>) => void) => ReactNode
    /** Default frontmatter for a new entry. */
    defaults: Record<string, unknown>
    /** Default body for a new entry. */
    template: string
    bodyLabel?: string
    describe?: (entry: CatalogEntry) => string
    /** Where the page's back link goes (the agents grid, for instance). */
    backTo?: { to: string; label: string }
}

const DISCARD = 'You have unsaved changes. Discard them?'

/**
 * List + editor for one kind of factory file. The page fills the viewport:
 * the list and the form scroll on their own, the header with Save stays put.
 * The frontmatter form is kind-specific; the Markdown body is a plain
 * textarea — the same text the agent reads — with a preview.
 */
export function Editor({ kind, title, sub, form, defaults, template, bodyLabel = 'Instructions (Markdown)', describe, backTo }: EditorProps) {
    const { name } = useParams()
    const navigate = useNavigate()
    const list = useAsync(() => api.list(kind), [kind])
    const [toast, showToast] = useToast()
    const [filter, setFilter] = useState('')
    const [dirty, setDirty] = useState(false)

    const creating = name === 'new'
    const selected = list.data?.find((e) => e.name === name)
    const needle = filter.trim().toLowerCase()
    const entries = (list.data ?? []).filter(
        (e) => !needle || e.name.toLowerCase().includes(needle) || String(e.frontmatter.description ?? '').toLowerCase().includes(needle)
    )

    // Leaving an edited form through the list or the New button asks first.
    const guard = (e: MouseEvent) => {
        if (dirty && !window.confirm(DISCARD)) e.preventDefault()
    }

    return (
        <div className="page editor-page">
            <PageHead title={title} sub={sub}>
                {backTo && (
                    <Link className="btn" to={backTo.to} onClick={guard}>
                        ‹ {backTo.label}
                    </Link>
                )}
                <button
                    className="primary"
                    onClick={() => {
                        if (dirty && !window.confirm(DISCARD)) return
                        navigate(`/${kind}/new`)
                    }}
                >
                    New
                </button>
            </PageHead>
            <ErrorBox error={list.error} />
            <div className="editor-layout">
                <div className="card pad0 list-pane">
                    <div className="list-filter">
                        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${kind}…`} aria-label={`Filter ${kind}`} />
                    </div>
                    <div className="list">
                        {entries.map((entry) => (
                            <NavLink key={entry.name} to={`/${kind}/${entry.name}`} onClick={guard}>
                                <Tile name={entry.name} kind={kind} />
                                <div className="grow">
                                    <div className="title">{entry.name}</div>
                                    <div className="desc">{describe ? describe(entry) : String(entry.frontmatter.description ?? '')}</div>
                                </div>
                            </NavLink>
                        ))}
                        {list.data?.length === 0 && <Empty>Nothing here yet.</Empty>}
                        {list.data && list.data.length > 0 && entries.length === 0 && <Empty>No match.</Empty>}
                    </div>
                    <div className="card-foot">
                        <span>
                            {entries.length}
                            {needle ? ` of ${list.data?.length ?? 0}` : ''} {kind}
                        </span>
                    </div>
                </div>
                {creating || selected ? (
                    <Form
                        key={creating ? 'new' : selected!.name}
                        kind={kind}
                        entry={creating ? null : selected!}
                        defaults={defaults}
                        template={template}
                        form={form}
                        bodyLabel={bodyLabel}
                        onDirty={setDirty}
                        onSaved={(saved) => {
                            showToast(`Saved ${kind}/${saved.name}`)
                            list.reload()
                            navigate(`/${kind}/${saved.name}`)
                        }}
                        onDeleted={() => {
                            showToast('Deleted')
                            list.reload()
                            navigate(backTo?.to ?? `/${kind}`)
                        }}
                    />
                ) : (
                    <div className="card form-pane">
                        <Empty>Select an entry or create a new one.</Empty>
                    </div>
                )}
            </div>
            {toast}
        </div>
    )
}

function Form({
    kind,
    entry,
    defaults,
    template,
    form,
    bodyLabel,
    onDirty,
    onSaved,
    onDeleted
}: {
    kind: Kind
    entry: CatalogEntry | null
    defaults: Record<string, unknown>
    template: string
    form: EditorProps['form']
    bodyLabel: string
    onDirty: (dirty: boolean) => void
    onSaved: (entry: CatalogEntry) => void
    onDeleted: () => void
}) {
    const [name, setName] = useState(entry?.name ?? '')
    const [fm, setFm] = useState<Record<string, unknown>>(entry?.frontmatter ?? defaults)
    const [body, setBody] = useState(entry?.body ?? template)
    const [mode, setMode] = useState<'edit' | 'preview'>('edit')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const textarea = useRef<HTMLTextAreaElement>(null)
    const dirty = entry ? body !== entry.body || JSON.stringify(fm) !== JSON.stringify(entry.frontmatter) : true
    const canSave = !busy && Boolean(name.trim()) && dirty

    useEffect(() => {
        onDirty(dirty)
        return () => onDirty(false)
    }, [dirty, onDirty])

    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => {
            if (dirty) e.preventDefault()
        }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [dirty])

    // The textarea's basis is its content height; flex-grow fills the rest of
    // the pane when the text is short, and the pane scrolls when it is long.
    useLayoutEffect(() => {
        const el = textarea.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${el.scrollHeight + 2}px`
    }, [body, mode])

    const save = async () => {
        if (!canSave) return
        setBusy(true)
        setError(null)
        try {
            const clean = Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== '' && v !== undefined && v !== null))
            onSaved(await api.save(kind, name.trim(), { frontmatter: clean, body }))
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    // ⌘S / Ctrl+S saves from anywhere on the page.
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                void save()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    })

    const remove = async () => {
        if (!entry || !window.confirm(`Delete ${kind}/${entry.name}? This removes the file from the volume.`)) return
        try {
            await api.remove(kind, entry.name)
            onDeleted()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    // Tab indents instead of leaving the field; Escape then Tab still moves focus.
    const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Tab' || e.shiftKey) return
        e.preventDefault()
        const el = e.currentTarget
        const { selectionStart, selectionEnd } = el
        const next = `${body.slice(0, selectionStart)}    ${body.slice(selectionEnd)}`
        setBody(next)
        requestAnimationFrame(() => el.setSelectionRange(selectionStart + 4, selectionStart + 4))
    }

    const lines = body.split('\n').length

    return (
        <div className="card pad0 form-pane">
            <div className="form-head">
                <Tile name={name || 'new'} kind={kind} large />
                <div className="grow" style={{ minWidth: 200 }}>
                    {entry ? (
                        <>
                            <div className="agent-name">{entry.name}</div>
                            <div className="dim small mono" title={entry.path}>
                                {entry.path.split('/').slice(-2).join('/')} · {fmt.bytes(entry.size)} · updated {fmt.ago(entry.updated_at)}
                            </div>
                        </>
                    ) : (
                        <label className="field">
                            <span>Name (file name, a-z 0-9 - _ .)</span>
                            <input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={`my-${kind.slice(0, -1)}`} autoFocus />
                        </label>
                    )}
                </div>
                <span className={`badge ${dirty ? 'queued' : 'done'}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
                <div className="toolbar">
                    {entry && (
                        <button className="danger" onClick={remove}>
                            Delete
                        </button>
                    )}
                    <button className="primary" onClick={save} disabled={!canSave} title="⌘S / Ctrl+S">
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
            <div className="form-body">
                <ErrorBox error={error ?? undefined} />
                <div className="form-grid">{form(fm, (patch) => setFm((prev) => ({ ...prev, ...patch })))}</div>
                <div className="field-head">
                    <div>
                        <div>{bodyLabel}</div>
                        <div className="dim">
                            {lines} lines · {body.length.toLocaleString()} chars
                        </div>
                    </div>
                    <div className="tabs">
                        <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
                            Edit
                        </button>
                        <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
                            Preview
                        </button>
                    </div>
                </div>
                {mode === 'edit' ? (
                    <textarea ref={textarea} className="mono body" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onBodyKey} spellCheck={false} />
                ) : (
                    <div className="md preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
                )}
            </div>
        </div>
    )
}

export function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
    return (
        <label className={`field${wide ? ' wide' : ''}`}>
            <span>{label}</span>
            {children}
            {hint && <span className="dim">{hint}</span>}
        </label>
    )
}

export const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v))
