import { fmt, type TaskEvent } from '../lib/api'
import { diffOf, highlight, languageOf } from '../lib/highlight'
import { renderMarkdown } from '../lib/markdown'

export function summarizeInput(input: unknown): string {
    if (!input || typeof input !== 'object') return ''
    const record = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'pattern', 'description', 'prompt', 'query', 'url']) {
        if (typeof record[key] === 'string') return String(record[key]).slice(0, 200)
    }
    return JSON.stringify(record).slice(0, 200)
}

/** Highlighted `<pre>` for text in a known or detectable language. */
export function Code({ text, language }: { text: string; language?: string }) {
    const { html, language: detected } = highlight(text, language)
    return <pre className="code" data-lang={detected} dangerouslySetInnerHTML={{ __html: `<code class="hljs">${html}</code>` }} />
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * What a tool call looks like when unfolded: an Edit as a diff, a Write as
 * the file in its own language, a Bash call as the command, everything else
 * as its JSON arguments.
 */
function ToolInput({ name, input }: { name: string; input: unknown }) {
    const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const file = typeof record.file_path === 'string' ? record.file_path : ''
    if (name === 'Edit' && typeof record.old_string === 'string' && typeof record.new_string === 'string') {
        return (
            <>
                <div className="dim small mono">{file}</div>
                <pre className="code" data-lang="diff" dangerouslySetInnerHTML={{ __html: `<code class="hljs">${diffOf(record.old_string, record.new_string)}</code>` }} />
            </>
        )
    }
    if (name === 'MultiEdit' && Array.isArray(record.edits)) {
        return (
            <>
                <div className="dim small mono">{file}</div>
                {(record.edits as Array<Record<string, unknown>>).map((edit, i) => (
                    <pre key={i} className="code" data-lang="diff" dangerouslySetInnerHTML={{ __html: `<code class="hljs">${diffOf(String(edit.old_string ?? ''), String(edit.new_string ?? ''))}</code>` }} />
                ))}
            </>
        )
    }
    if (name === 'Write' && typeof record.content === 'string') {
        return (
            <>
                <div className="dim small mono">{file}</div>
                <Code text={record.content} language={languageOf(file)} />
            </>
        )
    }
    if (name === 'Bash' && typeof record.command === 'string') {
        return <Code text={record.command} language="bash" />
    }
    if (FILE_TOOLS.has(name) && Object.keys(record).length <= 3) {
        return <div className="dim small mono">{JSON.stringify(record)}</div>
    }
    return <Code text={JSON.stringify(record, null, 2)} language="json" />
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
    // Sub-agent activity is shown inline, prefixed with the agent's name.
    const who = event.agent ? <span className="badge plain teal" style={{ marginRight: 6 }}>{event.agent}</span> : null
    switch (event.type) {
        case 'text':
            if (event.agent) return null // sub-agent prose comes back through the Agent tool result
            return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(p.text ?? '')) }} />
        case 'tool_use':
            return (
                <details className="tool">
                    <summary>
                        {who}
                        {String(p.name)} <span className="dim">{summarizeInput(p.input)}</span>
                    </summary>
                    <ToolInput name={String(p.name)} input={p.input} />
                </details>
            )
        case 'agent':
            return (
                <div className="dim small">
                    {who}
                    {p.phase === 'started' ? `started: ${String(p.description ?? '')}` : `${String(p.phase)}${p.tokens !== undefined ? ` · ${fmt.tokens(Number(p.tokens))} tokens` : ''}${p.durationMs !== undefined ? ` · ${fmt.duration(Number(p.durationMs))}` : ''}`}
                </div>
            )
        case 'tool_result': {
            const text = String(p.text ?? '')
            if (!text.trim()) return null
            return (
                <details className={`tool${p.isError ? ' error' : ''}`}>
                    <summary>{who}{p.isError ? 'error' : 'result'} <span className="dim">{text.split('\n')[0].slice(0, 120)}</span></summary>
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
