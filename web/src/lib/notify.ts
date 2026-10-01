/**
 * Desktop notifications for a reply that lands while the tab is hidden.
 * Opt-in: the browser only grants permission from a click, and the owner
 * may not want them at all, so the sidebar has a bell that asks once and
 * remembers the choice here. The browser needs a secure context (https or
 * localhost) for the API to exist at all.
 */

const STORAGE_KEY = 'pf.notify'

export const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window

export function notificationsEnabled(): boolean {
    if (!notificationsSupported || Notification.permission !== 'granted') return false
    try {
        return localStorage.getItem(STORAGE_KEY) !== '0'
    } catch {
        return true
    }
}

/** The browser said no once; only its site settings can undo that. */
export function notificationsBlocked(): boolean {
    return notificationsSupported && Notification.permission === 'denied'
}

/** Flip the switch; asks the browser when it has not been asked yet. Returns the new state. */
export async function toggleNotifications(): Promise<boolean> {
    if (!notificationsSupported) return false
    if (notificationsEnabled()) {
        remember(false)
        return false
    }
    if (Notification.permission === 'denied') return false
    if (Notification.permission !== 'granted') {
        const answer = await Notification.requestPermission()
        if (answer !== 'granted') return false
    }
    remember(true)
    return true
}

function remember(on: boolean) {
    try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
    } catch {
        // private mode etc.
    }
}

/**
 * Show one notification; `tag` makes a newer one replace the one still on
 * screen instead of stacking. Clicking focuses this tab and runs `onClick`
 * (navigate to the thread). Nothing happens while the tab is visible: the
 * owner is already looking.
 */
export function notify(title: string, body: string, tag: string, onClick?: () => void): void {
    if (!notificationsEnabled() || document.visibilityState === 'visible') return
    try {
        const n = new Notification(title, { body, tag, icon: '/icon-192.png' })
        n.onclick = () => {
            window.focus()
            onClick?.()
            n.close()
        }
    } catch {
        // Android Chrome wants a service worker for this; the favicon badge still works.
    }
}
