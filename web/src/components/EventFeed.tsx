import { fmt, type TaskEvent } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'

function summarizeInput(input: unknown): string {
    if (!input || typeof input !== 'object') return ''
    const record = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'pattern', 'description', 'prompt', 'query', 'url']) {
        if (typeof record[key] === 'string') return String(record[key]).slice(0, 200)
    }
    return JSON.stringify(record).slice(0, 200)
}

/**
 * Renders the streamed output of one or more tasks: assistant text as
 * Markdown, tool calls as collapsible one-liners, terminal status lines.
 * The final `result` text repeats the last assistant text, so we show it
 * only when no text events were captured.
 */
export function EventFeed({ events, finalText, error }: { events: TaskEvent[]; finalText?: string | null; error?: string | null }) {
    const hasText = events.some((e) => e.type === 'text')
    return (
        <div className="stack">
            {events.map((event) => (
                <Event key={event.id} event={event} />
            ))}
            {!hasText && finalText && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(finalText) }} />}
            {error && <div className="tool error">{error}</div>}
            {events.length === 0 && !finalText && !error && <div className="dim">Waiting for output…</div>}
        </div>
    )
}

export function Event({ event }: { event: TaskEvent }) {
    const p = event.payload
    switch (event.type) {
        case 'text':
            return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(p.text ?? '')) }} />
        case 'tool_use':
            return (
                <details className="tool">
                    <summary>
                        {String(p.name)} <span className="dim">{summarizeInput(p.input)}</span>
                    </summary>
                    <pre>{JSON.stringify(p.input, null, 2)}</pre>
                </details>
            )
        case 'tool_result': {
            const text = String(p.text ?? '')
            if (!text.trim()) return null
            return (
                <details className={`tool${p.isError ? ' error' : ''}`}>
                    <summary>{p.isError ? 'error' : 'result'} <span className="dim">{text.split('\n')[0].slice(0, 120)}</span></summary>
                    <pre>{text}</pre>
                </details>
            )
        }
        case 'status':
            if (p.status === 'running') return null
            return (
                <div className="dim small">
                    {String(p.status)} · {Number(p.num_turns ?? 0)} turns · {fmt.tokens(Number(p.tokens ?? 0))} tokens
                    {typeof p.window_5h_delta === 'number' && ` · ${fmt.windowDelta(p.window_5h_delta)}`} · {fmt.duration(Number(p.duration_ms ?? 0))}
                </div>
            )
        case 'error':
            return <div className="tool error">{String(p.error ?? p.status)}</div>
        default:
            return null
    }
}
