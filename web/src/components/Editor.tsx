import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'

import { api, type CatalogEntry, fmt, type Kind } from '../lib/api'
import { setUnsaved, useLeaveGuard } from '../lib/unsaved'
import { useAsync } from '../lib/useAsync'
import { useConfirm } from './Modal'
import { Tile } from './Tile'
import { Button, Empty, ErrorBox, Intro, Markdown, PageHead, Tabs, useToast } from './ui'

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
    describe?: (entry: CatalogEntry) => ReactNode
    /** Where the page's back link goes (the agents grid, for instance). */
    backTo?: { to: string; label: string }
    /** What the empty form pane says before an entry is picked, and the label of its create button. */
    intro?: string
    newLabel?: string
    /** Rendered above the form for an existing entry: live state that is not in the file (a schedule's runs). */
    aside?: (entry: CatalogEntry) => ReactNode
    /** Why the frontmatter must not be saved as it is (an invalid cron), or null; shown next to Save, which is disabled meanwhile. */
    validate?: (fm: Record<string, unknown>) => string | null
}

const MODES = [
    { value: 'edit', label: 'Edit' },
    { value: 'preview', label: 'Preview' }
] as const

/**
 * List + editor for one kind of factory file. The page fills the viewport:
 * the list and the form scroll on their own, the header with Save stays put.
 * The frontmatter form is kind-specific; the Markdown body is a plain
 * textarea — the same text the agent reads — with a preview.
 */
