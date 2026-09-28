import { useCallback, useEffect, useState } from 'react'

/** Minimal data hook: load on mount / when deps change, expose reload. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
    const [data, setData] = useState<T | undefined>()
    const [error, setError] = useState<string | undefined>()
    const [loading, setLoading] = useState(true)

    const reload = useCallback(() => {
        let cancelled = false
        loader()
            .then((value) => {
                if (cancelled) return
                setData(value)
                setError(undefined)
            })
            .catch((e: Error) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    useEffect(() => {
        const cancel = reload()
        if (!pollMs) return cancel
        const timer = setInterval(reload, pollMs)
        return () => {
            cancel()
            clearInterval(timer)
        }
    }, [reload, pollMs])

    return { data, error, loading, reload, setData }
}
