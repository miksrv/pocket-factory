import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import {
    bracketMatching,
    foldGutter,
    foldKeymap,
    HighlightStyle,
    indentOnInput,
    indentUnit,
    StreamLanguage,
    syntaxHighlighting
} from '@codemirror/language'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
    drawSelection,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    placeholder as placeholderText
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/*
 * The code editor of the folder files and the step cards: CodeMirror 6,
 * loaded on demand (this module is imported dynamically, so the main bundle
 * does not carry it). Colours come from the theme tokens, the same palette
 * highlight.js uses for code in the chat, so both themes follow on their own.
 */

/** The syntax of a file by its name (and its shebang for a script without an extension). */
function languageOf(path: string, text: string): Extension {
    const name = path.toLowerCase()
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
    if (['sh', 'bash', 'zsh', 'env'].includes(ext) || (!ext && /^#!.*\b(ba|z)?sh\b/.test(text)))
        return StreamLanguage.define(shell)
    if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return javascript({ jsx: ext === 'jsx' })
    if (['ts', 'mts', 'tsx'].includes(ext)) return javascript({ typescript: true, jsx: ext === 'tsx' })
    if (ext === 'py' || (!ext && /^#!.*python/.test(text))) return python()
    if (ext === 'md' || ext === 'markdown') return markdown()
    if (ext === 'yml' || ext === 'yaml') return yaml()
    if (ext === 'json') return json()
    if (ext === 'toml') return StreamLanguage.define(toml)
    if (['ini', 'cfg', 'conf', 'properties'].includes(ext)) return StreamLanguage.define(properties)
    return []
}

const palette = HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--text-dim)', fontStyle: 'italic' },
    {
        tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword],
        color: 'var(--purple)'
    },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--green)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--amber)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.heading, t.className], color: 'var(--blue)' },
    { tag: [t.variableName, t.propertyName, t.attributeName, t.special(t.variableName)], color: 'var(--teal)' },
    { tag: [t.typeName, t.standard(t.variableName), t.standard(t.name)], color: 'var(--teal)' },
    { tag: [t.meta, t.processingInstruction], color: 'var(--text-2)' },
    { tag: t.heading, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.link, color: 'var(--blue)', textDecoration: 'underline' },
    { tag: t.invalid, color: 'var(--red)' }
])

const theme = EditorView.theme({
    '&': {
        fontSize: '12.5px',
        backgroundColor: 'var(--surface)',
        color: 'var(--text)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-sm)'
    },
    '&.cm-focused': { outline: '2px solid var(--blue-bg)', outlineOffset: '0' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-gutters': {
        backgroundColor: 'var(--surface-2)',
        color: 'var(--text-dim)',
        border: 'none',
        borderRight: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm) 0 0 var(--radius-sm)'
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--surface-3) 45%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-3)', color: 'var(--text-2)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--blue-bg) !important'
    },
    '.cm-selectionMatch': { backgroundColor: 'var(--gold-bg)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--surface-3)', outline: '1px solid var(--border-strong)' },
    '.cm-searchMatch': { backgroundColor: 'var(--gold-bg)', outline: '1px solid var(--gold)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--amber-bg)' },
    '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', fontFamily: 'var(--mono)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--mono)', fontSize: '12px' },
    '.cm-placeholder': { color: 'var(--placeholder)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: 'none', color: 'var(--text-2)' }
})

export interface CodeEditorHandle {
    /** Replace the text (a reload from disk); the undo history starts over. */
    setText(text: string): void
    setReadOnly(readOnly: boolean): void
    focus(): void
    destroy(): void
}

/** Mount an editor into `parent`. `onChange` gets every edit; Mod-S calls `onSave`. */
export function mountEditor(
    parent: HTMLElement,
    options: {
        text: string
        path: string
        readOnly?: boolean
        placeholder?: string
        onChange: (text: string) => void
        onSave?: () => void
        label: string
    }
): CodeEditorHandle {
    const readOnly = new Compartment()
    const state = (text: string) =>
        EditorState.create({
            doc: text,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightSpecialChars(),
                history(),
                foldGutter(),
                drawSelection(),
                indentOnInput(),
                indentUnit.of('    '),
                bracketMatching(),
                closeBrackets(),
                highlightActiveLine(),
                highlightSelectionMatches(),
                search({ top: true }),
                syntaxHighlighting(palette),
                languageOf(options.path, text),
                theme,
                EditorView.lineWrapping,
                options.placeholder ? placeholderText(options.placeholder) : [],
                readOnly.of([
                    EditorState.readOnly.of(Boolean(options.readOnly)),
                    EditorView.editable.of(!options.readOnly)
                ]),
                EditorView.contentAttributes.of({ 'aria-label': options.label, spellcheck: 'false' }),
                keymap.of([
                    {
                        key: 'Mod-s',
                        preventDefault: true,
                        run: () => {
                            options.onSave?.()
                            return true
                        }
                    },
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...searchKeymap,
                    ...historyKeymap,
                    ...foldKeymap,
                    indentWithTab
                ]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) options.onChange(update.state.doc.toString())
                })
            ]
        })
    const view = new EditorView({ state: state(options.text), parent })
    return {
        setText: (text) => view.setState(state(text)),
        setReadOnly: (on) =>
            view.dispatch({
                effects: readOnly.reconfigure([EditorState.readOnly.of(on), EditorView.editable.of(!on)])
            }),
        focus: () => view.focus(),
        destroy: () => view.destroy()
    }
}
