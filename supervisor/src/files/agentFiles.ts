import type { Catalog } from './catalog.js'

/** What the factory reads from an agent file to run a task as that agent. */
export interface AgentFile {
    /** The body: the agent's system prompt. */
    body: string
    /** `tools:`; null = not restricted. */
    tools: string[] | null
    /** `disallowedTools:`; empty when none. */
    disallowed: string[]
    /** `model:` as written (an alias, a full id or `inherit`); null when absent. */
    model: string | null
    /** `maxTurns:`; null when absent. */
    maxTurns: number | null
}

/** `tools:` of an agent file: a YAML list or the CLI's comma-separated string; null = not restricted. */
export function toolList(tools: unknown): string[] | null {
    const list = Array.isArray(tools)
        ? tools.map((t) => String(t).trim())
        : typeof tools === 'string'
          ? tools.split(',').map((t) => t.trim())
          : []
    const named = list.filter(Boolean)
    return named.length ? named : null
}

/** The agent file `name` in data/claude/agents, or null when there is none. */
export function agentFile(catalog: Catalog, name: string): AgentFile | null {
    if (!catalog.exists('agents', name)) return null
    const { body, frontmatter: fm } = catalog.get('agents', name)
    const turns = Number(fm.maxTurns)
    return {
        body,
        tools: toolList(fm.tools),
        disallowed: toolList(fm.disallowedTools) ?? [],
        model: typeof fm.model === 'string' && fm.model.trim() ? fm.model.trim() : null,
        maxTurns: Number.isInteger(turns) && turns > 0 ? turns : null
    }
}

/** Whether a tool list names `tool`, bare or with a rule (`Edit(...)`). */
export const names = (list: string[], tool: string) => list.some((t) => t === tool || t.startsWith(`${tool}(`))
