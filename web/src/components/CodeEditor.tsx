import { useEffect, useRef, useState } from 'react'

import type { CodeEditorHandle } from '../lib/codemirror'

/** Under jsdom (the unit tests) the plain textarea stays: CodeMirror needs a real layout engine. */
const RICH = typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)

/**
 * A code editor for one file: CodeMirror (line numbers, syntax colours by the
 * file name, search with Mod-F, Mod-S saves), loaded on first use; a plain
 * textarea until it is there. `value` is the text; a new value from outside
 * (a reload from disk) replaces the editor's.
 */
export function CodeEditor({
    value,
    onChange,
    path,
    label,
    readOnly,
    onSave,
    placeholder,
    rows = 12
}: {
    value: string
    onChange: (text: string) => void
    /** The file's name: it picks the syntax. */
    path: string
    label: string
    readOnly?: boolean
    onSave?: () => void
    placeholder?: string
    /** The height of the fallback textarea, and the editor's minimum, in lines. */
    rows?: number
}) {
    const host = useRef<HTMLDivElement>(null)
    const editor = useRef<CodeEditorHandle | null>(null)
    const [ready, setReady] = useState(false)
    // The latest text and handlers, for the editor's callbacks that were bound at mount.
    const latest = useRef({ value, onChange, onSave })
    latest.current = { value, onChange, onSave }
    /** The text the editor holds now, to tell its own edits from a new text from outside. */
    const doc = useRef(value)

    useEffect(() => {
        if (!RICH) return
        let cancelled = false
        void import('../lib/codemirror').then(({ mountEditor }) => {
            if (cancelled || !host.current) return
            doc.current = latest.current.value
            editor.current = mountEditor(host.current, {
                text: latest.current.value,
                path,
                readOnly,
                placeholder,
                label,
                onChange: (text) => {
                    doc.current = text
                    latest.current.onChange(text)
                },
                onSave: () => latest.current.onSave?.()
            })
            setReady(true)
        })
        return () => {
            cancelled = true
            editor.current?.destroy()
            editor.current = null
            setReady(false)
        }
        // A new file is a new editor (its syntax and its history); the text follows below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path])

    // A text that did not come from typing (a reload, another file's save) replaces the editor's.
    useEffect(() => {
        const handle = editor.current
        if (!handle || !ready || value === doc.current) return
        doc.current = value
        handle.setText(value)
        if (readOnly) handle.setReadOnly(true)
    }, [value, ready, readOnly])

    useEffect(() => {
        editor.current?.setReadOnly(Boolean(readOnly))
    }, [readOnly, ready])

    return (
        <div
            className='code-editor'
            style={{ ['--code-rows' as string]: rows }}
        >
            <div
                ref={host}
                className='code-editor-host'
                hidden={!ready}
            />
            {!ready && (
                <textarea
                    className='mono'
                    rows={Math.min(30, Math.max(rows, value.split('\n').length + 1))}
                    value={value}
                    readOnly={readOnly}
                    placeholder={placeholder}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                            e.preventDefault()
                            e.stopPropagation()
                            onSave?.()
                        }
                    }}
                    spellCheck={false}
                    aria-label={label}
                />
            )}
        </div>
    )
}
