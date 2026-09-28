import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * A core build with the languages a software factory meets, not the full
 * bundle: the agent's replies quote TypeScript, shell, JSON, diffs, YAML …
 * Unknown languages fall back to auto-detection over this same set.
 */
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
    bash,
    css,
    diff,
    dockerfile,
    go,
    ini,
    javascript,
    json,
    markdown,
    php,
    python,
    rust,
    sql,
    typescript,
    xml,
    yaml
}
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language)
hljs.registerAliases(['sh', 'zsh', 'shell', 'console'], { languageName: 'bash' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['patch'], { languageName: 'diff' })
hljs.registerAliases(['toml', 'env', 'dotenv'], { languageName: 'ini' })
hljs.registerAliases(['docker'], { languageName: 'dockerfile' })

/**
 * Language by file extension, for tool calls that name a file. Prose files
 * (Markdown, plain text) come back as plaintext: highlighting a document's
 * underscores and asterisks as emphasis only makes it harder to read.
 */
export function languageOf(filePath: string): string | undefined {
    const name = filePath.split('/').pop() ?? ''
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (/^dockerfile$/i.test(name)) return 'dockerfile'
    if (['md', 'markdown', 'txt', 'text'].includes(ext)) return 'plaintext'
    return hljs.getLanguage(ext) ? ext : undefined
}

/** Highlighted HTML for a code block; plain escaped text when nothing matches. */
export function highlight(code: string, language?: string): { html: string; language: string } {
    if (language === 'plaintext' || language === 'text') return { html: escape(code), language: 'plaintext' }
    if (language && hljs.getLanguage(language)) {
        const result = hljs.highlight(code, { language, ignoreIllegals: true })
        return { html: result.value, language: result.language ?? language }
    }
    if (code.length < 20_000) {
        const result = hljs.highlightAuto(code, ['typescript', 'javascript', 'json', 'bash', 'diff', 'python', 'yaml', 'xml', 'css', 'sql'])
        if (result.language && (result.relevance ?? 0) >= 5) return { html: result.value, language: result.language }
    }
    return { html: escape(code), language: 'plaintext' }
}

export function escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A unified-diff-looking block for an Edit tool call, highlighted as `diff`. */
export function diffOf(oldText: string, newText: string): string {
    const lines = [...oldText.split('\n').map((l) => `- ${l}`), ...newText.split('\n').map((l) => `+ ${l}`)]
    return highlight(lines.join('\n'), 'diff').html
}
