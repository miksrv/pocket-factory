import { useEffect, useState } from 'react'

/** The current time, refreshed every `everyMs` while `on`; a page uses it to tick a running task's duration between polls. */
export function useNow(everyMs: number, on = true): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!on) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), everyMs)
        return () => clearInterval(timer)
    }, [everyMs, on])
    return now
}
