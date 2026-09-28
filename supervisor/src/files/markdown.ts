import YAML from 'yaml'

export interface MarkdownDoc<T = Record<string, unknown>> {
    frontmatter: T
    body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Split a Markdown file into YAML frontmatter and body. No frontmatter → {}. */
export function parseMarkdown<T = Record<string, unknown>>(source: string): MarkdownDoc<T> {
    const match = source.match(FRONTMATTER)
    if (!match) return { frontmatter: {} as T, body: source }
    let frontmatter: unknown
    try {
        frontmatter = YAML.parse(match[1]) ?? {}
    } catch {
        frontmatter = {}
    }
    if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) frontmatter = {}
    return { frontmatter: frontmatter as T, body: source.slice(match[0].length) }
}

export function serializeMarkdown(doc: MarkdownDoc<unknown>): string {
    const frontmatter = doc.frontmatter && typeof doc.frontmatter === 'object' ? doc.frontmatter : {}
    const hasKeys = Object.keys(frontmatter as object).length > 0
    const body = doc.body.replace(/^\n+/, '')
    if (!hasKeys) return body
    const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()
    return `---\n${yaml}\n---\n\n${body}`
}
