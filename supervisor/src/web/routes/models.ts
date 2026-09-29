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

/** Tool names an agent file may list in `tools:`: the common ones, then everything the CLI reported. */
export function toolRoutes(): Hono<Env> {
    const app = new Hono<Env>()
    app.get('/', (c) => {
        const reported = c.get('app').tasks.tools()
        return c.json({ common: COMMON_TOOLS, reported: reported.filter((t) => !COMMON_TOOLS.includes(t)), source: reported.length ? 'cli' : 'default' })
    })
    return app
}
