import { describe, expect, it } from 'vitest'

import type { RateLimits } from '../claude/runner.js'
import type { Ask } from '../store/index.js'
import {
    askQuestions,
    claudeSlug,
    detectProject,
    limitReset,
    mcpKey,
    mcpLabel,
    openQuestions,
    titleFrom
} from './service.js'

const limits = (over: Partial<RateLimits> = {}): RateLimits => ({
    status: 'allowed',
    five_hour: { used: 0.4, resets_at: '2026-10-06T15:00:00.000Z' },
    seven_day: { used: 0.2, resets_at: '2026-10-10T00:00:00.000Z' },
    ...over
})

describe('limitReset', () => {
    it('ignores a successful run', () => {
        expect(
            limitReset({ isError: false, text: 'usage limit reached', rateLimits: limits({ status: 'rejected' }) })
        ).toBeNull()
    })

    it('ignores other failures and a generic API rate limit', () => {
        expect(limitReset({ isError: true, text: 'Tool failed', rateLimits: limits() })).toBeNull()
        expect(limitReset({ isError: true, text: 'API Error: rate limit reached (429)', rateLimits: null })).toBeNull()
    })

    it('takes the reset the rejecting event names', () => {
        const at = limitReset({
            isError: true,
            text: 'whatever',
            rateLimits: limits({ status: 'rejected', resets_at: '2026-10-06T16:00:00.000Z' })
        })
        expect(at?.toISOString()).toBe('2026-10-06T16:00:00.000Z')
    })

    it('reads the epoch of the old wording', () => {
        const at = limitReset({ isError: true, text: 'Claude AI usage limit reached|1791306000', rateLimits: null })
        expect(at?.toISOString()).toBe(new Date(1791306000 * 1000).toISOString())
    })

    it('falls back to the window the rejection names', () => {
        const weekly = limitReset({
            isError: true,
            text: "You've hit your limit",
            rateLimits: limits({ status: 'rejected', window: 'seven_day_opus' })
        })
        expect(weekly?.toISOString()).toBe('2026-10-10T00:00:00.000Z')
        const session = limitReset({
            isError: true,
            text: "You've hit your limit",
            rateLimits: limits({ status: 'rejected', window: 'five_hour' })
        })
        expect(session?.toISOString()).toBe('2026-10-06T15:00:00.000Z')
    })

    it('falls back to an exhausted window when the text alone says so', () => {
        const at = limitReset({
            isError: true,
            text: "You've hit your weekly limit",
            rateLimits: limits({ seven_day: { used: 1, resets_at: '2026-10-11T00:00:00.000Z' } })
        })
        expect(at?.toISOString()).toBe('2026-10-11T00:00:00.000Z')
    })

    it('does not trust the event reset when the event did not refuse', () => {
        const at = limitReset({
            isError: true,
            text: 'You are out of extra usage',
            rateLimits: limits({ resets_at: '2026-10-06T16:00:00.000Z' })
        })
        expect(at).toBeNull()
    })

    it('skips an unparseable date for the next candidate', () => {
        const at = limitReset({
            isError: true,
            text: 'usage limit reached|1791306000',
            rateLimits: limits({ status: 'rejected', resets_at: 'soon' })
        })
        expect(at?.toISOString()).toBe(new Date(1791306000 * 1000).toISOString())
    })
})

