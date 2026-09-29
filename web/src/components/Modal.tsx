import type { MouseEvent, PointerEvent, ReactNode, SyntheticEvent } from 'react'
import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState } from 'react'

import type { IconName } from './Icon'
import { Tile } from './Tile'
import { Button } from './ui'

/*
 * Modal windows on a native <dialog> in the top layer: the browser traps the
 * focus, makes the page behind inert, closes on Escape and returns the focus
 * to the control that opened the window. This file adds the look, a busy
 * state that cannot be dismissed, and the confirmation built on it;
 * `useConfirm` asks a question from any event handler and resolves with the
 * answer, so a delete handler reads as one `await`.
 */

export interface ModalProps {
    open: boolean
    /** Asked to close: Escape, a click on the backdrop, the × or a Cancel button. Ignored while `busy`. */
    onClose: () => void
    title: ReactNode
    /** One or two sentences under the title; also the dialog's accessible description. */
    description?: ReactNode
    /** The tile in the top-left corner; `tone: 'danger'` paints it red. */
    icon?: IconName
    tone?: 'danger'
    /** The buttons of the footer, the main action last. */
    footer?: ReactNode
    /** An action is in flight: the window cannot be dismissed and its buttons are disabled. */
    busy?: boolean
    /** The × in the corner; off for a confirmation, whose Cancel is the way out. */
    closeButton?: boolean
    children?: ReactNode
}

export function Modal({ open, onClose, title, description, icon, tone, footer, busy, closeButton = true, children }: ModalProps) {
    const ref = useRef<HTMLDialogElement>(null)
    const id = useId()
    const downOnBackdrop = useRef(false)

    // showModal / close follow `open`; the cleanup also closes before unmount,
    // which is what hands the focus back to the opener.
    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        if (open && !el.open) {
            el.showModal()
            // The safe default takes the focus (Cancel on a destructive question); the browser would pick the first button.
            el.querySelector<HTMLElement>('[data-autofocus]')?.focus()
        }
        return () => {
            if (el.open) el.close()
        }
    }, [open])

    const dismiss = () => {
        if (!busy) onClose()
    }
    // Escape: the browser would close the element on its own; keep the state in charge.
    const onCancel = (e: SyntheticEvent) => {
        e.preventDefault()
        dismiss()
    }
    // A click on the backdrop targets the element itself. The press has to start
    // there too, so a text selection that ends outside the window keeps it open.
    const onPointerDown = (e: PointerEvent) => {
        downOnBackdrop.current = e.target === e.currentTarget
    }
    const onClick = (e: MouseEvent) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) dismiss()
    }

    return (
        <dialog
            ref={ref}
            className={`modal${tone ? ` ${tone}` : ''}`}
            aria-labelledby={`${id}-title`}
            aria-describedby={description ? `${id}-desc` : undefined}
            aria-busy={busy || undefined}
            onCancel={onCancel}
            // The browser closed the element on its own (a forced close): mirror it. Our own close() also fires this,
            // after the element may already be shown again (StrictMode re-runs the effect), hence the second check.
            onClose={() => open && !ref.current?.open && dismiss()}
            onPointerDown={onPointerDown}
            onClick={onClick}
        >
            <div className="modal-body">
                {icon && <Tile icon={icon} color={tone === 'danger' ? 'red' : 'gray'} />}
                <div className="grow modal-main">
                    <h2 id={`${id}-title`} className="modal-title">
                        {title}
                    </h2>
                    {description && (
                        <div id={`${id}-desc`} className="modal-text">
                            {description}
                        </div>
                    )}
                    {children}
                </div>
                {closeButton && (
                    <Button variant="ghost" size="sm" className="modal-close" aria-label="Close" onClick={dismiss} disabled={busy}>
                        ×
                    </Button>
                )}
            </div>
            {footer && <div className="modal-foot">{footer}</div>}
        </dialog>
    )
}

export interface ConfirmOptions {
    title: ReactNode
    /** What happens on confirmation, in one or two sentences: the consequence, and whether it can be undone. */
    message?: ReactNode
    /** The label of the confirming button: the verb of the action ("Delete"), never "OK" or "Yes". */
    action?: string
    /** The label while `onConfirm` runs ("Deleting…"). */
    pending?: string
    cancel?: string
    /** Destructive: a red filled action, Cancel takes the focus first, the tile is red. */
    danger?: boolean
    icon?: IconName
    /**
     * Runs while the window stays open with the action busy; the window closes
     * once it resolves. A throw shows the error inline so the reader can retry
     * or cancel, and `confirm` resolves true only after a success.
     */
    onConfirm?: () => Promise<void> | void
}

/** A question with two answers; the declarative form, for a page that keeps the state itself. */
export function ConfirmDialog({
    open,
    title,
    message,
    action = 'Confirm',
    pending,
    cancel = 'Cancel',
    danger,
    icon,
    busy,
    error,
    onConfirm,
    onCancel
}: Omit<ConfirmOptions, 'onConfirm'> & { open: boolean; busy?: boolean; error?: string | null; onConfirm: () => void; onCancel: () => void }) {
    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={title}
            description={message}
            icon={icon ?? (danger ? 'warning' : undefined)}
            tone={danger ? 'danger' : undefined}
            busy={busy}
            closeButton={false}
            footer={
                <>
                    <Button onClick={onCancel} disabled={busy} data-autofocus={danger || undefined}>
                        {cancel}
                    </Button>
                    <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy} data-autofocus={!danger || undefined}>
                        {busy ? (pending ?? `${action}…`) : action}
                    </Button>
                </>
            }
        >
            {error && (
                <div className="error small modal-error" role="alert">
                    {error}
                </div>
            )}
        </Modal>
    )
}

interface Request {
    options: ConfirmOptions
    resolve: (ok: boolean) => void
}

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)

/** Mounts the one confirmation window of the app and hands out `useConfirm`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
    const current = useRef<Request | null>(null)
    const [request, setRequest] = useState<Request | null>(null)
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const confirm = useCallback(
        (options: ConfirmOptions) =>
            new Promise<boolean>((resolve) => {
                current.current?.resolve(false) // a question asked over another one answers the first with "no"
                const next = { options, resolve }
                current.current = next
                setRequest(next)
                setError(null)
                setBusy(false)
                setOpen(true)
            }),
        []
    )

    // The request stays mounted after the answer so the window can close in place and return the focus.
    const settle = (ok: boolean) => {
        setOpen(false)
        current.current?.resolve(ok)
        current.current = null
    }
    const run = async () => {
        const onConfirm = request?.options.onConfirm
        if (!onConfirm) return settle(true)
        setBusy(true)
        setError(null)
        try {
            await onConfirm()
            settle(true)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            {request && <ConfirmDialog {...request.options} open={open} busy={busy} error={error} onConfirm={() => void run()} onCancel={() => !busy && settle(false)} />}
        </ConfirmContext.Provider>
    )
}

/**
 * `const confirm = useConfirm()`, then in a handler:
 * `if (!(await confirm({ title: 'Delete X?', action: 'Delete', danger: true }))) return`.
 * With `onConfirm` the window shows the busy action and any error itself.
 */
export function useConfirm() {
    const confirm = useContext(ConfirmContext)
    if (!confirm) throw new Error('useConfirm needs a <ConfirmProvider> above it')
    return confirm
}
