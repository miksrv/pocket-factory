import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { api, ApiError, fmt, type FolderFile, type FolderKind } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { CodeEditor } from './CodeEditor'
import { Icon } from './Icon'
import { Modal, useConfirm } from './Modal'
import { Button, Empty, ErrorBox, SectionHead, Tabs } from './ui'

/** What a new file starts with, by its extension: a script that says what it is. */
export function fileTemplate(file: string, description = 'What this script does, in one line.'): string {
    if (/\.(sh|bash)$/.test(file)) return `#!/usr/bin/env bash\n# ${description}\n# secrets:\nset -euo pipefail\n\n`
    if (file.endsWith('.py')) return `#!/usr/bin/env python3\n# ${description}\n# secrets:\n\n`
    if (/\.(mjs|js)$/.test(file)) return `#!/usr/bin/env node\n// ${description}\n// secrets:\n\n`
    return ''
}

const UPLOAD_MAX = 1500 * 1024

/**
 * The files of a skill's or a routine's folder, next to its main file: a list
 * one row per file, under its directory; a click opens the file in a window
 * across the screen (a code editor, a CSV as a table, a binary file as a
 * download). `open` / `onOpen` say which file is open.
 */
export function FolderFiles({
    kind,
    name,
    dir,
    open,
    onOpen,
    onChanged,
    hint
}: {
    kind: FolderKind
    name: string
    /** The folder on disk, for the head line. */
    dir: string
    open: string | null
    onOpen: (path: string | null) => void
    /** Something was written, renamed or deleted: the cards that describe scripts refresh. */
    onChanged?: () => void
    hint?: ReactNode
}) {
    const files = useAsync(() => api.folderFiles(kind, name), [kind, name])
    const [naming, setNaming] = useState(false)
    const [adding, setAdding] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [dirty, setDirty] = useState(false)
    const upload = useRef<HTMLInputElement>(null)
    const confirm = useConfirm()
    const list = useMemo(() => files.data ?? [], [files.data])
    const current = list.find((f) => f.path === open) ?? null

    const changed = () => {
        files.reload()
        onChanged?.()
    }
    // Closing a file with unsaved edits asks first.
    const close = () => {
        if (!dirty) return onOpen(null)
        void confirm({
            title: 'Discard the unsaved edits?',
            message: `${open} has changes that are not saved.`,
            action: 'Discard',
            danger: true,
            icon: 'warning',
            onConfirm: () => {
                setDirty(false)
                onOpen(null)
            }
        })
    }
    const create = async () => {
        const file = adding.trim().replace(/^\/+/, '')
        if (!file) return
        setError(null)
        try {
            await api.saveFolderFile(kind, name, file, { text: fileTemplate(file) })
            setAdding('')
            setNaming(false)
            changed()
            onOpen(file)
        } catch (e) {
            setError((e as Error).message)
        }
    }
    const onUpload = async (picked: FileList | null) => {
        const file = picked?.[0]
        if (upload.current) upload.current.value = ''
        if (!file) return
        if (file.size > UPLOAD_MAX) return setError(`${file.name} is larger than ${UPLOAD_MAX / 1024} KB`)
        // A routine's uploads are its data; a skill's, references next to SKILL.md.
        const dirOf = kind === 'routines' ? 'data/' : ''
        setError(null)
        try {
            const base64 = await toBase64(file)
            await api.saveFolderFile(kind, name, `${dirOf}${file.name}`, { base64 })
            changed()
            onOpen(`${dirOf}${file.name}`)
        } catch (e) {
            setError((e as Error).message)
        }
    }

    // A folder's tree: the files under their directories, the top level first.
    const groups = useMemo(() => {
        const by = new Map<string, FolderFile[]>()
        for (const f of list) {
            const at = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
            by.set(at, [...(by.get(at) ?? []), f])
        }
        return [...by.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    }, [list])

    return (
        <div className='field wide folder-files'>
            <SectionHead
                title='Files'
                hint={
                    hint ?? (
                        <span title={dir}>
                            In <span className='mono'>{dir}</span>
                        </span>
                    )
                }
            >
                <Button
                    size='sm'
                    onClick={() => setNaming(true)}
                >
                    <Icon
                        name='add'
                        size={12}
                    />
                    File
                </Button>
                <Button
                    size='sm'
                    onClick={() => upload.current?.click()}
                    title={`Upload a file (up to ${UPLOAD_MAX / 1024} KB)${kind === 'routines' ? ' into data/' : ''}`}
                >
                    Upload
                </Button>
                <input
                    ref={upload}
                    type='file'
                    hidden
                    aria-label='Upload a file'
                    onChange={(e) => void onUpload(e.target.files)}
                />
            </SectionHead>
            <ErrorBox error={files.error ?? error ?? undefined} />
            {naming && (
                <form
                    className='row'
                    style={{ gap: 8, marginBottom: 10 }}
                    onSubmit={(e) => {
                        e.preventDefault()
                        void create()
                    }}
                >
                    <input
                        className='mono grow'
                        value={adding}
                        onChange={(e) => setAdding(e.target.value)}
                        placeholder='scripts/stats.sh or data/queue.csv'
                        aria-label='New file path'
                        autoFocus
                    />
                    <Button
                        variant='primary'
                        type='submit'
                        disabled={!adding.trim()}
                    >
                        Create
                    </Button>
                    <Button
                        variant='ghost'
                        onClick={() => {
                            setNaming(false)
                            setAdding('')
                        }}
                    >
                        Cancel
                    </Button>
                </form>
            )}
            {files.data && list.length === 0 && (
                <Empty inline>No files besides the main one yet: add a file or upload one.</Empty>
            )}
            {list.length > 0 && (
                <div
                    className='file-list'
                    role='list'
                >
                    {groups.map(([at, entries]) => (
                        <div
                            key={at || '.'}
                            role='presentation'
                        >
                            {at && <div className='files-dir mono'>{at}/</div>}
                            {entries.map((f) => (
                                <button
                                    key={f.path}
                                    type='button'
                                    role='listitem'
                                    className='file-row'
                                    onClick={() => onOpen(f.path)}
                                    title={`Open ${f.path}`}
                                >
                                    <span className='mono file-row-name'>{f.path.slice(at ? at.length + 1 : 0)}</span>
                                    {f.exec && <span className='badge plain'>exec</span>}
                                    {!f.text && <span className='badge plain'>binary</span>}
                                    <span className='grow' />
                                    <span className='dim small nowrap'>{fmt.bytes(f.size)}</span>
                                    <span
                                        className='dim small nowrap file-row-when'
                                        title={fmt.when(f.updated_at)}
                                    >
                                        {fmt.ago(f.updated_at)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
            {current && (
                <Modal
                    open
                    onClose={close}
                    size='large'
                    icon='file'
                    title={current.path}
                    description={`${fmt.bytes(current.size)} · changed ${fmt.ago(current.updated_at)}${current.exec ? ' · executable' : ''} · ${dir}`}
                    content={
                        <FileEditor
                            key={current.path}
                            kind={kind}
                            name={name}
                            file={current}
                            bare
                            onDirty={setDirty}
                            onSaved={changed}
                            onRenamed={(to) => {
                                changed()
                                onOpen(to)
                            }}
                            onDeleted={() => {
                                changed()
                                setDirty(false)
                                onOpen(null)
                            }}
                        />
                    }
                    footer={<Button onClick={close}>Close</Button>}
                />
            )}
        </div>
    )
}

/**
 * One file of a folder, open: its head (path, size, when it changed, the
 * executable bit for a script, Rename / Download / Delete, Save) and its text
 * in the code editor, a CSV also as a table. A save that a run overtook (the
 * file changed on disk since it was opened) is refused and offers a reload.
 */
export function FileEditor({
    kind,
    name,
    file,
    onSaved,
    onDirty,
    onRenamed,
    onDeleted,
    compact,
    bare
}: {
    kind: FolderKind
    name: string
    file: FolderFile
    onSaved?: () => void
    onDirty?: (dirty: boolean) => void
    onRenamed?: (to: string) => void
    onDeleted?: () => void
    /** Inside a step card: no rename or delete, the editor a little shorter. */
    compact?: boolean
    /** In its own window, whose header names the file: the toolbar only, a taller editor. */
    bare?: boolean
}) {
    const content = useAsync(
        () => (file.text ? api.folderFile(kind, name, file.path) : Promise.resolve(null)),
        [kind, name, file.path]
    )
    const [text, setText] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [conflict, setConflict] = useState(false)
    const [renaming, setRenaming] = useState<string | null>(null)
    const csv = /\.(csv|tsv)$/i.test(file.path)
    const [view, setView] = useState<'table' | 'text'>(csv ? 'table' : 'text')
    const confirm = useConfirm()
    const loaded = content.data?.text ?? ''
    const shown = text ?? loaded
    const dirty = text !== null && text !== loaded
    useEffect(() => {
        onDirty?.(dirty)
        return () => onDirty?.(false)
    }, [dirty, onDirty])

    const save = async () => {
        if (!dirty || busy) return
        setBusy(true)
        setError(null)
        setConflict(false)
        try {
            const saved = await api.saveFolderFile(kind, name, file.path, {
                text: shown,
                updated_at: content.data?.updated_at
            })
            // The saved text becomes what is loaded before the draft goes: the editor keeps its cursor and undo.
            content.setData({ path: file.path, text: shown, updated_at: saved.updated_at })
            setText(null)
            onSaved?.()
        } catch (e) {
            setError((e as Error).message)
            setConflict(e instanceof ApiError && e.status === 409)
        } finally {
            setBusy(false)
        }
    }
    const toggleExec = async () => {
        setError(null)
        try {
            // The text as it is on disk: the bit changes, the edits stay in the editor.
            await api.saveFolderFile(kind, name, file.path, {
                text: loaded,
                updated_at: content.data?.updated_at,
                exec: !file.exec
            })
            content.reload()
            onSaved?.()
        } catch (e) {
            setError((e as Error).message)
        }
    }
    const rename = async () => {
        const to = renaming?.trim()
        if (!to || to === file.path) return setRenaming(null)
        setError(null)
        try {
            await api.renameFolderFile(kind, name, file.path, to)
            setRenaming(null)
            onRenamed?.(to)
        } catch (e) {
            setError((e as Error).message)
        }
    }
    const remove = () =>
        void confirm({
            title: `Delete ${file.path}?`,
            message: 'The file goes from the folder. There is no undo.',
            action: 'Delete',
            danger: true,
            icon: 'delete',
            onConfirm: async () => {
                await api.removeFolderFile(kind, name, file.path)
                onDeleted?.()
            }
        })
    const script = /\.(sh|bash|py|mjs|js|rb|pl)$/.test(file.path) || file.exec

    return (
        <div className='file-editor'>
            <div
                className='row wrap file-head'
                style={{ gap: 8 }}
            >
                {renaming !== null ? (
                    <form
                        className='row grow'
                        style={{ gap: 6 }}
                        onSubmit={(e) => {
                            e.preventDefault()
                            void rename()
                        }}
                    >
                        <input
                            className='mono grow'
                            value={renaming}
                            onChange={(e) => setRenaming(e.target.value)}
                            aria-label='New path'
                            autoFocus
                        />
                        <Button
                            variant='primary'
                            type='submit'
                        >
                            Rename
                        </Button>
                        <Button
                            variant='ghost'
                            onClick={() => setRenaming(null)}
                        >
                            Cancel
                        </Button>
                    </form>
                ) : bare ? (
                    <span className='grow' />
                ) : (
                    <>
                        <span className='mono file-path'>{file.path}</span>
                        <span className='dim small grow'>
                            {fmt.bytes(file.size)} · changed {fmt.ago(content.data?.updated_at ?? file.updated_at)}
                        </span>
                    </>
                )}
                {csv && file.text && (
                    <Tabs
                        items={[
                            { value: 'table', label: 'Table' },
                            { value: 'text', label: 'Text' }
                        ]}
                        value={view}
                        onChange={setView}
                    />
                )}
                {script && !compact && (
                    <label
                        className='row small'
                        style={{ gap: 6 }}
                        title='A step can run an executable script by its path'
                    >
                        <input
                            type='checkbox'
                            checked={file.exec}
                            onChange={() => void toggleExec()}
                        />
                        <span>executable</span>
                    </label>
                )}
                {!compact && renaming === null && (
                    <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => setRenaming(file.path)}
                    >
                        Rename
                    </Button>
                )}
                <Button
                    size='sm'
                    variant='ghost'
                    href={api.folderFileUrl(kind, name, file.path)}
                    title='Download the file'
                >
                    Download
                </Button>
                {!compact && (
                    <Button
                        size='sm'
                        variant='ghost'
                        onClick={remove}
                    >
                        Delete
                    </Button>
                )}
                {file.text && (
                    <Button
                        size='sm'
                        variant='primary'
                        onClick={() => void save()}
                        disabled={!dirty || busy}
                        title='⌘S / Ctrl+S in the editor'
                    >
                        {busy ? 'Saving…' : dirty ? 'Save file' : 'Saved'}
                    </Button>
                )}
            </div>
            <ErrorBox error={error ?? content.error} />
            {conflict && (
                <div
                    className='row'
                    style={{ gap: 8, marginBottom: 8 }}
                >
                    <Button
                        size='sm'
                        onClick={() => {
                            setText(null)
                            setConflict(false)
                            setError(null)
                            content.reload()
                        }}
                    >
                        Reload from disk
                    </Button>
                    <span className='dim small'>drops your edits here; copy what you need first</span>
                </div>
            )}
            {!file.text ? (
                <div className='files-empty'>
                    <Empty inline>
                        Not a text file the editor shows ({fmt.bytes(file.size)}): download it to look inside.
                    </Empty>
                </div>
            ) : content.loading && !content.data ? (
                <div className='files-empty'>
                    <Empty inline>Loading…</Empty>
                </div>
            ) : csv && view === 'table' ? (
                <CsvTable text={shown} />
            ) : (
                <CodeEditor
                    value={shown}
                    onChange={setText}
                    path={file.path}
                    label={file.path}
                    onSave={() => void save()}
                    rows={compact ? 10 : bare ? 26 : 18}
                />
            )}
        </div>
    )
}

/** CSV / TSV split into rows: quoted fields, `""` escapes, newlines inside quotes. */
export function parseCsv(text: string, separator = text.split('\n')[0]?.includes('\t') ? '\t' : ','): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
                field += '"'
                i++
            } else if (ch === '"') quoted = false
            else field += ch
        } else if (ch === '"' && field === '') quoted = true
        else if (ch === separator) {
            row.push(field)
            field = ''
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++
            row.push(field)
            rows.push(row)
            row = []
            field = ''
        } else field += ch
    }
    if (field !== '' || row.length) {
        row.push(field)
        rows.push(row)
    }
    return rows.map((r, i) => (i === 0 && r[0]?.startsWith('﻿') ? [r[0].slice(1), ...r.slice(1)] : r))
}

const CSV_ROWS = 300

function CsvTable({ text }: { text: string }) {
    const rows = useMemo(() => parseCsv(text), [text])
    if (!rows.length)
        return (
            <div className='files-empty'>
                <Empty inline>Empty.</Empty>
            </div>
        )
    const [head, ...body] = rows
    return (
        <div className='card-scroll csv-table'>
            <table>
                <thead>
                    <tr>
                        {head.map((h, i) => (
                            <th key={i}>{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {body.slice(0, CSV_ROWS).map((r, i) => (
                        <tr key={i}>
                            {head.map((_, j) => (
                                <td key={j}>{r[j] ?? ''}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className='dim small csv-foot'>
                {body.length} row(s){body.length > CSV_ROWS ? `, the first ${CSV_ROWS} shown` : ''} · edit as Text
            </div>
        </div>
    )
}

function toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
        reader.onerror = () => reject(reader.error ?? new Error('could not read the file'))
        reader.readAsDataURL(file)
    })
}
