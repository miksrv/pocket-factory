import { useRef, useState } from 'react'

import { api, fmt, type ImportPreview, type Kind } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Icon } from './Icon'
import { Modal, useConfirm } from './Modal'
import { Button, Empty, ErrorBox, Tabs, useToast } from './ui'

/*
 * Sharing agents, skills and routines with a colleague: an export is a ZIP in
 * the preset layout; an import takes such a ZIP, a `.skill` file or one
 * Markdown file, shows what is in it and installs what is ticked. Secrets and
 * variables never travel; routines arrive switched off.
 */

const AS = [
    { value: 'skills', label: 'Skill' },
    { value: 'agents', label: 'Agent' }
] as const
type MarkdownKind = (typeof AS)[number]['value']

const KIND_LABEL: Record<Kind, string> = { agents: 'agent', skills: 'skill', routines: 'routine', projects: 'project' }
const key = (item: { kind: Kind; name: string }) => `${item.kind}/${item.name}`
const isMarkdown = (file: File) => /\.md$/i.test(file.name)

/** The Import button of a page head: picks a file and opens the window that shows what it holds. */
export function ImportButton({ onImported }: { onImported?: () => void }) {
    const input = useRef<HTMLInputElement>(null)
    const [file, setFile] = useState<File | null>(null)
    const [toast, showToast] = useToast()
    return (
        <>
            <Button
                onClick={() => input.current?.click()}
                title='A ZIP exported from a factory, a .skill file, or one Markdown file (a skill or an agent)'
            >
                Import
            </Button>
            <input
                ref={input}
                type='file'
                accept='.zip,.skill,.md'
                hidden
                aria-label='File to import'
                onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null)
                    e.target.value = ''
                }}
            />
            {file && (
                <ImportDialog
                    file={file}
                    onClose={() => setFile(null)}
                    onImported={(n) => {
                        setFile(null)
                        showToast(n ? `Imported ${fmt.plural(n, 'item')}` : 'Nothing imported')
                        onImported?.()
                    }}
                />
            )}
            {toast}
        </>
    )
}

