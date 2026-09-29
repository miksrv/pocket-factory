import {
    Activity,
    Bot,
    ClipboardList,
    FileText,
    FolderGit2,
    Gauge,
    LayoutDashboard,
    ListChecks,
    type LucideIcon,
    MessageSquare,
    Package,
    Send,
    Settings,
    Trash2,
    TriangleAlert,
    Zap
} from 'lucide-react'

/**
 * One icon per concept, used by the sidebar, tiles and card heads alike so
 * the same thing always looks the same. Conventions follow the common
 * dashboard vocabulary: a speech bubble for chat, a bot for agents, a
 * clipboard for the audit trail, a document for transcripts, a gauge for
 * limits.
 */
export const ICONS = {
    overview: LayoutDashboard,
    tasks: ListChecks,
    chat: MessageSquare,
    sessions: FileText,
    audit: ClipboardList,
    agents: Bot,
    skills: Zap,
    projects: FolderGit2,
    presets: Package,
    settings: Settings,
    control: Activity,
    limits: Gauge,
    /** Channels a conversation comes from: a paper plane for Telegram, the chat bubble for the web. */
    telegram: Send,
    web: MessageSquare,
    /** Tiles of a confirmation window: a bin for a delete, a triangle for anything else destructive. */
    delete: Trash2,
    warning: TriangleAlert
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
    const Component = ICONS[name]
    return <Component size={size} strokeWidth={1.75} className={className} aria-hidden />
}

/** Inline "icon + word" for a conversation's channel. */
export function Channel({ channel }: { channel: 'telegram' | 'web' }) {
    return (
        <span className="channel">
            <Icon name={channel} size={12} />
            {channel}
        </span>
    )
}
