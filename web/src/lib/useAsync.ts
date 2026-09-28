import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Minimal data hook: load on mount / when deps change, poll, expose reload.
 * Every response carries the generation of the deps it was requested under;
 * a late poll from the previous filter never overwrites the current one.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
    const [data, setData] = useState<T | undefined>()
    const [error, setError] = useState<string | undefined>()
    const [loading, setLoading] = useState(true)
    const generation = useRef(0)

    const reload = useCallback(() => {
        const gen = generation.current
        loader()
            .then((value) => {
                if (gen !== generation.current) return
                setData(value)
                setError(undefined)
            })
            .catch((e: Error) => gen === generation.current && setError(e.message))
            .finally(() => gen === generation.current && setLoading(false))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    useEffect(() => {
        generation.current++
        setLoading(true)
        reload()
        if (!pollMs) return
        const timer = setInterval(reload, pollMs)
        return () => clearInterval(timer)
    }, [reload, pollMs])

    return { data, error, loading, reload, setData }
}