/** What a file holds, item by item, with a tick for each one to install; one that exists is replaced after a question. */
export function ImportDialog({
    file,
    onClose,
    onImported
}: {
    file: File
    onClose: () => void
    onImported: (count: number) => void
}) {
    const [as, setAs] = useState<MarkdownKind>('skills')
    const markdown = isMarkdown(file)
    const preview = useAsync(() => api.previewImport(file, markdown ? as : undefined), [file, as])
    // New items start ticked, those that would replace the owner's do not; a tick is kept until the file reads anew (Skill / Agent).
    const [ticks, setTicks] = useState<{ of: ImportPreview; keys: Set<string> } | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const confirm = useConfirm()

    const items = preview.data?.items ?? []
    const picked =
        ticks && ticks.of === preview.data
            ? ticks.keys
            : new Set(items.filter((i) => !i.errors.length && !i.exists).map(key))
    const chosen = items.filter((i) => picked.has(key(i)))
    const replaced = chosen.filter((i) => i.exists)
    const toggle = (k: string, on: boolean) => {
        if (!preview.data) return
        const keys = new Set(picked)
        if (on) keys.add(k)
        else keys.delete(k)
        setTicks({ of: preview.data, keys })
    }

    const run = async () => {
        const { installed } = await api.installImport(file, chosen.map(key), markdown ? as : undefined)
        onImported(installed.length)
    }
    const install = async () => {
        setError(null)
        if (replaced.length) {
            void confirm({
                title: `Replace ${fmt.plural(replaced.length, 'item')}?`,
                message: (
                    <>
                        Your{' '}
                        {replaced.map((i, n) => (
                            <span key={key(i)}>
                                {n > 0 && ', '}
                                <code>{key(i)}</code>
                            </span>
                        ))}{' '}
                        {replaced.length === 1 ? 'is' : 'are'} replaced with the imported version. Other files in a
                        folder (a routine&apos;s data) stay.
                    </>
                ),
                action: 'Replace',
                pending: 'Importing…',
                danger: true,
                icon: 'warning',
                onConfirm: run
            })
            return
        }
        setBusy(true)
        try {
            await run()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <Modal
            open
            onClose={onClose}
            title={`Import ${file.name}`}
            description={preview.data?.title ?? preview.data?.description ?? 'Pick what to install'}
            icon='import'
            size='wide'
            busy={busy}
            footer={
                <>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        variant='primary'
                        onClick={() => void install()}
                        disabled={busy || chosen.length === 0}
                    >
                        {busy
                            ? 'Importing…'
                            : chosen.length
                              ? `Install ${fmt.plural(chosen.length, 'item')}`
                              : 'Install'}
                    </Button>
                </>
            }
        >
            <div className='stack'>
                {markdown && (
                    <div className='row'>
                        <span className='dim small'>Import as</span>
                        <Tabs
                            items={AS}
                            value={as}
                            onChange={setAs}
                        />
                    </div>
                )}
                <ErrorBox error={preview.error ?? error} />
                {preview.loading && !preview.data && <Empty inline>Reading the file…</Empty>}
                {items.length > 0 && (
                    <div className='import-list'>
                        {items.map((item) => (
                            <ImportItem
                                key={key(item)}
                                item={item}
                                checked={picked.has(key(item))}
                                onChange={(on) => toggle(key(item), on)}
                            />
                        ))}
                    </div>
                )}
                {preview.data && preview.data.ignored_count > 0 && (
                    <div
                        className='dim small'
                        title={preview.data.ignored.join('\n')}
                    >
                        {fmt.plural(preview.data.ignored_count, 'file')} belong to nothing here and are left out
                        {preview.data.ignored.length ? `: ${preview.data.ignored.slice(0, 3).join(', ')}…` : ''}
                    </div>
                )}
                <div className='dim small'>Secrets and variables never travel; routines arrive switched off.</div>
            </div>
        </Modal>
    )
}

function ImportItem({
    item,
    checked,
    onChange
}: {
    item: ImportPreview['items'][number]
    checked: boolean
    onChange: (on: boolean) => void
}) {
    const blocked = item.errors.length > 0
    return (
        <label className={`import-item${blocked ? ' blocked' : ''}`}>
            <input
                type='checkbox'
                checked={checked}
                disabled={blocked}
                onChange={(e) => onChange(e.target.checked)}
                title={blocked ? item.errors.join('; ') : undefined}
            />
            <div className='grow stack-tight'>
                <div className='row wrap'>
                    <span className='dim'>{KIND_LABEL[item.kind]}</span>
                    <strong>{item.name}</strong>
                    {item.exists ? (
                        <span className='badge queued'>replaces yours</span>
                    ) : (
                        <span className='badge plain'>new</span>
                    )}
                    {item.files.length > 0 && (
                        <span
                            className='dim small'
                            title={item.files.join('\n')}
                        >
                            +{fmt.plural(item.files.length, 'file')}
                        </span>
                    )}
                </div>
                {item.description && <div className='dim small import-desc'>{item.description}</div>}
                {item.needs.length > 0 && (
                    <div className='needs'>
                        <span className='dim small'>Reads</span>
                        {item.needs.map((n) => (
                            <span
                                key={n.name}
                                className={`need ${n.set ? 'ok' : 'missing'}`}
                                title={
                                    n.set
                                        ? 'Set in Secrets and variables'
                                        : 'Set it in Settings → Secrets and variables'
                                }
                            >
                                <Icon
                                    name={n.secret ? 'secret' : 'variable'}
                                    size={12}
                                />
                                <span className='mono'>{n.name}</span>
                                <span className='need-state'>{n.set ? 'set' : 'not set'}</span>
                            </span>
                        ))}
                    </div>
                )}
                {item.notes.map((note) => (
                    <div
                        key={note}
                        className='dim small'
                    >
                        {note}
                    </div>
                ))}
                {item.errors.map((e) => (
                    <ErrorBox
                        key={e}
                        error={e}
                        inline
                    />
                ))}
            </div>
        </label>
    )
}

type Pick = Record<'agents' | 'skills' | 'routines', string[]>
const EXPORT_KINDS = ['routines', 'skills', 'agents'] as const

/** The Export window of the Presets page: tick agents, skills and routines, get one ZIP. */
export function ExportDialog({ onClose, onExported }: { onClose: () => void; onExported: (text: string) => void }) {
    const lists = useAsync(
        async () => ({
            agents: (await api.list('agents')).map((e) => e.name),
            skills: (await api.list('skills')).map((e) => e.name),
            routines: (await api.list('routines')).map((e) => e.name)
        }),
        []
    )
    const [picked, setPicked] = useState<Pick>({ agents: [], skills: [], routines: [] })
    const [withDeps, setWithDeps] = useState(true)
    const [withData, setWithData] = useState(false)
    const [title, setTitle] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const count = picked.agents.length + picked.skills.length + picked.routines.length

    const toggle = (kind: keyof Pick, name: string, on: boolean) =>
        setPicked((prev) => ({
            ...prev,
            [kind]: on ? [...prev[kind], name] : prev[kind].filter((n) => n !== name)
        }))
    const save = async () => {
        setBusy(true)
        setError(null)
        try {
            const { filename, masked } = await api.exportBundle({
                ...picked,
                with_deps: withDeps,
                with_data: withData,
                title: title.trim() || undefined
            })
            onExported(
                masked
                    ? `Saved ${filename}; secret values masked in ${fmt.plural(masked, 'file')}`
                    : `Saved ${filename}`
            )
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <Modal
            open
            onClose={onClose}
            title='Export'
            description='A ZIP a colleague imports on the Presets page'
            icon='export'
            size='wide'
            busy={busy}
            footer={
                <>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        variant='primary'
                        onClick={() => void save()}
                        disabled={busy || count === 0}
                    >
                        {busy ? 'Exporting…' : count ? `Export ${fmt.plural(count, 'item')}` : 'Export'}
                    </Button>
                </>
            }
        >
            <div className='stack'>
                <ErrorBox error={lists.error ?? error} />
                {EXPORT_KINDS.map((kind) => (
                    <div
                        key={kind}
                        className='stack-tight'
                    >
                        <span className='dim small'>{kind[0].toUpperCase() + kind.slice(1)}</span>
                        {lists.data?.[kind].length ? (
                            <div className='row wrap export-picks'>
                                {lists.data[kind].map((name) => (
                                    <label
                                        key={name}
                                        className='chip-check'
                                    >
                                        <input
                                            type='checkbox'
                                            checked={picked[kind].includes(name)}
                                            onChange={(e) => toggle(kind, name, e.target.checked)}
                                        />
                                        <span>{name}</span>
                                    </label>
                                ))}
                            </div>
                        ) : (
                            <Empty inline>{lists.loading ? 'Loading…' : `No ${kind}`}</Empty>
                        )}
                    </div>
                ))}
                <ExportOptions
                    withDeps={withDeps}
                    withData={withData}
                    onDeps={setWithDeps}
                    onData={setWithData}
                />
                <label className='field'>
                    <span>Title</span>
                    <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder='Pocket Factory export'
                    />
                </label>
            </div>
        </Modal>
    )
}

function ExportOptions({
    withDeps,
    withData,
    onDeps,
    onData
}: {
    withDeps: boolean
    withData: boolean
    onDeps: (on: boolean) => void
    onData: (on: boolean) => void
}) {
    return (
        <div className='stack-tight'>
            <label className='row'>
                <input
                    type='checkbox'
                    checked={withDeps}
                    onChange={(e) => onDeps(e.target.checked)}
                />
                <span>With each routine&apos;s agent and skill</span>
            </label>
            <label
                className='row'
                title='What its runs keep: notes, CSVs. It may be personal.'
            >
                <input
                    type='checkbox'
                    checked={withData}
                    onChange={(e) => onData(e.target.checked)}
                />
                <span>With routines&apos; data/</span>
            </label>
        </div>
    )
}

/** Export of one agent, skill or routine from its page: a routine asks what to bring along first. */
export function ExportButton({ kind, name }: { kind: Kind; name: string }) {
    const [open, setOpen] = useState(false)
    const [withDeps, setWithDeps] = useState(true)
    const [withData, setWithData] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [toast, showToast] = useToast()
    if (kind === 'projects') return null

    const save = async () => {
        setBusy(true)
        setError(null)
        try {
            const { filename, masked } = await api.exportBundle({
                [kind]: [name],
                with_deps: withDeps,
                with_data: withData
            })
            setOpen(false)
            showToast(
                masked
                    ? `Saved ${filename}; secret values masked in ${fmt.plural(masked, 'file')}`
                    : `Saved ${filename}`
            )
        } catch (e) {
            setError((e as Error).message)
            if (kind !== 'routines') showToast((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <>
            <Button
                onClick={() => (kind === 'routines' ? setOpen(true) : void save())}
                disabled={busy}
                title={`A ZIP of this ${KIND_LABEL[kind]} a colleague imports on the Presets page`}
            >
                Export
            </Button>
            {open && (
                <Modal
                    open
                    onClose={() => setOpen(false)}
                    title={`Export ${name}`}
                    description='Secrets and variables are never exported'
                    icon='export'
                    busy={busy}
                    footer={
                        <>
                            <Button onClick={() => setOpen(false)}>Cancel</Button>
                            <Button
                                variant='primary'
                                onClick={() => void save()}
                                disabled={busy}
                            >
                                {busy ? 'Exporting…' : 'Export'}
                            </Button>
                        </>
                    }
                >
                    <ErrorBox error={error} />
                    <ExportOptions
                        withDeps={withDeps}
                        withData={withData}
                        onDeps={setWithDeps}
                        onData={setWithData}
                    />
                </Modal>
            )}
            {toast}
        </>
    )
}
