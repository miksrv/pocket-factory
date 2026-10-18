import { describe, expect, it } from 'vitest'

import { toolLabel, toolTitle } from './tools'

const MCP = [{ server: 'claude_ai_ClickUp', label: 'ClickUp', source: 'connector', status: 'connected', tools: [] }]

describe('toolLabel', () => {
    it('names the factory tool and keeps a built-in as it is, with what it does', () => {
        expect(toolLabel('mcp__factory__delegate')).toMatchObject({ label: 'Delegate to a role' })
        expect(toolLabel('Bash')).toEqual({ label: 'Bash', about: 'run shell commands (scripts, git, curl, gh)' })
    })

    it('reads an MCP tool as server and action, without the repeated server prefix', () => {
        expect(toolLabel('mcp__claude_ai_ClickUp__clickup_create_task', MCP)).toEqual({
            label: 'create task',
            server: 'ClickUp'
        })
        expect(toolLabel('mcp__search__searxng_web_search')).toEqual({ label: 'searxng web search', server: 'search' })
    })

    it('puts the identifier the file holds into the tooltip', () => {
        expect(toolTitle('mcp__claude_ai_ClickUp__clickup_create_task', MCP)).toBe(
            'ClickUp · create task\nmcp__claude_ai_ClickUp__clickup_create_task'
        )
    })
})
