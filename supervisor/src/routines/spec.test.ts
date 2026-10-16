import { describe, expect, it } from 'vitest'

import { entry } from '../test/catalog.js'
import { parseRoutine, type Refs } from './spec.js'

const known =
    (...names: string[]) =>
    (name: string) =>
        names.includes(name)

const refs: Refs = {
    projectExists: known('shop'),
    hostExists: known('prod'),
    skillExists: known('pr-review'),
    agentExists: known('reviewer'),
    providerExists: known('gpu-box'),
    agentProvider: (name) =>
        name === 'writer' ? { provider: 'gpu-box', model: 'gemma4:12b' } : { provider: null, model: null }
}
const defaults = { tz: 'Europe/Warsaw' }

const parse = (frontmatter: Record<string, unknown>, body?: string, extra?: Parameters<typeof entry>[2]) =>
    parseRoutine(entry(frontmatter, body, extra), defaults, refs)

describe('parseRoutine', () => {
    it('fills the defaults for a minimal file', () => {
        const parsed = parse({ cron: '0 8 * * 1-5' })
        expect(parsed.errors).toEqual([])
        expect(parsed.warnings).toEqual([])
        expect(parsed.name).toBe('nightly')
        expect(parsed.spec).toMatchObject({
            name: 'nightly',
            triggers: [
                {
                    kind: 'schedule',
                    cron_text: 'at 08:00 on weekdays',
                    tz: 'Europe/Warsaw',
                    window: {},
                    prefilter: null
                }
            ],
            enabled: true,
            project: null,
            hosts: [],
            skill: null,
            agent: null,
            provider: null,
            model: null,
            action: null,
            prefilter: null,
            notify: 'telegram',
            session: 'fresh',
            first_run: 'process',
            max_items: 10,
            once: false
        })
        expect(parsed.spec?.triggers[0].cron.source).toBe('0 8 * * 1-5')
    })

    it('reads a file with no cron at all as a routine that runs only by hand', () => {
        const parsed = parse({ agent: 'reviewer' })
        expect(parsed.errors).toEqual([])
        expect(parsed.spec?.triggers).toEqual([])
        expect(parsed.spec?.prefilter).toBeNull()
    })

    it('reads cron: with prefilter: as one poll', () => {
        const parsed = parse({ cron: '*/10 * * * *', prefilter: { kind: 'command', run: 'ls' } })
        expect(parsed.spec?.triggers).toMatchObject([{ kind: 'poll', prefilter: { kind: 'command', run: 'ls' } }])
        expect(parsed.spec?.prefilter).toMatchObject({ kind: 'command' })
    })

    it('warns about a prefilter with nothing to poll it, and keeps it for Run now', () => {
        const parsed = parse({ prefilter: { kind: 'command', run: 'ls' } })
        expect(parsed.errors).toEqual([])
        expect(parsed.warnings).toContain('prefilter: without cron: or triggers: is only used by Run now')
        expect(parsed.spec?.prefilter).toMatchObject({ kind: 'command' })
    })

    describe('triggers:', () => {
        it('reads schedules and polls, each with its own zone and window on top of the file defaults', () => {
            const parsed = parse({
                tz: 'UTC',
                window: { days: 'mon-fri' },
                triggers: [
                    { schedule: '0 8 * * *' },
                    { poll: '*/15 * * * *', prefilter: { kind: 'command', run: 'ls' }, tz: 'Europe/Warsaw' },
                    { schedule: '0 20 * * *', window: { hours: '18:00-22:00' } }
                ]
            })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.triggers).toMatchObject([
                { kind: 'schedule', cron_text: 'at 08:00 every day', tz: 'UTC', prefilter: null },
                { kind: 'poll', tz: 'Europe/Warsaw', prefilter: { kind: 'command', run: 'ls' } },
                { kind: 'schedule', tz: 'UTC', window: { hours: { from: 18 * 60, to: 22 * 60 } } }
            ])
            expect([...parsed.spec!.triggers[0].window.days!]).toEqual([1, 2, 3, 4, 5])
            expect([...parsed.spec!.triggers[1].window.days!]).toEqual([1, 2, 3, 4, 5])
            expect(parsed.spec!.triggers[2].window.days).toBeUndefined()
            expect(parsed.spec?.prefilter).toMatchObject({ kind: 'command' })
        })

        it('allows an empty list (Run now only)', () => {
            const parsed = parse({ triggers: [] })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.triggers).toEqual([])
        })

        it.each([
            [{ triggers: 'daily' }, /triggers must be a list/],
            [{ triggers: ['0 8 * * *'] }, /triggers\[1\] must be a mapping/],
            [{ triggers: [{}] }, /triggers\[1\] must have exactly one of/],
            [{ triggers: [{ schedule: '0 8 * * *', poll: '0 9 * * *' }] }, /exactly one of/],
            [{ triggers: [{ schedule: '0 8 * *' }] }, /triggers\[1\]: a cron expression has five fields/],
            [{ triggers: [{ schedule: '' }] }, /triggers\[1\] needs a cron/],
            [{ triggers: [{ poll: '0 8 * * *' }] }, /triggers\[1\]: a poll needs a prefilter/],
            [
                { triggers: [{ poll: '0 8 * * *', prefilter: { kind: 'command' } }] },
                /triggers\[1\].prefilter.run is required/
            ],
            [{ triggers: [{ schedule: '0 8 * * *', tz: 'Mars/Base' }] }, /triggers\[1\].tz "Mars\/Base"/],
            [
                { triggers: [{ schedule: '0 8 * * *', window: { hours: 'x' } }] },
                /triggers\[1\].window.hours must be like/
            ],
            [{ triggers: [{ poll: '0 8 * * *', prefilter: { kind: 'github-prs' } }] }, /needs a `repo` or a `project`/]
        ])('reports an error for %j', (frontmatter, message) => {
            const parsed = parse(frontmatter)
            expect(parsed.spec).toBeNull()
            expect(parsed.errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]))
        })

        it('ignores a top-level cron: and prefilter: next to triggers:, with a warning', () => {
            const parsed = parse({
                cron: '0 8 * * *',
                prefilter: { kind: 'command', run: 'ls' },
                triggers: [{ schedule: '0 9 * * *' }]
            })
            expect(parsed.errors).toEqual([])
            expect(parsed.warnings).toContain(
                'cron: and prefilter: are ignored when triggers: is set; move them under a trigger'
            )
            expect(parsed.spec?.triggers).toHaveLength(1)
            expect(parsed.spec?.prefilter).toBeNull()
        })

        it('warns about a prefilter on a schedule', () => {
            const parsed = parse({ triggers: [{ schedule: '0 9 * * *', prefilter: { kind: 'command', run: 'ls' } }] })
            expect(parsed.warnings).toContain('triggers[1]: a schedule has no prefilter; use poll: for that')
            expect(parsed.spec?.triggers[0].prefilter).toBeNull()
        })
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
            triggers: [{ kind: 'poll', tz: 'UTC' }],
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
        expect([...parsed.spec!.triggers[0].window.days!].sort()).toEqual([1, 2, 3, 4, 5])
    })

    it.each([
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
        const parsed = parse({ cron: 'x', notify: 'x', session: 'y', tz: 'Nowhere/Here' })
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