export function Editor({ kind, title, sub, form, defaults, template, bodyLabel = 'Instructions (Markdown)', describe, backTo, intro = 'Select an entry or create a new one.', newLabel = 'New', aside, validate }: EditorProps) {
    const { name } = useParams()
    const navigate = useNavigate()
    const list = useAsync(() => api.list(kind), [kind])
    const [toast, showToast] = useToast()
    const [filter, setFilter] = useState('')
    const [dirty, setDirty] = useState(false)
    const { leave, guard } = useLeaveGuard()
    useEffect(() => {
        setUnsaved(dirty)
        return () => setUnsaved(false)
    }, [dirty])

    const creating = name === 'new'
    const selected = list.data?.find((e) => e.name === name)
    const needle = filter.trim().toLowerCase()
    const entries = (list.data ?? []).filter(
        (e) => !needle || e.name.toLowerCase().includes(needle) || String(e.frontmatter.description ?? '').toLowerCase().includes(needle)
    )

    // Leaving an edited form through the list or the New button asks first.
    const startNew = () => leave(() => navigate(`/${kind}/new`))
    const names = new Set((list.data ?? []).map((e) => e.name))

    return (
        <div className="page editor-page">
            <PageHead title={title} sub={sub}>
                {backTo && (
                    <Button to={backTo.to} onClick={guard(backTo.to)}>
                        ‹ {backTo.label}
                    </Button>
                )}
                <Button variant="primary" onClick={startNew}>
                    New
                </Button>
            </PageHead>
            <ErrorBox error={list.error} />
            <div className="editor-layout">
                <div className="card pad0 list-pane">
                    <div className="list-filter">
                        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${kind}…`} aria-label={`Filter ${kind}`} />
                    </div>
                    <div className="list">
                        {entries.map((entry) => (
                            <NavLink key={entry.name} to={`/${kind}/${entry.name}`} onClick={guard(`/${kind}/${entry.name}`)}>
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
                        aside={aside}
                        validate={validate}
                        bodyLabel={bodyLabel}
                        taken={names}
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
                        <Intro text={intro} action={newLabel} onAction={startNew} />
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
    aside,
    validate,
    bodyLabel,
    taken,
    onDirty,
    onSaved,
    onDeleted
}: {
    kind: Kind
    entry: CatalogEntry | null
    defaults: Record<string, unknown>
    template: string
    form: EditorProps['form']
    aside?: EditorProps['aside']
    validate?: EditorProps['validate']
    bodyLabel: string
    /** Names that exist already: a new entry may not take one (the agent's file would be replaced). */
    taken: Set<string>
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
    const confirm = useConfirm()
    const textarea = useRef<HTMLTextAreaElement>(null)
    // Empty fields are dropped on save, so compare what would be saved with
    // what is on disk; a fresh form is clean until something is typed.
    const clean = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, v]) => v !== '' && v !== undefined && v !== null))
    const same = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(clean(a)) === JSON.stringify(clean(b))
    const dirty = entry ? body !== entry.body || !same(fm, entry.frontmatter) : Boolean(name.trim()) || body !== template || !same(fm, defaults)
    const trimmed = name.trim()
    const nameTaken = !entry && taken.has(trimmed)
    const invalid = validate?.(fm) ?? null
    const canSave = !busy && Boolean(trimmed) && !nameTaken && !invalid && dirty

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
            const saved = await api.save(kind, trimmed, { frontmatter: clean(fm), body }, !entry)
            // The form stays mounted for the same name: adopt the saved state so it reads as clean.
            setFm(saved.frontmatter)
            setBody(saved.body)
            onSaved(saved)
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

    // The question names the file; a failure shows in the window, where Delete can be tried again.
    const remove = () => {
        if (!entry) return
        void confirm({
            title: `Delete ${kind.slice(0, -1)} “${entry.name}”?`,
            message: (
                <>
                    This removes <code>{entry.path.split('/').slice(-2).join('/')}</code> from the volume. There is no undo: the factory keeps no history of its files.
                </>
            ),
            action: 'Delete',
            pending: 'Deleting…',
            danger: true,
            icon: 'delete',
            onConfirm: async () => {
                await api.remove(kind, entry.name)
                onDeleted()
            }
        })
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
                            <input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={`my-${kind.slice(0, -1)}`} autoFocus aria-invalid={nameTaken} />
                            {nameTaken && <span className="error">{`${kind}/${trimmed} already exists — open it from the list to edit it.`}</span>}
                        </label>
                    )}
                </div>
                {invalid ? <span className="badge failed" title={invalid}>{invalid}</span> : <span className={`badge ${dirty ? 'queued' : 'done'}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>}
                <div className="toolbar">
                    {entry && (
                        <Button variant="danger" onClick={remove}>
                            Delete
                        </Button>
                    )}
                    <Button variant="primary" onClick={save} disabled={!canSave} title="⌘S / Ctrl+S">
                        {busy ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            </div>
            <div className="form-body">
                <ErrorBox error={error ?? undefined} />
                {entry && aside?.(entry)}
                <div className="form-grid">{form(fm, (patch) => setFm((prev) => ({ ...prev, ...patch })))}</div>
                <div className="field-head">
                    <div>
                        <div>{bodyLabel}</div>
                        <div className="dim">
                            {lines} lines · {body.length.toLocaleString()} chars
                        </div>
                    </div>
                    <Tabs items={MODES} value={mode} onChange={setMode} />
                </div>
                {mode === 'edit' ? (
                    <textarea ref={textarea} className="mono body" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onBodyKey} spellCheck={false} />
                ) : (
                    <Markdown className="preview" source={body} document />
                )}
            </div>
        </div>
    )
}

/**
 * A labelled control. `group` for a set of controls (a list of checkboxes):
 * a <label> around several inputs would forward every click on the caption,
 * the hint or the gaps to its first input, so a group is a <div>.
 */
export function Field({ label, hint, wide, group, children }: { label: string; hint?: ReactNode; wide?: boolean; group?: boolean; children: ReactNode }) {
    const className = `field${wide ? ' wide' : ''}${group ? ' group' : ''}`
    const body = (
        <>
            <span>{label}</span>
            {children}
            {hint && <span className="dim">{hint}</span>}
        </>
    )
    return group ? <div className={className}>{body}</div> : <label className={className}>{body}</label>
}

export const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v))
