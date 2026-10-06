import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAsync } from './useAsync'

/** A promise the test settles by hand. */
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('useAsync', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('loads on mount', async () => {
        const { result } = renderHook(() => useAsync(() => Promise.resolve(42)))
        expect(result.current.loading).toBe(true)
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.data).toBe(42)
        expect(result.current.error).toBeUndefined()
    })

    it('reports an error and clears it on the next success', async () => {
        const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('back')
        const { result } = renderHook(() => useAsync<string>(loader))
        await waitFor(() => expect(result.current.error).toBe('offline'))
        expect(result.current.loading).toBe(false)
        act(() => result.current.reload())
        await waitFor(() => expect(result.current.data).toBe('back'))
        expect(result.current.error).toBeUndefined()
    })

    it('reloads when the deps change and ignores a late answer for the old ones', async () => {
        const first = deferred<string>()
        const second = deferred<string>()
        const { result, rerender } = renderHook(
            ({ id }) => useAsync(() => (id === 'a' ? first.promise : second.promise), [id]),
            { initialProps: { id: 'a' } }
        )
        rerender({ id: 'b' })
        await act(async () => {
            second.resolve('for b')
            await second.promise
        })
        expect(result.current.data).toBe('for b')
        await act(async () => {
            first.resolve('for a')
            await first.promise
        })
        expect(result.current.data).toBe('for b')
    })

    it('polls', async () => {
        vi.useFakeTimers()
        let n = 0
        const { result } = renderHook(() => useAsync(() => Promise.resolve(++n), [], 1000))
        await act(async () => {})
        expect(result.current.data).toBe(1)
        await act(async () => vi.advanceTimersByTimeAsync(1000))
        expect(result.current.data).toBe(2)
        await act(async () => vi.advanceTimersByTimeAsync(2000))
        expect(result.current.data).toBe(4)
    })

    it('lets the caller patch the data', async () => {
        const { result } = renderHook(() => useAsync(() => Promise.resolve([1])))
        await waitFor(() => expect(result.current.data).toEqual([1]))
        act(() => result.current.setData([1, 2]))
        expect(result.current.data).toEqual([1, 2])
    })
})
