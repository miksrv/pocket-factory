import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { activeHeaders, isActive, resetActivity, trackActivity } from './activity'

describe('activity', () => {
    let stop: () => void
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-10-09T09:00:00Z'))
        resetActivity()
    })
    afterEach(() => {
        stop?.()
        vi.useRealTimers()
    })

    it('counts the page opening as activity, for a few minutes', () => {
        expect(isActive()).toBe(false)
        stop = trackActivity()
        expect(activeHeaders()).toEqual({ 'x-factory-active': '1' })
        vi.advanceTimersByTime(4 * 60_000)
        expect(isActive()).toBe(true)
        vi.advanceTimersByTime(2 * 60_000)
        expect(isActive()).toBe(false)
        expect(activeHeaders()).toEqual({})
    })

    it('a key press or a click makes the page active again', () => {
        stop = trackActivity()
        vi.advanceTimersByTime(10 * 60_000)
        expect(isActive()).toBe(false)
        window.dispatchEvent(new Event('keydown'))
        expect(isActive()).toBe(true)
        vi.advanceTimersByTime(10 * 60_000)
        window.dispatchEvent(new Event('pointerdown'))
        expect(isActive()).toBe(true)
    })

    it('the tab becoming visible counts, hidden does not', () => {
        stop = trackActivity()
        vi.advanceTimersByTime(10 * 60_000)
        const state = vi.spyOn(document, 'visibilityState', 'get')
        state.mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
        expect(isActive()).toBe(false)
        state.mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        expect(isActive()).toBe(true)
        state.mockRestore()
    })

    it('stops listening when told', () => {
        stop = trackActivity()
        stop()
        vi.advanceTimersByTime(10 * 60_000)
        window.dispatchEvent(new Event('keydown'))
        expect(isActive()).toBe(false)
    })
})
