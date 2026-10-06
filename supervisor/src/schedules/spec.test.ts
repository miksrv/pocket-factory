import { describe, expect, it } from 'vitest'

import { entry } from '../test/catalog.js'
import { parseSchedule, type Refs } from './spec.js'

const known =
    (...names: string[]) =>
    (name: string) =>
        names.includes(name)

const refs: Refs = {
    projectExists: known('shop'),
    hostExists: known('prod'),
    skillExists: known('pr-review'),
    agentExists: known('reviewer')
}
const defaults = { tz: 'Europe/Warsaw' }

const parse = (frontmatter: Record<string, unknown>, body?: string, extra?: Parameters<typeof entry>[2]) =>
    parseSchedule(entry(frontmatter, body, extra), defaults, refs)

describe('parseSchedule', () => {
    it('fills the defaults for a minimal file', () => {
        const parsed = parse({ cron: '0 8 * * 1-5' })
        expect(parsed.errors).toEqual([])
        expect(parsed.warnings).toEqual([])
        expect(parsed.name).toBe('nightly')
        expect(parsed.spec).toMatchObject({
            name: 'nightly',
            cron_text: 'at 08:00 on weekdays',
            tz: 'Europe/Warsaw',
            window: {},
            enabled: true,
            project: null,
            hosts: [],
            skill: null,
            agent: null,
            model: null,
            action: null,
            prefilter: null,
            notify: 'telegram',
            session: 'fresh',
            first_run: 'process',
            max_items: 10,
            once: false
        })
        expect(parsed.spec?.cron.source).toBe('0 8 * * 1-5')
    })

    it('reads every field of a full file', () => {
        const parsed = parse({
            cron: '*/30 * * * *',
            tz: 'UTC',
            window: { days: 'mon-fri', hours: '09:00-18:00' },
            enabled: 'off',
            project: 'shop',
            hosts: ['prod', { host: 'prod', path: '/srv/shop', notes: ' read only ' }, { path: 'x' }, '', 7],
            skill: 'pr-review',
            agent: 'reviewer',
            model: 'opus',
            action: 'report',
            prefilter: { kind: 'github-prs', filter: 'review-requested', mine: 'yes', drafts: true },
            notify: 'none',
            session: 'continue',
            first_run: 'process',
            max_items: '500',
            once: true
        })
        expect(parsed.errors).toEqual([])
        expect(parsed.spec).toMatchObject({
            tz: 'UTC',
            enabled: false,
            project: 'shop',
            hosts: [{ host: 'prod' }, { host: 'prod', path: '/srv/shop', notes: 'read only' }],
            skill: 'pr-review',
            agent: 'reviewer',
            model: 'opus',
            action: 'report',
            prefilter: { kind: 'github-prs', repo: undefined, filter: 'review-requested', mine: true, drafts: true },
            notify: 'none',
            session: 'continue',
            first_run: 'process',
            max_items: 100,
            once: true
        })
        expect([...parsed.spec!.window.days!].sort()).toEqual([1, 2, 3, 4, 5])
    })

    it.each([
        [{}, /cron is required/],
        [{ cron: '   ' }, /cron is required/],
        [{ cron: '0 8 * *' }, /^cron: a cron expression has five fields/],
        [{ cron: '0 8 * * *', tz: 'Mars/Base' }, /tz "Mars\/Base" is not a known time zone/],
        [{ cron: '0 8 * * *', window: { hours: 'all day' } }, /window.hours must be like/],
        [{ cron: '0 8 * * *', project: 'nope' }, /project "nope" has no file/],
        [{ cron: '0 8 * * *', model: 'gpt-5' }, /model must be inherit or one of sonnet, opus, haiku, fable/],
        [{ cron: '0 8 * * *', notify: 'email' }, /notify must be telegram or none/],
        [{ cron: '0 8 * * *', session: 'shared' }, /session must be fresh or continue/],
        [{ cron: '0 8 * * *', first_run: 'later' }, /first_run must be skip or process/],
        [{ cron: '0 8 * * *', prefilter: 'gh' }, /prefilter must be a mapping/],
        [{ cron: '0 8 * * *', prefilter: { run: 'ls' } }, /prefilter.kind is required/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'imap' } }, /unknown prefilter kind "imap"/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'command' } }, /prefilter.run is required/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'github-prs', repo: 'a/b', filter: 'all' } }, /prefilter.filter/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'github-prs', repo: 'not a repo' } }, /owner\/name/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'github-prs' } }, /needs a `repo` or a `project`/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'trac' } }, /prefilter.query is required/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'trac', query: 'a=b', url: 'ftp://x' } }, /prefilter.url/]
    ])('reports an error for %j', (frontmatter, message) => {
        const parsed = parse(frontmatter)
        expect(parsed.spec).toBeNull()
        expect(parsed.errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]))
    })

    it('collects every error at once', () => {
        const parsed = parse({ notify: 'x', session: 'y', tz: 'Nowhere/Here' })
        expect(parsed.errors).toHaveLength(4)
    })

    it('refuses a file whose frontmatter is not valid YAML', () => {
        const parsed = parse({ cron: '0 8 * * *' }, 'x', { frontmatter_error: 'bad indentation' })
        expect(parsed.spec).toBeNull()
        expect(parsed.errors).toEqual(['frontmatter is not valid YAML: bad indentation'])
    })

    it('warns about missing hosts, skills and agents and an empty body but still fires', () => {
        const parsed = parse({ cron: '0 8 * * *', hosts: ['gone'], skill: 'nope', agent: 'ghost' }, '  \n')
        expect(parsed.spec).not.toBeNull()
        expect(parsed.errors).toEqual([])
        expect(parsed.warnings).toEqual([
            'host "gone" is not in hosts.yaml',
            'skill "nope" is not installed',
            'agent "ghost" does not exist',
            'the instructions are empty: the agent only gets the prefilter items'
        ])
    })

    it.each([
        [undefined, null],
        ['inherit', null],
        ['haiku', 'haiku'],
        ['  sonnet ', 'sonnet']
    ])('reads model %j as %j', (model, expected) => {
        expect(parse({ cron: '0 8 * * *', model }).spec?.model).toBe(expected)
    })

    it.each([
        [{ kind: 'command', run: 'ls' }, 'process'],
        [{ kind: 'github-prs', repo: 'a/b' }, 'skip'],
        [{ kind: 'trac', query: 'status=new' }, 'skip'],
        [null, 'process']
    ])('defaults first_run for prefilter %j to %s', (prefilter, firstRun) => {
        expect(parse({ cron: '0 8 * * *', prefilter }).spec?.first_run).toBe(firstRun)
    })

    it.each([
        [undefined, 120],
        [1, 5],
        [10_000, 900],
        ['60.7', 60],
        ['soon', 120]
    ])('clamps a command timeout of %j to %d', (timeout, expected) => {
        const spec = parse({ cron: '0 8 * * *', prefilter: { kind: 'command', run: ' ls ', timeout_s: timeout } }).spec
        expect(spec?.prefilter).toEqual({ kind: 'command', run: 'ls', cwd: undefined, timeout_s: expected })
    })

    it('fills the trac prefilter defaults', () => {
        const spec = parse({
            cron: '0 8 * * *',
            prefilter: { kind: 'trac', query: 'status=new', url: 'https://trac.example.com/login' }
        }).spec
        expect(spec?.prefilter).toEqual({
            kind: 'trac',
            url: 'https://trac.example.com/login',
            query: 'status=new',
            on_change: true,
            max: 100
        })
    })

    it('lets a github prefilter use the project instead of a repo', () => {
        const parsed = parse({ cron: '0 8 * * *', project: 'shop', prefilter: { kind: 'github-prs' } })
        expect(parsed.errors).toEqual([])
        expect(parsed.spec?.prefilter).toMatchObject({ kind: 'github-prs', filter: 'open', mine: false })
    })

    it.each([false, '', null])('treats prefilter %j as none', (prefilter) => {
        expect(parse({ cron: '0 8 * * *', prefilter }).spec?.prefilter).toBeNull()
    })

    it.each([
        [true, true],
        ['no', false],
        ['0', false],
        ['anything', true],
        [3, true]
    ])('reads enabled %j as %j', (enabled, expected) => {
        expect(parse({ cron: '0 8 * * *', enabled }).spec?.enabled).toBe(expected)
    })
})
