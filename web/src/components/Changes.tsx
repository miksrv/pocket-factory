import { ChevronRight, ExternalLink, GitBranch, GitPullRequest } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { api, type ChangedFile, type PullRequest, type Task } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Button, ErrorBox, Markdown } from './ui'

/**
 * What a task changed, built for deciding from a phone rather than reading
 * every line: the agent's report first, then the size and the PR button,
 * then the files by folder (lock files and build output folded), and the
 * diff of one file only when it is tapped.
 */
export function Changes({ task, onChanged }: { task: Task; onChanged?: () => void }) {
    const changes = useAsync(() => api.taskChanges(task.id), [task.id, task.git?.head])
    const [pr, setPr] = useState<PullRequest | null>(null)
    const [creating, setCreating] = useState(false)
    const [prError, setPrError] = useState<string | null>(null)

    // Arriving from the chat or a Telegram link (`#changes`): the panel is the point of the visit.
    const section = useRef<HTMLElement>(null)
    const hasChanges = Boolean(task.git?.head)
    useEffect(() => {
        if (hasChanges && window.location.hash === '#changes') section.current?.scrollIntoView({ block: 'start' })
    }, [hasChanges])

    if (!task.git?.head) return null
    const git = changes.data?.git ?? task.git
    const current = pr ?? changes.data?.pr ?? git.pr ?? null
    const files = changes.data?.files ?? []
    const canOpenPr = Boolean(git.branch && git.default_branch && git.branch !== git.default_branch && (git.files ?? 0) > 0)

    const createPr = async () => {
        setCreating(true)
        setPrError(null)
        try {
            setPr(await api.createPullRequest(task.id))
            onChanged?.()
        } catch (e) {
            setPrError((e as Error).message)
        } finally {
            setCreating(false)
        }
    }

    return (
        <section className="changes" id="changes" ref={section}>
            <h2>Changes</h2>
            <div className="card changes-card">
                {task.result && <Summary text={task.result} />}
                <div className="changes-head">
                    <span className="changes-size">
                        {git.files ? (
                            <>
                                <strong>{git.files}</strong> {git.files === 1 ? 'file' : 'files'} <span className="add">+{git.added ?? 0}</span> <span className="del">−{git.removed ?? 0}</span>
                            </>
                        ) : (
                            'No committed changes'
                        )}
                    </span>
                    {git.branch && (
                        <span className="dim branch" title={`${git.base?.slice(0, 8)}..${git.head?.slice(0, 8)}`}>
                            <GitBranch size={12} /> {git.branch}
                            {git.default_branch && git.branch !== git.default_branch ? ` → ${git.default_branch}` : ''}
                        </span>
                    )}
                    <span className="grow" />
                    {current ? (
                        <Button size="sm" href={current.url} title={current.title}>
                            <GitPullRequest size={13} /> PR #{current.number}
                            {current.state !== 'OPEN' ? ` · ${current.state.toLowerCase()}` : current.isDraft ? ' · draft' : ''} <ExternalLink size={11} />
                        </Button>
                    ) : (
                        canOpenPr && (
                            <Button size="sm" variant="primary" onClick={createPr} disabled={creating} title={`Push ${git.branch} and open a pull request against ${git.default_branch}`}>
                                <GitPullRequest size={13} /> {creating ? 'Creating…' : 'Create PR'}
                            </Button>
                        )
                    )}
                </div>
                {prError && <div className="tool error">{prError}</div>}
                {(git.uncommitted ?? 0) > 0 && (
                    <div className="dim small">
                        {git.uncommitted} file{git.uncommitted === 1 ? ' was' : 's were'} left uncommitted in the checkout and {git.uncommitted === 1 ? 'is' : 'are'} not shown here.
                    </div>
                )}
                <ErrorBox error={changes.error} />
                {changes.loading && !changes.data && <div className="dim small">Reading the changes…</div>}
                {files.length > 0 && <FileTree taskId={task.id} files={files} />}
            </div>
        </section>
    )
}

const SUMMARY_LINES = 8

/** The agent's report, cut to a few lines with "Show all": the first thing to read on a phone. */
function Summary({ text }: { text: string }) {
    const [open, setOpen] = useState(false)
    const lines = text.trim().split('\n')
    const long = lines.length > SUMMARY_LINES || text.length > 900
    const shown = open || !long ? text : lines.slice(0, SUMMARY_LINES).join('\n').slice(0, 900)
    return (
        <div className="changes-summary">
            <Markdown source={shown} />
            {long && (
                <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
                    {open ? 'Show less' : 'Show the whole report'}
                </Button>
            )}
        </div>
    )
}

