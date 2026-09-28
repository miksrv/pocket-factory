import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type TaskStatus } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'

/*
 * The shared vocabulary of the UI. Every page composes these instead of
 * repeating the markup, so a change here changes every screen at once.
 */

type Variant = 'primary' | 'danger' | 'ghost'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant
    /** Compact height for toolbars, table rows and card heads. */
    size?: 'sm'
    /** Render as a router link that looks like a button. */
    to?: string
}

const buttonClass = (variant?: Variant, size?: 'sm', className?: string) => ['btn', variant, size, className].filter(Boolean).join(' ')

/** The one button: `<Button variant="primary">`, `<Button size="sm" to="/tasks">`. */
export function Button({ variant, size, to, className, type = 'button', children, ...rest }: ButtonProps) {
    if (to) {
        return (
            <Link to={to} className={buttonClass(variant, size, className)} title={rest.title} aria-label={rest['aria-label']}>
                {children}
            </Link>
        )
    }
    return (
        <button type={type} className={buttonClass(variant, size, className)} {...rest}>
            {children}
        </button>
    )
}

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

export function ErrorBox({ error }: { error?: string | null }) {
    return error ? <div className="card error">{error}</div> : null
}

/**
 * What a pane says before there is anything to show: one sentence and the
 * action that fills it (Chat before a thread, the editor before an entry).
 */
export function Intro({ text, action, onAction }: { text: ReactNode; action: string; onAction: () => void }) {
    return (
        <div className="intro">
            <div className="empty">
                <p>{text}</p>
                <Button variant="primary" onClick={onAction}>
                    {action}
                </Button>
            </div>
        </div>
    )
}

/** A labelled figure: inline in a stat row, or its own card with an optional footnote. */
export function Stat({ label, value, sub, to, card }: { label: string; value: ReactNode; sub?: string; to?: string; card?: boolean }) {
    const className = `stat${card ? ' card' : ''}`
    const body = (
        <>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
            {sub && <div className="dim small">{sub}</div>}
        </>
    )
    return to ? (
        <Link to={to} className={className}>
            {body}
        </Link>
    ) : (
        <div className={className}>{body}</div>
    )
}

/** Segmented control: one active value out of a few. */
export function Tabs<T extends string>({ items, value, onChange }: { items: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (value: T) => void }) {
    return (
        <div className="tabs" role="tablist">
            {items.map((item) => (
                <button key={item.value} type="button" role="tab" aria-selected={value === item.value} className={value === item.value ? 'active' : ''} onClick={() => onChange(item.value)}>
                    {item.label}
                </button>
            ))}
        </div>
    )
}

/**
 * A filter dropdown with an "all" entry. A value that is not in `options`
 * (from a URL, or a project that no longer exists) still shows as selected.
 */
export function FilterSelect({ value, onChange, all, options, label }: { value: string; onChange: (value: string) => void; all: string; options: string[]; label: string }) {
    return (
        <select className="filter" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
            <option value="">{all}</option>
            {value && !options.includes(value) && <option value={value}>{value}</option>}
            {options.map((o) => (
                <option key={o} value={o}>
                    {o}
                </option>
            ))}
        </select>
    )
}

/** Sanitized Markdown from the agent, a file or a preset README. */
export function Markdown({ source, className }: { source: string; className?: string }) {
    return <div className={className ? `md ${className}` : 'md'} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
}

/** Stops a queued or running task; the same control on the Tasks list, the task page and the chat head. */
export function StopButton({ taskId, size, onStopped }: { taskId: string; size?: 'sm'; onStopped?: () => void }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const stop = async () => {
        setBusy(true)
        setError(null)
        try {
            await api.stopTask(taskId)
            onStopped?.()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    return (
        <Button variant="danger" size={size} onClick={stop} disabled={busy} title={error ?? undefined} className={error ? 'failed' : undefined}>
            {busy ? 'Stopping…' : error ? 'Retry stop' : 'Stop'}
        </Button>
    )
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
