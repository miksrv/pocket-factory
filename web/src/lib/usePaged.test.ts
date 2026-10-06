import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Cursor } from './api'
import { usePaged } from './usePaged'

interface Row {
    id: string
    ts: string
}

const row = (id: string, ts: string): Row => ({ id, ts })
const options = { key: (r: Row) => r.id, cursor: (r: Row) => r.ts, pageSize: 2 }

/** A server holding `rows` newest first that answers keyset pages on `(ts DESC, id DESC)`. */
function server(rows: Row[]) {
    const fetchPage = vi.fn((before: Cursor | undefined) => {
        const older = before ? rows.filter((r) => r.ts < before.ts || (r.ts === before.ts && r.id < before.id)) : rows
        return Promise.resolve(older.slice(0, options.pageSize))
    })
    return {
        fetchPage,
        set: (next: Row[]) => {
            rows = next
        }
    }
}

const ids = (items: Row[]) => items.map((r) => r.id)

describe('usePaged', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('loads the first page and knows there may be more', async () => {
        const { fetchPage } = server([row('c', '3'), row('b', '2'), row('a', '1')])
        const { result } = renderHook(() => usePaged(fetchPage, options))
        expect(result.current.loading).toBe(true)
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(ids(result.current.items)).toEqual(['c', 'b'])
        expect(result.current.hasMore).toBe(true)
        expect(fetchPage).toHaveBeenCalledWith(undefined)
    })

    it('asks for the next page after the last item, ties broken by id', async () => {
        const { fetchPage } = server([row('d', '2'), row('c', '2'), row('b', '2'), row('a', '1')])
        const { result } = renderHook(() => usePaged(fetchPage, options))
        await waitFor(() => expect(result.current.items).toHaveLength(2))
        act(() => result.current.loadMore())
        await waitFor(() => expect(result.current.items).toHaveLength(4))
        expect(fetchPage).toHaveBeenLastCalledWith({ ts: '2', id: 'c' })
        expect(ids(result.current.items)).toEqual(['d', 'c', 'b', 'a'])
        expect(result.current.hasMore).toBe(true)
        act(() => result.current.loadMore())
        await waitFor(() => expect(result.current.hasMore).toBe(false))
        expect(ids(result.current.items)).toEqual(['d', 'c', 'b', 'a'])
    })

    it('stops at a short page', async () => {
        const { fetchPage } = server([row('a', '1')])
        const { result } = renderHook(() => usePaged(fetchPage, options))
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.hasMore).toBe(false)
    })

    it('honours a custom end-of-list rule', async () => {
        const { fetchPage } = server([row('c', '3'), row('b', '2'), row('a', '1')])
        const { result } = renderHook(() => usePaged(fetchPage, { ...options, hasMore: () => false }))
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.hasMore).toBe(false)
    })

    it('merges a fresh first page over the list, dropping rows that left it', async () => {
        const backend = server([row('d', '4'), row('c', '3'), row('b', '2'), row('a', '1')])
        const { result } = renderHook(() => usePaged(backend.fetchPage, options))
        await waitFor(() => expect(result.current.items).toHaveLength(2))
        act(() => result.current.loadMore())
        await waitFor(() => expect(result.current.items).toHaveLength(4))
        // A new row arrived and `d` was deleted: the fresh page is e, c. Rows older than its tail stay as they are.
        backend.set([row('e', '5'), row('c', '3'), row('b', '2'), row('a', '1')])
        act(() => result.current.refresh())
        await waitFor(() => expect(ids(result.current.items)).toEqual(['e', 'c', 'b', 'a']))
        expect(result.current.loading).toBe(false)
    })

    it('polls the first page', async () => {
        vi.useFakeTimers()
        const backend = server([row('a', '1')])
        const { result } = renderHook(() => usePaged(backend.fetchPage, { ...options, pollMs: 1000 }))
        await act(async () => {})
        expect(ids(result.current.items)).toEqual(['a'])
        backend.set([row('b', '2'), row('a', '1')])
        await act(async () => vi.advanceTimersByTimeAsync(1000))
        expect(ids(result.current.items)).toEqual(['b', 'a'])
    })

    it('starts over when the deps change', async () => {
        const fetchPage = vi.fn((_before: Cursor | undefined) => Promise.resolve([row(filter, '1')]))
        let filter = 'running'
        const { result, rerender } = renderHook(({ f }) => usePaged(fetchPage, { ...options, deps: [f] }), {
            initialProps: { f: filter }
        })
        await waitFor(() => expect(ids(result.current.items)).toEqual(['running']))
        filter = 'done'
        rerender({ f: filter })
        await waitFor(() => expect(ids(result.current.items)).toEqual(['done']))
    })

    it('reports a failed page', async () => {
        const fetchPage = vi.fn(() => Promise.reject(new Error('API down')))
        const { result } = renderHook(() => usePaged<Row>(fetchPage, options))
        await waitFor(() => expect(result.current.error).toBe('API down'))
        expect(result.current.loading).toBe(false)
        expect(result.current.items).toEqual([])
    })

    it('lets the caller edit the items', async () => {
        const { fetchPage } = server([row('b', '2'), row('a', '1')])
        const { result } = renderHook(() => usePaged(fetchPage, options))
        await waitFor(() => expect(result.current.items).toHaveLength(2))
        act(() => result.current.setItems((items) => items.filter((r) => r.id !== 'b')))
        expect(ids(result.current.items)).toEqual(['a'])
    })
})
