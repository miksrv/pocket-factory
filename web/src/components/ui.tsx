import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode, TextareaHTMLAttributes } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type TaskStatus } from '../lib/api'
import { Icon } from './Icon'
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
        // The handler only reads the event (a guard calls preventDefault), so the element type is immaterial.
        const onClick = rest.onClick as unknown as MouseEventHandler<HTMLAnchorElement> | undefined
        return (
            <Link to={to} className={buttonClass(variant, size, className)} title={rest.title} aria-label={rest['aria-label']} onClick={onClick}>
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


/**
 * The one "×" button: closes a modal or the phone menu, removes a row in an
 * editor. A ghost square with an icon, big enough to hit; the caller says
 * what it closes in `aria-label`.
 */
export function CloseButton({ label, className, ...rest }: { label: string; className?: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>) {
    return (
        <Button variant="ghost" className={className ? `close-btn ${className}` : 'close-btn'} aria-label={label} title={rest.title ?? label} {...rest}>
            <Icon name="close" size={16} />
        </Button>
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
 * `children` are controls that go with the action (a project selector);
 * `note` is a footnote under it.
 */
export function Intro({ text, action, onAction, note, children }: { text: ReactNode; action: string; onAction: () => void; note?: ReactNode; children?: ReactNode }) {
    const button = (
        <Button variant="primary" onClick={onAction}>
            {action}
        </Button>
    )
    return (
        <div className="intro">
            <div className="empty">
                <p>{text}</p>
                {children ? (
                    <div className="intro-form">
                        {children}
                        {button}
                    </div>
                ) : (
                    button
                )}
                {note && <p className="dim small">{note}</p>}
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
export function FilterSelect({ value, onChange, all, options, label, disabled }: { value: string; onChange: (value: string) => void; all: string; options: string[]; label: string; disabled?: boolean }) {
    return (
        <select className="filter" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={disabled}>
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

/** A textarea for a sentence or two that grows with its text instead of scrolling. */
export function GrowingTextarea({ value, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
    const ref = useRef<HTMLTextAreaElement>(null)
    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${el.scrollHeight + 2}px`
    }, [value])
    return <textarea ref={ref} className={className ? `short ${className}` : 'short'} rows={1} value={value} {...rest} />
}

/** Sanitized Markdown from the agent (newlines break lines) or from a file (`document`: paragraphs reflow). */
export function Markdown({ source, className, document }: { source: string; className?: string; document?: boolean }) {
    return <div className={className ? `md ${className}` : 'md'} dangerouslySetInnerHTML={{ __html: renderMarkdown(source, { breaks: !document }) }} />
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
