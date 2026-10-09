/**
 * Light or dark: the choice lives in `localStorage` (`pf.theme`), `system`
 * follows the browser's preference. `<html data-theme>` carries the resolved
 * value for the stylesheet; the inline script in index.html sets it before
 * the first paint from the same key, so a reload never flashes the other
 * theme. The PWA's theme-color follows, so the phone's status bar matches.
 */

export type ThemeChoice = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'pf.theme'
const EVENT = 'pf:theme'
const THEME_COLOR: Record<Theme, string> = { light: '#1d1d1b', dark: '#171716' }

export const THEME_CHOICES: Array<{ value: ThemeChoice; label: string; hint: string }> = [
    { value: 'system', label: 'System', hint: 'follows the browser or OS setting' },
    { value: 'light', label: 'Light', hint: 'paper and a dot grid' },
    { value: 'dark', label: 'Dark', hint: 'the same palette on charcoal' }
]

export function themeChoice(): ThemeChoice {
    try {
        const v = localStorage.getItem(STORAGE_KEY)
        return v === 'light' || v === 'dark' ? v : 'system'
    } catch {
        return 'system'
    }
}

function systemTheme(): Theme {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** What is on screen now. */
export function currentTheme(): Theme {
    const choice = themeChoice()
    return choice === 'system' ? systemTheme() : choice
}

/** Write the resolved theme to the document; called at start, on a change and when the OS flips. */
export function applyTheme(): Theme {
    const theme = currentTheme()
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
    return theme
}

export function setTheme(choice: ThemeChoice): void {
    try {
        if (choice === 'system') localStorage.removeItem(STORAGE_KEY)
        else localStorage.setItem(STORAGE_KEY, choice)
    } catch {
        // private mode etc.: the choice lasts for this page
    }
    applyTheme()
    window.dispatchEvent(new Event(EVENT))
}

/** The sidebar's switch: dark ↔ light from whatever is on screen now (a `system` choice becomes explicit). */
export function toggleTheme(): Theme {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
    setTheme(next)
    return next
}

/** Keep the document in step with the OS while the choice is `system`; returns the unsubscribe. */
export function watchSystemTheme(): () => void {
    if (typeof matchMedia !== 'function') return () => {}
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
        if (themeChoice() === 'system') {
            applyTheme()
            window.dispatchEvent(new Event(EVENT))
        }
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
}

/** Subscribe to theme changes made anywhere in the page; returns the unsubscribe. */
export function onThemeChange(fn: () => void): () => void {
    window.addEventListener(EVENT, fn)
    return () => window.removeEventListener(EVENT, fn)
}
