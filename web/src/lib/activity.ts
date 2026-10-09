/**
 * Whether the owner is at the page. The API's session idle timeout counts
 * only requests the SPA marks as the owner's activity (`x-factory-active`):
 * the status poll, the chat stream and image loads alone must not keep a
 * browser signed in overnight. "At the page" = a key, pointer, touch or
 * wheel event, or the tab becoming visible, within the last few minutes.
 */

export const ACTIVE_HEADER = 'x-factory-active'
/** How long after the last interaction a request still counts as the owner's. */
const ACTIVE_FOR_MS = 5 * 60_000
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

let lastInteraction = 0

function markActive() {
    lastInteraction = Date.now()
}

/** Install the listeners once at start; the page just opened counts as activity. */
export function trackActivity(): () => void {
    if (document.visibilityState === 'visible') markActive()
    const onVisible = () => {
        if (document.visibilityState === 'visible') markActive()
    }
    for (const e of EVENTS) window.addEventListener(e, markActive, { passive: true })
    document.addEventListener('visibilitychange', onVisible)
    return () => {
        for (const e of EVENTS) window.removeEventListener(e, markActive)
        document.removeEventListener('visibilitychange', onVisible)
    }
}

export function isActive(now = Date.now()): boolean {
    return now - lastInteraction < ACTIVE_FOR_MS
}

/** The header for a request made while the owner is at the page, else nothing. */
export function activeHeaders(): Record<string, string> {
    return isActive() ? { [ACTIVE_HEADER]: '1' } : {}
}

/** Tests only. */
export function resetActivity(): void {
    lastInteraction = 0
}
