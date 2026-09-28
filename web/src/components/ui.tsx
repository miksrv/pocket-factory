import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import type { TaskStatus } from '../lib/api'

export function StatusBadge({ status }: { status: TaskStatus }) {
    return <span className={`badge ${status}`}>{status}</span>
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
    return (
        <div className="page-head">
            <div>
                <h1>{title}</h1>
                {sub && <div className="sub">{sub}</div>}
            </div>
            {children && <div className="toolbar">{children}</div>}
        </div>
    )
}

export function Empty({ children }: { children: ReactNode }) {
    return <div className="empty">{children}</div>
}

export function ErrorBox({ error }: { error?: string }) {
    return error ? <div className="card error">{error}</div> : null
}

/** Auto-dismissing status line for save/delete feedback. */
export function useToast(): [ReactNode, (text: string) => void] {
    const [text, setText] = useState<string | null>(null)
    useEffect(() => {
        if (!text) return
        const timer = setTimeout(() => setText(null), 2500)
        return () => clearTimeout(timer)
    }, [text])
    return [text ? <div className="toast">{text}</div> : null, setText]
}
