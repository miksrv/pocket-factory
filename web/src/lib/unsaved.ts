import type { SyntheticEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { type ConfirmOptions, useConfirm } from '../components/Modal'

/**
 * One flag for "a form on screen has unsaved edits". The editor sets it; the
 * sidebar and other navigation ask before leaving. A module-level value, not
 * context: the sidebar renders outside every page and must not re-render on
 * each keystroke.
 */
let dirty = false

export const setUnsaved = (value: boolean) => {
    dirty = value
}

export const isUnsaved = () => dirty

const DISCARD: ConfirmOptions = {
    title: 'Discard unsaved changes?',
    message: 'The form has edits that are not saved. Leaving the page drops them.',
    action: 'Discard',
    danger: true,
    icon: 'warning'
}

/**
 * Navigation that respects the flag. `leave(go)` runs `go` at once when
 * nothing is unsaved, otherwise after the reader agrees to discard. `guard(to)`
 * is the onClick of a link to `to`: a clean click goes through, a dirty one is
 * stopped, asked about, and then navigated by hand.
 */
export function useLeaveGuard() {
    const confirm = useConfirm()
    const navigate = useNavigate()
    const leave = (go: () => void) => {
        if (!dirty) go()
        else void confirm(DISCARD).then((ok) => ok && go())
    }
    const guard = (to: string) => (e: SyntheticEvent) => {
        if (!dirty) return
        e.preventDefault()
        leave(() => navigate(to))
    }
    return { leave, guard }
}
