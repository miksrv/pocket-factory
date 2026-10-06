import { useCallback, useEffect, useRef, useState } from 'react'

import type { Cursor } from './api'

export interface Paged<T> {
    items: T[]
    loading: boolean
    error?: string
    hasMore: boolean
    /** Fetch the next page (older items) and append it. */
    loadMore: () => void
    /** Start over from the first page. */
    reload: () => void
    /** Merge a fresh first page over the list now (what polling does), without a loading state or a rebuild. */
    refresh: () => void
    setItems: (update: (items: T[]) => T[]) => void
}

/**
 * Keyset-paged list: the first page loads on mount (and when `deps` change),
 * `loadMore` appends the page before the last item's cursor, and polling
 * refreshes the first page only, merging it over what is already shown so a
 * long scrolled list is never rebuilt. Items the fresh page no longer holds
 * (a task that left the `running` filter, a deleted conversation) are dropped.
 */
export function usePaged<T>(
    fetchPage: (before: Cursor | undefined) => Promise<T[]>,
    options: {
        key: (item: T) => string
        cursor: (item: T) => string
        pageSize: number
        deps?: unknown[]
        pollMs?: number
        hasMore?: (page: T[]) => boolean
    }
): Paged<T> {
    const { key, cursor, pageSize, pollMs } = options
    const [items, setItems] = useState<T[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | undefined>()
    const [hasMore, setHasMore] = useState(false)
    const generation = useRef(0)
    const itemsRef = useRef<T[]>([])
    itemsRef.current = items
    /** Generation of the request in flight, so a reset is never blocked by (or unblocked by) an older one. */
    const busy = useRef<number | null>(null)
    /** A refresh asked for while a request was in flight runs once that request is done, so it is never lost. */
    const again = useRef(false)
    const cursorOf = (item: T): Cursor => ({ ts: cursor(item), id: key(item) })
    const more = options.hasMore ?? ((page: T[]) => page.length >= pageSize)
    /** Strictly older on the server's `(ts DESC, id DESC)` order; numeric ids (audit events) compare as numbers. */
    const olderThan = (item: T, floor: T): boolean => {
        const a = cursor(item)
        const b = cursor(floor)
        if (a !== b) return a < b
        const ai = key(item)
        const bi = key(floor)
        const an = Number(ai)
        const bn = Number(bi)
        return ai !== '' && bi !== '' && Number.isFinite(an) && Number.isFinite(bn) ? an < bn : ai < bi
    }

    const load = useCallback(
        (mode: 'reset' | 'more' | 'poll') => {
            if (mode !== 'reset' && busy.current !== null) {
                if (mode === 'poll') again.current = true
                return
            }
            if (mode === 'more' && itemsRef.current.length === 0) return
            const gen = mode === 'reset' ? ++generation.current : generation.current
            const before = mode === 'more' ? cursorOf(itemsRef.current[itemsRef.current.length - 1]) : undefined
            busy.current = gen
            if (mode !== 'poll') setLoading(true)
            fetchPage(before)
                .then((page) => {
                    if (gen !== generation.current) return
                    setError(undefined)
                    if (mode === 'reset') {
                        setItems(page)
                        setHasMore(more(page))
                    } else if (mode === 'more') {
                        const known = new Set(itemsRef.current.map(key))
                        const fresh = page.filter((item) => !known.has(key(item)))
                        setItems((prev) => [...prev, ...fresh])
                        // A page of nothing new means the end, whatever its size.
                        setHasMore(fresh.length > 0 && more(page))
                    } else {
                        // Newest page over the head of the list. Anything older than the
                        // fresh page's tail (by the full (ts, id) cursor) is kept as is;
                        // anything in its range that it does not contain has gone
                        // (finished, filtered out, deleted).
                        const fresh = new Set(page.map(key))
                        const floor = page.length ? page[page.length - 1] : undefined
                        setItems((prev) => [
                            ...page,
                            ...prev.filter(
                                (item) => !fresh.has(key(item)) && (floor === undefined || olderThan(item, floor))
                            )
                        ])
                    }
                })
                .catch((e: Error) => gen === generation.current && setError(e.message))
                .finally(() => {
                    if (busy.current === gen) busy.current = null
                    if (gen === generation.current) setLoading(false)
                    if (again.current && busy.current === null) {
                        again.current = false
                        load('poll')
                    }
                })
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        options.deps ?? []
    )

    useEffect(() => {
        load('reset')
        if (!pollMs) return
        const timer = setInterval(() => load('poll'), pollMs)
        return () => clearInterval(timer)
    }, [load, pollMs])

    return {
        items,
        loading,
        error,
        hasMore,
        loadMore: () => load('more'),
        reload: () => load('reset'),
        refresh: () => load('poll'),
        setItems: (update) => setItems((prev) => update(prev))
    }
}
