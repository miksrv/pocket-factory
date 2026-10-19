import {
    Activity,
    ArrowDown,
    Bell,
    BellOff,
    Bot,
    Braces,
    Check,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    ClipboardList,
    Cpu,
    ExternalLink,
    Eye,
    EyeOff,
    File,
    FileText,
    FolderGit2,
    Gauge,
    GitBranch,
    GitPullRequest,
    KeyRound,
    LayoutDashboard,
    ListChecks,
    Lock,
    LogOut,
    type LucideIcon,
    Menu,
    MessageSquare,
    Moon,
    Package,
    Paperclip,
    Plus,
    Repeat,
    Send,
    SendHorizontal,
    Server,
    Settings,
    ShieldCheck,
    SquareTerminal,
    Sun,
    Ticket,
    Trash2,
    TriangleAlert,
    X,
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
    /** Recurring tasks: a calendar with a clock, in the sidebar, the tile and the Chat list alike. */
    routines: Repeat,
    settings: Settings,
    control: Activity,
    limits: Gauge,
    /** Channels a conversation comes from: a paper plane for Telegram, the chat bubble for the web. */
    telegram: Send,
    web: MessageSquare,
    /** Tiles of a confirmation window: a bin for a delete, a triangle for anything else destructive. */
    delete: Trash2,
    warning: TriangleAlert,
    close: X,
    key: KeyRound,
    /** Settings → Secrets and variables: a lock for a secret, braces for a plain variable. */
    secret: Lock,
    variable: Braces,
    /** The sidebar's switch for desktop notifications. */
    bell: Bell,
    bellOff: BellOff,
    host: Server,
    /** The sidebar's sign-out, next to the bell; the shield heads Settings → Security. */
    logout: LogOut,
    shield: ShieldCheck,
    /** Show / hide the password on the sign-in page. */
    eye: Eye,
    eyeOff: EyeOff,
    /** The sidebar's theme switch: the icon names what a click gives. */
    sun: Sun,
    moon: Moon,
    /** A file of a skill's or routine's folder; an attachment is a paper clip (a transcript is `sessions`). */
    file: File,
    attachment: Paperclip,
    /** A model provider (Settings → Providers): a chip, not the limits gauge. */
    provider: Cpu,
    /** Controls: the phone menu, add, open elsewhere, fold / unfold, send, jump to the end. */
    menu: Menu,
    add: Plus,
    external: ExternalLink,
    expand: ChevronRight,
    collapse: ChevronDown,
    send: SendHorizontal,
    down: ArrowDown,
    /** Git, in the Changes panel. */
    branch: GitBranch,
    pr: GitPullRequest,
    /** A result: done, failed, needs a look. `warning` stays the triangle of a destructive window. */
    ok: Check,
    failed: X,
    alert: CircleAlert,
    /** A routine step's kind: a script, a Trac query (pull requests are `pr`, the agent `agents`). */
    script: SquareTerminal,
    ticket: Ticket
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
    const Component = ICONS[name]
    return (
        <Component
            size={size}
            strokeWidth={1.75}
            className={className}
            aria-hidden
        />
    )
}

/** Inline "icon + word" for a conversation's channel; a routine's conversation says so instead of "web". */
export function Channel({ channel, routine }: { channel: 'telegram' | 'web'; routine?: boolean }) {
    return (
        <span className='channel'>
            <Icon
                name={routine ? 'routines' : channel}
                size={12}
            />
            {routine ? 'routine' : channel}
        </span>
    )
}
