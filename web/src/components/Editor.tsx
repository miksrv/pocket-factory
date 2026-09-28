import { type ReactNode, useEffect, useState } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'

import { api, type CatalogEntry, type Kind } from '../lib/api'
import { useAsync } from '../lib/useAsync'
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
}

/**
 * List + editor for one kind of factory file. The frontmatter form is
 * kind-specific; the Markdown body is always a plain textarea — the same
 * text the agent reads.
 */
export function Editor({ kind, title, sub, form, defaults, template, bodyLabel = 'Instructions (Markdown)', describe }: EditorProps) {
    const { name } = useParams()
    const navigate = useNavigate()
    const list = useAsync(() => api.list(kind), [kind])
    const [toast, showToast] = useToast()

    const creating = name === 'new'
    const selected = list.data?.find((e) => e.name === name)

    return (
        <div className="page wide">
            <PageHead title={title} sub={sub}>
                <button className="primary" onClick={() => navigate(`/${kind}/new`)}>
                    New
                </button>
            </PageHead>
            <ErrorBox error={list.error} />
            <div className="editor-layout">
                <div className="card pad0 list">
                    {list.data?.map((entry) => (
                        <NavLink key={entry.name} to={`/${kind}/${entry.name}`}>
                            <div className="title">{entry.name}</div>
                            <div className="desc">{describe ? describe(entry) : String(entry.frontmatter.description ?? '')}</div>
                        </NavLink>
                    ))}
                    {list.data?.length === 0 && <Empty>Nothing here yet.</Empty>}
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
                        onSaved={(saved) => {
                            showToast(`Saved ${kind}/${saved.name}`)
                            list.reload()
                            navigate(`/${kind}/${saved.name}`)
                        }}
                        onDeleted={() => {
                            showToast('Deleted')
                            list.reload()
                            navigate(`/${kind}`)
                        }}
                    />
                ) : (
                    <div className="card dim">Select an entry or create a new one.</div>
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
    onSaved,
    onDeleted
}: {
    kind: Kind
    entry: CatalogEntry | null
    defaults: Record<string, unknown>
    template: string
    form: EditorProps['form']
    bodyLabel: string
    onSaved: (entry: CatalogEntry) => void
    onDeleted: () => void
}) {
    const [name, setName] = useState(entry?.name ?? '')
    const [fm, setFm] = useState<Record<string, unknown>>(entry?.frontmatter ?? defaults)
    const [body, setBody] = useState(entry?.body ?? template)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const dirty = entry ? body !== entry.body || JSON.stringify(fm) !== JSON.stringify(entry.frontmatter) : true

    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => {
            if (dirty) e.preventDefault()
        }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [dirty])

    const save = async () => {
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

    const remove = async () => {
        if (!entry || !confirm(`Delete ${kind}/${entry.name}? This removes the file from the volume.`)) return
        try {
            await api.remove(kind, entry.name)
            onDeleted()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    return (
        <div className="card stack">
            <div className="row between">
                <label className="field grow" style={{ maxWidth: 360 }}>
                    <span>Name (file name, a-z 0-9 - _ .)</span>
                    <input className="mono" value={name} disabled={Boolean(entry)} onChange={(e) => setName(e.target.value)} placeholder={`my-${kind.slice(0, -1)}`} />
                </label>
                <div className="toolbar">
                    {entry && (
                        <button className="danger" onClick={remove}>
                            Delete
                        </button>
                    )}
                    <button className="primary" onClick={save} disabled={busy || !name.trim() || !dirty}>
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
            {entry && <div className="dim small mono">{entry.path}</div>}
            <ErrorBox error={error ?? undefined} />
            <div className="form-grid">{form(fm, (patch) => setFm((prev) => ({ ...prev, ...patch })))}</div>
            <label className="field">
                <span>{bodyLabel}</span>
                <textarea className="mono" value={body} onChange={(e) => setBody(e.target.value)} rows={22} spellCheck={false} />
            </label>
        </div>
    )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
            {hint && <span className="dim">{hint}</span>}
        </label>
    )
}

export const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v))
