import { useEffect, useRef, useState } from 'react'
import { fmt, type Task, type TaskEvent, taskTokens } from '../lib/api'
import { AskForm } from './Ask'
import { Event, summarizeInput } from './EventFeed'
import { Button, Markdown, StatusBadge } from './ui'
import { Tile } from './Tile'

type Segment = { kind: 'text'; text: string; agent: string | null } | { kind: 'steps'; events: TaskEvent[] }

/**
 * Prose stays prose; everything the agent did in between (tool calls,
 * their results, sub-agents) folds into one "steps" block, so a turn reads
 * as an answer with its work attached, not as a log.
 */
function segments(events: TaskEvent[]): Segment[] {
    const out: Segment[] = []
    for (const e of events) {
        if (e.type === 'status' || e.type === 'error' || e.type === 'llm' || e.type === 'limits') continue
        if (e.type === 'text' && !e.agent) {
            out.push({ kind: 'text', text: String(e.payload.text ?? ''), agent: e.agent })
            continue
        }
        const last = out[out.length - 1]
        if (last && last.kind === 'steps') last.events.push(e)
        else out.push({ kind: 'steps', events: [e] })
    }
    return out
}

function stepLabel(e: TaskEvent): string {
    if (e.type === 'tool_use') return String(e.payload.name ?? 'tool')
    if (e.type === 'agent') return `sub-agent ${e.agent ?? ''}`
    return ''
}

/** The last thing the agent did, for the working indicator and the collapsed summary. */
function lastStep(events: TaskEvent[]): string {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e.type === 'tool_use') return `${String(e.payload.name)} ${summarizeInput(e.payload.input)}`.trim()
        if (e.type === 'agent') return `sub-agent ${e.agent ?? ''} ${String(e.payload.phase ?? '')}`
    }
    return ''
}

function Steps({ events, live }: { events: TaskEvent[]; live: boolean }) {
    const calls = events.filter((e) => e.type === 'tool_use' || (e.type === 'agent' && e.payload.phase === 'started'))
    const names = [...new Set(calls.map(stepLabel).filter(Boolean))]
    const errors = events.filter((e) => e.type === 'tool_result' && e.payload.isError).length
    // Open while the agent works, folded once it is done; after that the
    // reader's own toggling is left alone (the element stays uncontrolled).
    const details = useRef<HTMLDetailsElement>(null)
    useEffect(() => {
        if (details.current) details.current.open = live
    }, [live])
    return (
        <details ref={details} className={`steps${live ? ' steps-live' : ''}${errors ? ' has-error' : ''}`}>
            <summary>
                <span className="steps-count">{fmt.plural(calls.length, 'step')}</span>
                <span className="dim steps-names">{live ? lastStep(events) : names.slice(0, 6).join(' · ') + (names.length > 6 ? ' · …' : '')}</span>
                {errors > 0 && <span className="badge red">{fmt.plural(errors, 'error')}</span>}
            </summary>
            <div className="steps-body">
                {events.map((e) => (
                    <Event key={e.id} event={e} />
                ))}
            </div>
        </details>
    )
}

/** `onTask`: the task row after the owner answered what it asked (its `ask` gone or advanced). */
export function AssistantTurn({ task, events, onTask }: { task: Task; events: TaskEvent[]; onTask?: (task: Task) => void }) {
    const [copied, setCopied] = useState(false)
    const live = task.status === 'running' || task.status === 'queued'
    const parts = segments(events)
    const hasText = parts.some((p) => p.kind === 'text')
    // The final result repeats the last text event; show it only when nothing streamed.
    const finalText = !hasText && task.status === 'done' && task.result ? task.result : null
    const prose = [...parts.filter((p): p is Extract<Segment, { kind: 'text' }> => p.kind === 'text').map((p) => p.text), finalText ?? ''].filter(Boolean).join('\n\n')

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(prose)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            // clipboard unavailable (http, permissions)
        }
    }

    if (task.status === 'queued') {
        return (
            <div className="reply-row">
                <Tile icon="control" color="gray" small />
                <div className="reply queued dim">Queued — waits for the running task in this conversation.</div>
            </div>
        )
    }

    return (
        <div className="reply-row">
            <Tile icon="control" color="gray" small />
            <div className="reply">
                {parts.map((p, i) =>
                    p.kind === 'text' ? (
                        <Markdown key={i} source={p.text} />
                    ) : (
                        <Steps key={i} events={p.events} live={live && i === parts.length - 1} />
                    )
                )}
                {finalText && <Markdown source={finalText} />}
                {task.status === 'running' && task.ask && <AskForm task={task} onAnswered={onTask} />}
                {task.status === 'running' && !task.ask && (
                    <div className="working">
                        <span className="dots">
                            <i />
                            <i />
                            <i />
                        </span>
                        {parts.length === 0 ? 'Starting…' : 'Working…'}
                    </div>
                )}
                {task.status === 'failed' && <div className="tool error">{task.error ?? 'failed'}</div>}
                {task.status === 'cancelled' && <div className="dim small">Stopped.</div>}
                {!live && (
                    <div className="reply-foot">
                        <StatusBadge status={task.status} />
                        <span className="dim">
                            {fmt.plural(task.num_turns, 'turn')} · {fmt.tokens(taskTokens(task))} tokens
                            {fmt.windowDelta(task.window_5h_delta) ? ` · ${fmt.windowDelta(task.window_5h_delta)}` : ''} · {fmt.duration(task.duration_ms)}
                        </span>
                        <span className="dim" title={fmt.when(task.finished_at)}>
                            · {fmt.ago(task.finished_at)}
                        </span>
                        <span className="grow" />
                        {prose && (
                            <Button size="sm" variant="ghost" onClick={copy} title="Copy the reply as Markdown">
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" to={`/tasks/${task.id}`}>
                            Task
                        </Button>
                    </div>
                )}
            </div>
        </div>
    )
}
