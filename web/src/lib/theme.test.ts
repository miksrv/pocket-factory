import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyTheme, currentTheme, onThemeChange, setTheme, themeChoice, toggleTheme, watchSystemTheme } from './theme'

type Listener = () => void

function mockMatchMedia(dark: boolean) {
    const listeners = new Set<Listener>()
    const media = {
        matches: dark,
        addEventListener: (_: string, fn: Listener) => listeners.add(fn),
        removeEventListener: (_: string, fn: Listener) => listeners.delete(fn)
    }
    vi.stubGlobal('matchMedia', () => media)
    return {
        flip(to: boolean) {
            media.matches = to
            listeners.forEach((fn) => fn())
        },
        listeners
    }
}

describe('theme', () => {
    beforeEach(() => {
        localStorage.clear()
        delete document.documentElement.dataset.theme
        document.head.innerHTML = '<meta name="theme-color" content="#000">'
    })
    afterEach(() => vi.unstubAllGlobals())

    it('defaults to the system preference and writes it to the document', () => {
        mockMatchMedia(true)
        expect(themeChoice()).toBe('system')
        expect(applyTheme()).toBe('dark')
        expect(document.documentElement.dataset.theme).toBe('dark')
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#171716')
    })

    it('remembers an explicit choice and tells the page', () => {
        mockMatchMedia(true)
        const heard = vi.fn()
        const off = onThemeChange(heard)
        setTheme('light')
        expect(localStorage.getItem('pf.theme')).toBe('light')
        expect(currentTheme()).toBe('light')
        expect(document.documentElement.dataset.theme).toBe('light')
        expect(heard).toHaveBeenCalledTimes(1)
        setTheme('system')
        expect(localStorage.getItem('pf.theme')).toBeNull()
        expect(currentTheme()).toBe('dark')
        off()
    })

    it('ignores garbage in storage', () => {
        mockMatchMedia(false)
        localStorage.setItem('pf.theme', 'neon')
        expect(themeChoice()).toBe('system')
        expect(currentTheme()).toBe('light')
    })

    it('toggles from what is on screen and makes the choice explicit', () => {
        mockMatchMedia(true)
        expect(toggleTheme()).toBe('light')
        expect(themeChoice()).toBe('light')
        expect(toggleTheme()).toBe('dark')
        expect(themeChoice()).toBe('dark')
    })

    it('follows the OS only while the choice is system', () => {
        const media = mockMatchMedia(false)
        const stop = watchSystemTheme()
        applyTheme()
        expect(document.documentElement.dataset.theme).toBe('light')
        media.flip(true)
        expect(document.documentElement.dataset.theme).toBe('dark')
        setTheme('light')
        media.flip(false)
        media.flip(true)
        expect(document.documentElement.dataset.theme).toBe('light')
        stop()
        expect(media.listeners.size).toBe(0)
    })
})