const ask = (over: Partial<Ask> = {}): Ask => ({
    kind: 'question',
    request_id: 'r1',
    tool_use_id: 't1',
    tool_name: 'AskUserQuestion',
    input: {
        questions: [
            { question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
            null,
            { header: 'no question text' },
            { question: 'Ship today?' }
        ]
    },
    answers: {},
    agent: null,
    asked_at: '2026-10-06T08:00:00.000Z',
    ...over
})

describe('askQuestions', () => {
    it('keeps only well-formed questions', () => {
        expect(askQuestions(ask()).map((q) => q.question)).toEqual(['Which DB?', 'Ship today?'])
    })

    it('has none for a permission or a malformed input', () => {
        expect(askQuestions(ask({ kind: 'permission' }))).toEqual([])
        expect(askQuestions(ask({ input: { questions: 'Which DB?' } }))).toEqual([])
        expect(askQuestions(ask({ input: {} }))).toEqual([])
    })
})

describe('openQuestions', () => {
    it('drops the questions already answered', () => {
        expect(openQuestions(ask({ answers: { 'Which DB?': 'SQLite' } })).map((q) => q.question)).toEqual([
            'Ship today?'
        ])
        expect(openQuestions(ask({ answers: { 'Which DB?': 'a', 'Ship today?': '' } }))).toEqual([])
    })
})

describe('mcpKey', () => {
    it.each([
        ['claude.ai Gmail', 'claude_ai_Gmail'],
        ['plugin:trac:trac', 'plugin_trac_trac'],
        ['my-server_1', 'my-server_1']
    ])('%s → %s', (name, key) => {
        expect(mcpKey(name)).toBe(key)
    })
})

describe('mcpLabel', () => {
    it.each([
        ['plugin:trac:trac', 'plugin trac'],
        ['plugin:trac:other', 'plugin:trac:other'],
        ['claude.ai Gmail', 'claude.ai Gmail'],
        ['clickup', 'clickup']
    ])('%s → %s', (name, label) => {
        expect(mcpLabel(name)).toBe(label)
    })
})

describe('detectProject', () => {
    const workspaces = ['shop', 'ServicePattern', 'UserManagement', 'ui', 'shop-admin']

    it('finds a workspace named as a path segment', () => {
        expect(detectProject({ file_path: '/data/workspaces/shop/src/a.ts' }, workspaces)).toBe('shop')
        expect(detectProject({ command: 'cd shop && yarn test' }, workspaces)).toBe('shop')
    })

    it('does not match a name inside a longer word', () => {
        expect(detectProject({ command: 'open workshop/index' }, workspaces)).toBeNull()
        expect(detectProject({ file_path: '/x/shop-admin/a.ts' }, workspaces)).toBe('shop-admin')
    })

    it('ignores names shorter than three characters', () => {
        expect(detectProject({ file_path: '/x/ui/a.ts' }, workspaces)).toBeNull()
    })

    it('reads owner/name as the repository', () => {
        expect(detectProject({ command: 'gh pr list --repo ServicePattern/UserManagement' }, workspaces)).toBe(
            'UserManagement'
        )
    })

    it('prefers a name with a project file', () => {
        const input = { command: 'diff /w/shop/a /w/UserManagement/b' }
        expect(detectProject(input, workspaces)).toBe('shop')
        expect(detectProject(input, workspaces, (n) => n === 'UserManagement')).toBe('UserManagement')
    })

    it('escapes regular expression characters in names', () => {
        expect(detectProject({ file_path: '/w/miksoft.pro/x' }, ['miksoft.pro', 'miksoftXpro'])).toBe('miksoft.pro')
        expect(detectProject({ file_path: '/w/miksoftXpro/x' }, ['miksoft.pro'])).toBeNull()
    })

    it.each([null, undefined, {}, 'nothing here'])('finds nothing in %j', (input) => {
        expect(detectProject(input, workspaces)).toBeNull()
    })
})

describe('titleFrom', () => {
    it('takes the first non-empty line with whitespace collapsed', () => {
        expect(titleFrom('\n\n   Fix   the\tlogin   \nmore')).toBe('Fix the login')
        expect(titleFrom('')).toBe('')
    })

    it('keeps a line of exactly the limit', () => {
        const line = 'a'.repeat(60)
        expect(titleFrom(line)).toBe(line)
    })

    it('cuts a long line at a word boundary and adds an ellipsis', () => {
        const title = titleFrom('Please review the pull request about the checkout flow, and also the cart page')
        expect(title).toBe('Please review the pull request about the checkout flow, and…')
        expect(title.length).toBeLessThanOrEqual(61)
    })

    it('trims punctuation before the ellipsis', () => {
        expect(titleFrom(`${'word '.repeat(9)}stop, ${'x'.repeat(30)}`)).toBe(`${'word '.repeat(9)}stop…`)
    })

    it('cuts mid-word when there is no space late enough', () => {
        expect(titleFrom(`ab ${'c'.repeat(80)}`)).toBe(`ab ${'c'.repeat(57)}…`)
    })
})

describe('claudeSlug', () => {
    it('replaces everything but letters and digits with dashes, as Claude Code names its project folders', () => {
        expect(claudeSlug('/Users/mik/Developer/projects/pocket-factory')).toBe(
            '-Users-mik-Developer-projects-pocket-factory'
        )
        expect(claudeSlug('/data/workspaces/my_repo.v2')).toBe('-data-workspaces-my-repo-v2')
    })
})
