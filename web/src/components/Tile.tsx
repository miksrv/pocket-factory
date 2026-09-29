import { Icon, ICONS, type IconName } from './Icon'
import { Sprite } from './Sprite'

/** The tones a name can get. Gray and red are for states (an orchestrator, a warning), never picked by a name. */
const COLORS = ['green', 'blue', 'amber', 'purple', 'teal', 'rose', 'lime', 'sky', 'gold', 'brown'] as const
type Color = (typeof COLORS)[number] | 'gray' | 'red'

/**
 * A stable colour per name: a polynomial hash with a final mix, so similar
 * names land far apart. The seed is a plain constant chosen so that the
 * shipped agents, skills, projects and presets each get a different tone
 * within their list; changing it re-colours everything.
 */
function hash(text: string): number {
    let h = 581
    for (const ch of text) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
    h ^= h >>> 16
    h = Math.imul(h, 0x45d9f3b) >>> 0
    h ^= h >>> 16
    return h >>> 0
}

/**
 * The pastel square every list, card head and grid uses. The symbol inside
 * is the concept's icon (`kind` or `icon`), a pixel mascot for agents, or a
 * text glyph; the square keeps its size whatever is inside. Colour is
 * stable per name unless given.
 */
export function Tile({
    name = '',
    kind,
    icon,
    glyph,
    color,
    small,
    large
}: {
    name?: string
    kind?: string
    icon?: IconName
    glyph?: string
    color?: Color
    small?: boolean
    large?: boolean
}) {
    const tone = color ?? COLORS[hash(name || kind || icon || '') % COLORS.length]
    const iconName = icon ?? (kind && kind in ICONS ? (kind as IconName) : undefined)
    return (
        <span className={`tile ${tone}${small ? ' sm' : ''}${large ? ' lg' : ''}`} aria-hidden>
            {glyph ? glyph : kind === 'agents' && !icon ? <Sprite name={name} /> : iconName ? <Icon name={iconName} /> : name.slice(0, 1).toUpperCase()}
        </span>
    )
}
