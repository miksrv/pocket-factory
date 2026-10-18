import type { ToolList } from './api'

/*
 * Tool names are Claude Code's identifiers: an agent file lists them as they
 * are (`Bash`, `mcp__factory__delegate`, `mcp__claude_ai_ClickUp__clickup_create_task`)
 * and the CLI reads them literally. The UI shows each with a label a person
 * reads, the identifier in its tooltip.
 */

/** Built-in tools and the factory's own: a short label and what the tool lets the agent do. */
const KNOWN: Record<string, { label?: string; about: string }> = {
    Read: { about: 'read files' },
    Edit: { about: 'change files in place' },
    Write: { about: 'create or overwrite files' },
    MultiEdit: { about: 'several edits to one file at once' },
    NotebookEdit: { about: 'edit Jupyter notebooks' },
    Bash: { about: 'run shell commands (scripts, git, curl, gh)' },
    Grep: { about: 'search file contents' },
    Glob: { about: 'find files by name' },
    WebFetch: { about: 'fetch a web page' },
    WebSearch: { about: 'search the web' },
    Agent: { about: 'start sub-agents' },
    TodoWrite: { about: 'keep a to-do list for the task' },
    AskUserQuestion: { about: 'ask the owner a question and wait' },
    ToolSearch: { about: 'load deferred tools (connectors) on demand' },
    Skill: { about: 'load a skill' },
    mcp__factory__delegate: {
        label: 'Delegate to a role',
        about: 'hand work to an agent on another provider (your own GPU box) and wait for its result'
    }
}

/** `snake_case_name` → `snake case name`, without a repeated server prefix (`clickup_create_task` under ClickUp → `create task`). */
function humanize(tool: string, server: string): string {
    const plain = server.replace(/^claude_ai_/, '').toLowerCase()
    const name = tool.toLowerCase().startsWith(`${plain}_`) ? tool.slice(plain.length + 1) : tool
    return name.replace(/[_-]+/g, ' ').trim()
}

/** A server key as a name: `claude_ai_Google_Drive` → `Google Drive`. */
function serverName(key: string, known: ToolList['mcp']): string {
    return known.find((m) => m.server === key)?.label ?? key.replace(/^claude_ai_/, '').replace(/_/g, ' ')
}

export interface ToolLabel {
    /** What the chip says. */
    label: string
    /** The MCP server's name, for a server tool. */
    server?: string
    /** What the tool lets the agent do, when known. */
    about?: string
}

/** How the UI names a tool; the identifier itself goes into the tooltip. */
export function toolLabel(tool: string, mcp: ToolList['mcp'] = []): ToolLabel {
    const known = KNOWN[tool]
    if (known) return { label: known.label ?? tool, about: known.about }
    const m = /^mcp__(.+?)__(.+)$/.exec(tool)
    if (!m) return { label: tool }
    const server = serverName(m[1], mcp)
    return { label: humanize(m[2], m[1]), server }
}

/** The tooltip of a tool's chip: its label, what it does, the identifier the file holds. */
export function toolTitle(tool: string, mcp: ToolList['mcp'] = []): string {
    const t = toolLabel(tool, mcp)
    return [t.server ? `${t.server} · ${t.label}` : t.label, t.about, tool].filter(Boolean).join('\n')
}
