import YAML from 'yaml'

export interface MarkdownDoc<T = Record<string, unknown>> {
    frontmatter: T
    body: string
    /** Set when the frontmatter block exists but is not valid YAML; `frontmatter` is then `{}`. */
    frontmatter_error?: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Split a Markdown file into YAML frontmatter and body. No frontmatter → {}. */
export function parseMarkdown<T = Record<string, unknown>>(source: string): MarkdownDoc<T> {
    const match = source.match(FRONTMATTER)
    if (!match) return { frontmatter: {} as T, body: source }
    let frontmatter: unknown
    let error: string | undefined
    try {
        frontmatter = YAML.parse(match[1]) ?? {}
    } catch (e) {
        frontmatter = {}
        error = e instanceof Error ? e.message.split('\n')[0] : String(e)
    }
    if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
        frontmatter = {}
        error ??= 'frontmatter is not a mapping'
    }
    const body = source.slice(match[0].length)
    return error ? { frontmatter: frontmatter as T, body, frontmatter_error: error } : { frontmatter: frontmatter as T, body }
}

export function serializeMarkdown(doc: MarkdownDoc<unknown>): string {
    const frontmatter = doc.frontmatter && typeof doc.frontmatter === 'object' ? doc.frontmatter : {}
    const hasKeys = Object.keys(frontmatter as object).length > 0
    const body = doc.body.replace(/^\n+/, '')
    if (!hasKeys) return body
    const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()
    return `---\n${yaml}\n---\n\n${body}`
}
