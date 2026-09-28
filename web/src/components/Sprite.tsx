/** Tiny pixel-art mascots for agent tiles; the sprite is picked by name hash. */
const SPRITES: Record<string, string[]> = {
    ghost: [
        '...####...',
        '.########.',
        '##########',
        '##.####.##',
        '##.####.##',
        '##########',
        '##########',
        '##########',
        '#.##.##.#.',
        '#..#..#..#'
    ],
    invader: [
        '..#.....#..',
        '...#...#...',
        '..#######..',
        '.##.###.##.',
        '###########',
        '#.#######.#',
        '#.#.....#.#',
        '...##.##...'
    ],
    robot: [
        '....#....',
        '...###...',
        '.#######.',
        '.#.###.#.',
        '.#######.',
        '.#.#.#.#.',
        '.#######.',
        '..#####..',
        '..#...#..',
        '.##...##.'
    ],
    anchor: [
        '....#....',
        '...###...',
        '....#....',
        '.#######.',
        '....#....',
        '....#....',
        '#...#...#',
        '##..#..##',
        '.#######.',
        '...###...'
    ],
    ship: [
        '.....#.....',
        '.....###...',
        '.....#####.',
        '.....#.....',
        '.....#.....',
        '###########',
        '.#########.',
        '..#######..',
        '...#####...'
    ],
    bot: [
        '.##.....##.',
        '..#.....#..',
        '.#########.',
        '##.#####.##',
        '###########',
        '##.#####.##',
        '.#########.',
        '..##...##..',
        '..##...##..'
    ]
}

export const SPRITE_NAMES = Object.keys(SPRITES)

export function spriteFor(name: string): string {
    let h = 0
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return SPRITE_NAMES[h % SPRITE_NAMES.length]
}

export function Sprite({ name, sprite }: { name?: string; sprite?: string }) {
    const rows = SPRITES[sprite ?? spriteFor(name ?? '')] ?? SPRITES.ghost
    const width = rows[0].length
    const height = rows.length
    // Pixels are drawn as a path of unit squares in currentColor; the tile sets the colour.
    const path = rows.flatMap((row, y) => [...row].map((c, x) => (c === '#' ? `M${x} ${y}h1v1h-1z` : ''))).join('')
    return (
        <svg className="sprite" viewBox={`0 0 ${width} ${height}`} width="1em" height="1em" aria-hidden shapeRendering="crispEdges">
            <path d={path} fill="currentColor" />
        </svg>
    )
}
