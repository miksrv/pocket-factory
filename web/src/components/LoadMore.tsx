import { useEffect, useRef } from 'react'

/**
 * End-of-list sentinel: asks for the next page as soon as it scrolls into
 * view, with a button as the fallback. Renders the count line either way.
 */
export function LoadMore({
    hasMore,
    loading,
    onMore,
    shown,
    total,
    noun = 'items'
}: {
    hasMore: boolean
    loading: boolean
    onMore: () => void
    shown: number
    total?: number
    noun?: string
}) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const el = ref.current
        if (!el || !hasMore || loading) return
        const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: '200px' })
        observer.observe(el)
        return () => observer.disconnect()
    }, [hasMore, loading, onMore])

    return (
        <div ref={ref} className="card-foot load-more">
            <span>
                {shown} {noun} shown{total !== undefined && total > shown ? ` of ${total.toLocaleString()}` : ''}
                {!hasMore && shown > 0 && total === undefined ? ' · that is all' : ''}
            </span>
            {hasMore && (
                <button className="sm" onClick={onMore} disabled={loading}>
                    {loading ? 'Loading…' : 'Load more'}
                </button>
            )}
        </div>
    )
}