/** Files by folder; the generated ones in a folded group of their own at the end. */
function FileTree({ taskId, files }: { taskId: string; files: ChangedFile[] }) {
    const [showGenerated, setShowGenerated] = useState(false)
    const source = files.filter((f) => !f.generated)
    const generated = files.filter((f) => f.generated)
    const folders = new Map<string, ChangedFile[]>()
    for (const file of source) {
        const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
        folders.set(dir, [...(folders.get(dir) ?? []), file])
    }
    const sum = (list: ChangedFile[], key: 'added' | 'removed') => list.reduce((n, f) => n + f[key], 0)
    return (
        <div className="file-tree">
            {[...folders.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([dir, list]) => (
                    <div key={dir} className="file-group">
                        {dir && <div className="file-dir">{dir}</div>}
                        {list.map((f) => (
                            <FileRow key={f.path} taskId={taskId} file={f} name={f.path.slice(dir.length)} />
                        ))}
                    </div>
                ))}
            {generated.length > 0 && (
                <div className="file-group">
                    <Button variant="ghost" className="file-row generated-toggle" onClick={() => setShowGenerated(!showGenerated)} aria-expanded={showGenerated}>
                        <ChevronRight size={13} className={showGenerated ? 'open' : ''} />
                        <span className="name dim">
                            {generated.length} generated file{generated.length === 1 ? '' : 's'} (lock files, build output)
                        </span>
                        <span className="counts">
                            <span className="add">+{sum(generated, 'added')}</span> <span className="del">−{sum(generated, 'removed')}</span>
                        </span>
                    </Button>
                    {showGenerated && generated.map((f) => <FileRow key={f.path} taskId={taskId} file={f} name={f.path} />)}
                </div>
            )}
        </div>
    )
}

const STATUS: Record<string, string> = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', M: 'modified', T: 'type changed' }

/** One file: tap to load and show its diff. */
function FileRow({ taskId, file, name }: { taskId: string; file: ChangedFile; name: string }) {
    const [open, setOpen] = useState(false)
    const [patch, setPatch] = useState<{ patch: string; truncated: boolean } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const toggle = () => {
        setOpen(!open)
        if (!patch && !file.binary) {
            api.taskChangeFile(taskId, file.path)
                .then(setPatch)
                .catch((e: Error) => setError(e.message))
        }
    }
    return (
        <div className={`file-entry${open ? ' open' : ''}`}>
            <Button variant="ghost" className="file-row" onClick={toggle} aria-expanded={open} title={file.from ? `${file.from} → ${file.path}` : file.path}>
                <ChevronRight size={13} className={open ? 'open' : ''} />
                <span className={`file-status s-${file.status}`} title={STATUS[file.status] ?? file.status}>
                    {file.status}
                </span>
                <span className="name">{name}</span>
                <span className="counts">{file.binary ? <span className="dim">binary</span> : <><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></>}</span>
            </Button>
            {open && (
                <div className="file-diff">
                    {file.binary && <div className="dim small">A binary file: no line diff.</div>}
                    {error && <div className="tool error">{error}</div>}
                    {!file.binary && !patch && !error && <div className="dim small">Loading…</div>}
                    {patch && <PatchView patch={patch.patch} />}
                    {patch?.truncated && <div className="dim small">The diff is cut here; the rest is in the pull request.</div>}
                </div>
            )}
        </div>
    )
}

/** A unified diff as wrapped lines (no sideways scrolling on a phone), file headers dropped, hunks marked. */
function PatchView({ patch }: { patch: string }) {
    const lines = patch.split('\n')
    const body = lines.slice(Math.max(0, lines.findIndex((l) => l.startsWith('@@'))))
    return (
        <div className="patch">
            {body.map((line, i) => {
                const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'meta' : 'ctx'
                return (
                    <div key={i} className={`pl ${kind}`}>
                        {kind === 'hunk' ? line.replace(/^@@ [^@]* @@ ?/, '⋯ ') || '⋯' : line || ' '}
                    </div>
                )
            })}
        </div>
    )
}
