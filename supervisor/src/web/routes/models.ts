import { Hono } from 'hono'

import type { Env } from '../context.js'

/**
 * There is no model list endpoint: an agent file names a CLI alias (`sonnet`,
 * `opus`, `haiku`, `fable`, `inherit`) and the CLI resolves it to the current
 * model of the subscription. Listing models would mean calling the Claude API
 * with the owner's token, which is the CLI's alone (SPEC §8), or spending
 * turns on probes.
 */

/**
 * The tools an agent file usually lists. The CLI's own session list is not
 * the same thing: it names harness internals (Monitor, CronCreate, …) and
 * leaves out tools it loads lazily (Grep, Glob), so these stay first.
 */
const COMMON_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite']

/**
 * Tool names an agent file may list in `tools:`: the common ones, everything else the CLI
 * reported, and the MCP servers from the registry (connectors, plugins, project servers, the
 * owner's own) with their tools and last status — a server that needs authentication has
 * no tools yet and is listed so the owner sees why.
 */
export function toolRoutes(): Hono<Env> {
    const app = new Hono<Env>()
    app.get('/', (c) => {
        const { tasks } = c.get('app')
        const reported = tasks.tools()
        return c.json({
            common: COMMON_TOOLS,
            reported: reported.filter((t) => !COMMON_TOOLS.includes(t) && !t.startsWith('mcp__')),
            // Connected servers first: those are the ones a role can pick tools from.
            mcp: tasks
                .mcpRegistry()
                .sort((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected') || a.label.localeCompare(b.label))
                .map(({ key, label, source, status, tools }) => ({ server: key, label, source, status, tools })),
            source: reported.length ? 'cli' : 'default'
        })
    })
    return app
}
