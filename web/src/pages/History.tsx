import { useState } from 'react'

import { Empty, ErrorBox, PageHead } from '../components/ui'
import { fmt } from '../lib/api'
import { useAsync } from '../lib/useAsync'

interface Entry {
    repo: string
    hash: string
    date: string
    message: string
    files: string[]
}

async function fetchLog(): Promise<Entry[]> {
    const r = await fetch('/api/history')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
}

export function HistoryPage() {
    const log = useAsync(fetchLog, [], 15_000)
    const [open, setOpen] = useState<Entry | null>(null)
    const [diff, setDiff] = useState<string>('')

    const show = async (entry: Entry) => {
        setOpen(entry)
        setDiff('loading…')
        const r = await fetch(`/api/history/${entry.repo}/${entry.hash}`)
        setDiff(await r.text())
    }

    return (
        <div className="page wide">
            <PageHead title="History" sub="Every change to agents, skills, projects and dispatcher rules is a git commit on the volume — whether made here, by hand, or by the agent itself." />
            <ErrorBox error={log.error} />
            <div className="editor-layout" style={{ gridTemplateColumns: '420px 1fr' }}>
                <div className="card pad0">
                    {log.data?.length ? (
                        <table>
                            <thead>
                                <tr>
                                    <th>Change</th>
                                    <th>When</th>
                                </tr>
                            </thead>
                            <tbody>
                                {log.data.map((entry) => (
                                    <tr key={entry.repo + entry.hash} className={`click${open?.hash === entry.hash ? ' selected' : ''}`} onClick={() => show(entry)}>
                                        <td>
                                            <div>{entry.message}</div>
                                            <div className="dim small mono">
                                                {entry.repo} · {entry.hash.slice(0, 7)}
                                                {entry.files.length > 0 && ` · ${entry.files.join(', ')}`}
                                            </div>
                                        </td>
                                        <td className="dim nowrap small">{fmt.ago(entry.date)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <Empty>{log.loading ? 'Loading…' : 'No history yet.'}</Empty>
                    )}
                </div>
                <div className="card">
                    {open ? <pre style={{ margin: 0, maxHeight: '75vh' }}>{diff}</pre> : <div className="dim">Select a commit to see its diff.</div>}
                </div>
            </div>
        </div>
    )
}
