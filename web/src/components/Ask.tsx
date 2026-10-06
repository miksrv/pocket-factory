import { type FormEvent, useState } from 'react'

import { api, type Ask, type AskQuestion, type Task } from '../lib/api'
import { ToolInput } from './EventFeed'
import { Button } from './ui'

/** The questions of an `AskUserQuestion` call, as far as the input is well-formed. */
export function askQuestions(ask: Ask): AskQuestion[] {
    const questions = ask.kind === 'question' ? (ask.input as { questions?: unknown }).questions : undefined
    return Array.isArray(questions)
        ? questions.filter((q): q is AskQuestion => Boolean(q) && typeof (q as AskQuestion).question === 'string')
        : []
}

const OTHER = '\u0000other'

/**
 * What the agent asked, inside its turn: one block per question with the
 * options as radios (checkboxes for a multi-select) and an "Other" line for
 * a free-text answer, or Allow / Deny for a permission request. The task
 * stays running until the answer goes back; `onAnswered` gets the task row
 * the API returns (its `ask` is gone, or advanced to the next question).
 */
export function AskForm({ task, onAnswered }: { task: Task; onAnswered?: (task: Task) => void }) {
    const ask = task.ask!
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const send = async (body: Parameters<typeof api.answerTask>[1]) => {
        setBusy(true)
        try {
            const updated = await api.answerTask(task.id, body)
            setError(null)
            onAnswered?.(updated)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    if (ask.kind === 'permission') {
        return (
            <div className='ask-form'>
                <div className='ask-head'>
                    <span className='badge ask'>Permission</span>
                    <span>
                        The agent wants to run <strong>{ask.tool_name}</strong>
                    </span>
                </div>
                <ToolInput
                    name={ask.tool_name}
                    input={ask.input}
                />
                <div className='ask-actions'>
                    <Button
                        variant='primary'
                        size='sm'
                        disabled={busy}
                        onClick={() => send({ behavior: 'allow' })}
                    >
                        Allow
                    </Button>
                    <Button
                        size='sm'
                        disabled={busy}
                        onClick={() => send({ behavior: 'deny' })}
                    >
                        Deny
                    </Button>
                    {error && <span className='error small'>{error}</span>}
                </div>
            </div>
        )
    }
    return (
        <QuestionForm
            ask={ask}
            busy={busy}
            error={error}
            onSubmit={(answers) => send({ answers })}
        />
    )
}

function QuestionForm({
    ask,
    busy,
    error,
    onSubmit
}: {
    ask: Ask
    busy: boolean
    error: string | null
    onSubmit: (answers: Record<string, string>) => void
}) {
    const questions = askQuestions(ask)
    const open = questions.filter((q) => !(q.question in ask.answers))
    // Per question: the picked labels (or OTHER) and the free-text line.
    const [picked, setPicked] = useState<Record<string, string[]>>({})
    const [other, setOther] = useState<Record<string, string>>({})

    const answerOf = (q: AskQuestion): string => {
        const labels = picked[q.question] ?? []
        const parts = labels.filter((l) => l !== OTHER)
        if (labels.includes(OTHER) && other[q.question]?.trim()) parts.push(other[q.question].trim())
        return parts.join(', ')
    }
    const complete = open.every((q) => answerOf(q))
    const toggle = (q: AskQuestion, label: string) =>
        setPicked((prev) => {
            const current = prev[q.question] ?? []
            if (q.multiSelect)
                return {
                    ...prev,
                    [q.question]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
                }
            return { ...prev, [q.question]: [label] }
        })
    const submit = (e: FormEvent) => {
        e.preventDefault()
        if (!complete || busy) return
        onSubmit(Object.fromEntries(open.map((q) => [q.question, answerOf(q)])))
    }

    return (
        <form
            className='ask-form'
            onSubmit={submit}
        >
            <div className='ask-head'>
                <span className='badge ask'>Question</span>
                <span>The agent needs your answer to continue</span>
            </div>
            {questions.map((q) => {
                const done = ask.answers[q.question]
                const chosen = picked[q.question] ?? []
                return (
                    <fieldset
                        key={q.question}
                        className={`ask-q${done ? ' done' : ''}`}
                        disabled={Boolean(done) || busy}
                    >
                        <legend>
                            {q.header && <span className='badge plain'>{q.header}</span>}
                            {q.question}
                        </legend>
                        {done ? (
                            <div className='ask-done'>✓ {done}</div>
                        ) : (
                            <>
                                {(q.options ?? []).map((option) => (
                                    <label
                                        key={option.label}
                                        className='ask-opt'
                                    >
                                        <input
                                            type={q.multiSelect ? 'checkbox' : 'radio'}
                                            name={q.question}
                                            checked={chosen.includes(option.label)}
                                            onChange={() => toggle(q, option.label)}
                                        />
                                        <span>
                                            <span className='ask-label'>{option.label}</span>
                                            {option.description && <span className='dim'> — {option.description}</span>}
                                        </span>
                                    </label>
                                ))}
                                <label className='ask-opt'>
                                    <input
                                        type={q.multiSelect ? 'checkbox' : 'radio'}
                                        name={q.question}
                                        checked={chosen.includes(OTHER)}
                                        onChange={() => toggle(q, OTHER)}
                                    />
                                    <input
                                        type='text'
                                        placeholder={q.options?.length ? 'Other…' : 'Your answer…'}
                                        value={other[q.question] ?? ''}
                                        onFocus={() => !chosen.includes(OTHER) && toggle(q, OTHER)}
                                        onChange={(e) =>
                                            setOther((prev) => ({ ...prev, [q.question]: e.target.value }))
                                        }
                                    />
                                </label>
                            </>
                        )}
                    </fieldset>
                )
            })}
            <div className='ask-actions'>
                <Button
                    variant='primary'
                    size='sm'
                    type='submit'
                    disabled={!complete || busy}
                >
                    {busy ? 'Sending…' : 'Answer'}
                </Button>
                <span className='dim small'>or type the answer in the composer below</span>
                {error && <span className='error small'>{error}</span>}
            </div>
        </form>
    )
}
