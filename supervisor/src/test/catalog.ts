import type { CatalogEntry, Kind } from '../files/catalog.js'

/** A catalog entry built by hand, for code that reads parsed files without touching the disk. */
export function entry(
    frontmatter: Record<string, unknown>,
    body = 'Do the work.',
    extra: Partial<CatalogEntry> = {}
): CatalogEntry {
    const kind: Kind = extra.kind ?? 'schedules'
    const name = extra.name ?? 'nightly'
    return {
        kind,
        name,
        path: `/data/config/${kind}/${name}.md`,
        frontmatter,
        body,
        updated_at: '2026-10-06T00:00:00.000Z',
        size: body.length,
        ...extra
    }
}
