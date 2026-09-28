import { Icon, ICONS, type IconName } from './Icon'
import { Sprite } from './Sprite'

const COLORS = ['green', 'blue', 'amber', 'purple', 'teal'] as const
type Color = (typeof COLORS)[number] | 'gray' | 'red'

function hash(text: string): number {
    let h = 0
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return h
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
