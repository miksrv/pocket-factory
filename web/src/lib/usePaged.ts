import { useCallback, useEffect, useRef, useState } from 'react'

export interface Paged<T> {
    items: T[]
    loading: boolean
    error?: string
    hasMore: boolean
    /** Fetch the next page (older items) and append it. */
    loadMore: () => void
    /** Start over from the first page. */
    reload: () => void
    setItems: (update: (items: T[]) => T[]) => void
}

/**
 * Keyset-paged list: the first page loads on mount (and when `deps` change),
 * `loadMore` appends the page before the last item's cursor, and polling
 * refreshes the first page only, merging it over what is already shown so a
 * long scrolled list is never rebuilt.
 */
export function usePaged<T>(
    fetchPage: (before: string | undefined) => Promise<T[]>,
    options: { key: (item: T) => string; cursor: (item: T) => string; pageSize: number; deps?: unknown[]; pollMs?: number }
): Paged<T> {
    const { key, cursor, pageSize, pollMs } = options
    const [items, setItems] = useState<T[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | undefined>()
    const [hasMore, setHasMore] = useState(false)
    const generation = useRef(0)
    const itemsRef = useRef<T[]>([])
    itemsRef.current = items
    const busy = useRef(false)

    const load = useCallback(
        (mode: 'reset' | 'more' | 'poll') => {
            if (busy.current && mode !== 'reset') return
            const gen = mode === 'reset' ? ++generation.current : generation.current
            const before = mode === 'more' ? cursor(itemsRef.current[itemsRef.current.length - 1]) : undefined
            if (mode === 'more' && itemsRef.current.length === 0) return
            busy.current = true
            if (mode !== 'poll') setLoading(true)
            fetchPage(before)
                .then((page) => {
                    if (gen !== generation.current) return
                    setError(undefined)
                    if (mode === 'reset') {
                        setItems(page)
                        setHasMore(page.length >= pageSize)
                    } else if (mode === 'more') {
                        const known = new Set(itemsRef.current.map(key))
                        setItems((prev) => [...prev, ...page.filter((item) => !known.has(key(item)))])
                        setHasMore(page.length >= pageSize)
                    } else {
                        // Newest page over the head of the list; the scrolled tail stays.
                        const fresh = new Set(page.map(key))
                        setItems((prev) => [...page, ...prev.filter((item) => !fresh.has(key(item)))])
                    }
                })
                .catch((e: Error) => gen === generation.current && setError(e.message))
                .finally(() => {
                    busy.current = false
                    if (gen === generation.current) setLoading(false)
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
        setItems: (update) => setItems((prev) => update(prev))
    }
}
