import { describe, expect, it } from 'vitest'

import { toolNames } from './Providers'

describe('toolNames', () => {
    it('drops the server prefix and a prefix every tool shares', () => {
        expect(toolNames('search', ['mcp__search__searxng_web_search', 'mcp__search__searxng_instance_info'])).toEqual([
            'web search',
            'instance info'
        ])
    })

    it('keeps the words when the tools share nothing', () => {
        expect(toolNames('search', ['mcp__search__searxng_web_search', 'mcp__search__web_url_read'])).toEqual([
            'searxng web search',
            'web url read'
        ])
    })
})
