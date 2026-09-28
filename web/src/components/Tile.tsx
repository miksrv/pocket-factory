const COLORS = ['green', 'blue', 'amber', 'purple', 'teal'] as const
const GLYPHS: Record<string, string> = { agents: '⚙', skills: '⚡', projects: '▤', presets: '⊞', tasks: '☰', sessions: '⧉' }

function hash(text: string): number {
    let h = 0
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return h
}

/** Pastel square with a glyph; colour is stable per name. */
export function Tile({ name, kind, small, glyph }: { name: string; kind?: string; small?: boolean; glyph?: string }) {
    const color = COLORS[hash(name) % COLORS.length]
    return (
        <span className={`tile ${color}${small ? ' sm' : ''}`} aria-hidden>
            {glyph ?? GLYPHS[kind ?? ''] ?? name.slice(0, 1).toUpperCase()}
        </span>
    )
}
