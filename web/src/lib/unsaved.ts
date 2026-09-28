/**
 * One flag for "a form on screen has unsaved edits". The editor sets it; the
 * sidebar and other navigation ask before leaving. A module-level value, not
 * context: the sidebar renders outside every page and must not re-render on
 * each keystroke.
 */
let dirty = false

export const DISCARD = 'You have unsaved changes. Discard them?'

export const setUnsaved = (value: boolean) => {
    dirty = value
}

/** True when it is fine to navigate away: nothing unsaved, or the reader agreed to drop it. */
export const confirmLeave = () => !dirty || window.confirm(DISCARD)
