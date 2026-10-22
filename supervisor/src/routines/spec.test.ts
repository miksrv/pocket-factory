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
    it('fills the defaults for a minimal file: one schedule, the orchestrator as the agent step', () => {
        const parsed = parse({ cron: '0 8 * * 1-5' })
        expect(parsed.errors).toEqual([])
        expect(parsed.warnings).toEqual([])
        expect(parsed.name).toBe('nightly')
        expect(parsed.spec).toMatchObject({
            name: 'nightly',
            triggers: [{ kind: 'schedule', cron_text: 'at 08:00 on weekdays', tz: 'Europe/Warsaw', window: {} }],
            steps: [{ kind: 'agent', name: 'agent', agent: null, skill: null }],
            agentStep: { kind: 'agent', agent: null },
            agent: null,
            skill: null,
            enabled: true,
            project: null,
            hosts: [],
            provider: null,
            model: null,
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
        expect(parsed.spec?.agent).toBe('reviewer')
    })

    describe('steps:', () => {
        it('reads scripts, sources and the agent in order, with their defaults', () => {
            const parsed = parse({
                project: 'shop',
                steps: [
                    { name: 'stats', run: '${SKILL_DIR}/scripts/stats.sh', timeout_s: 60, cwd: 'tools' },
                    'echo plain',
                    { run: 'gh pr list', items: true, continue_on_error: true, enabled: false },
                    { 'github-prs': { filter: 'review-requested', mine: 'yes', drafts: true, new_only: false } },
                    { name: 'bugs', trac: { query: 'status=new', url: 'https://trac.example.com/login' } },
                    { agent: 'reviewer', skill: 'pr-review' }
                ]
            })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.steps).toEqual([
                {
                    kind: 'run',
                    name: 'stats',
                    run: '${SKILL_DIR}/scripts/stats.sh',
                    cwd: 'tools',
                    timeout_s: 60,
                    items: false,
                    new_only: false,
                    continue_on_error: false,
                    enabled: true,
                    if: 'success'
                },
                {
                    kind: 'run',
                    name: 'step 2',
                    run: 'echo plain',
                    cwd: undefined,
                    timeout_s: 300,
                    items: false,
                    new_only: false,
                    continue_on_error: false,
                    enabled: true,
                    if: 'success'
                },
                {
                    kind: 'run',
                    name: 'step 3',
                    run: 'gh pr list',
                    cwd: undefined,
                    timeout_s: 300,
                    items: true,
                    new_only: true,
                    continue_on_error: true,
                    enabled: false,
                    if: 'success'
                },
                {
                    kind: 'github-prs',
                    name: 'pull requests',
                    repos: [],
                    filter: 'review-requested',
                    mine: true,
                    drafts: true,
                    new_only: false,
                    continue_on_error: false,
                    enabled: true
                },
                {
                    kind: 'trac',
                    name: 'bugs',
                    url: 'https://trac.example.com/login',
                    query: 'status=new',
                    on_change: true,
                    max: 100,
                    new_only: true,
                    continue_on_error: false,
                    enabled: true
                },
                { kind: 'agent', name: 'agent', agent: 'reviewer', skill: 'pr-review' }
            ])
            expect(parsed.spec?.agent).toBe('reviewer')
            expect(parsed.spec?.skill).toBe('pr-review')
            // Built-in sources start from now; a script source hands existing items over.
            expect(parsed.spec?.first_run).toBe('skip')
        })

        it('is scripts only without an agent step, and `agent: orchestrator` names the orchestrator', () => {
            const only = parse({ steps: [{ run: 'backup.sh' }] })
            expect(only.errors).toEqual([])
            expect(only.spec?.agentStep).toBeNull()
            expect(only.spec?.steps).toHaveLength(1)
            const orchestrator = parse({ steps: [{ run: 'x' }, { agent: 'orchestrator' }] })
            expect(orchestrator.spec?.agentStep).toMatchObject({ agent: null })
            expect(orchestrator.warnings).toEqual([])
        })

        it('keeps agent: and skill: on top as the agent step, and warns when both are given', () => {
            const top = parse({ agent: 'reviewer', skill: 'pr-review', steps: [{ run: 'x' }] })
            expect(top.errors).toEqual([])
            expect(top.spec?.steps.map((s) => s.kind)).toEqual(['run', 'agent'])
            expect(top.spec?.agentStep).toMatchObject({ agent: 'reviewer', skill: 'pr-review' })
            const both = parse({ agent: 'reviewer', steps: [{ agent: 'ghost' }] })
            expect(both.warnings).toContain('agent: and skill: on top are ignored: the `agent:` step has its own')
            expect(both.spec?.agent).toBe('ghost')
        })

        it('reads a trac url that is the whole address of a custom query', () => {
            const parsed = parse({
                steps: [{ trac: { url: 'https://trac.example.com/query?status=new&col=id&order=priority' } }]
            })
            expect(parsed.spec?.steps[0]).toMatchObject({
                kind: 'trac',
                url: 'https://trac.example.com',
                query: 'status=new&col=id&order=priority'
            })
        })

        it.each([
            [{ steps: 'x' }, /steps must be a list/],
            [{ steps: [7] }, /steps\[1\] must be a command or a mapping/],
            [{ steps: [{}] }, /steps\[1\] must have exactly one of/],
            [{ steps: [{ run: 'a', agent: 'b' }] }, /exactly one of/],
            [{ steps: [{ run: '  ' }] }, /steps\[1\].run is required/],
            [{ steps: [{ kind: 'imap' }] }, /unknown kind "imap"/],
            [{ steps: [{ 'github-prs': { filter: 'all' } }, { agent: 'x' }] }, /steps\[1\].filter must be/],
            [{ steps: [{ 'github-prs': { repo: 'not a repo' } }] }, /owner\/name/],
            [{ steps: [{ 'github-prs': {} }] }, /needs a `repo` or a `project`/],
            [{ steps: [{ trac: { query: 'a=b' } }] }, /steps\[1\].url is required/],
            [{ steps: [{ trac: { query: 'a=b', url: 'ftp://x' } }] }, /steps\[1\].url must start/],
            [{ steps: [{ trac: { url: 'https://trac.example.com/query' } }] }, /steps\[1\].url has no query/],
            [{ steps: [{ agent: 'a' }, { trac: { url: 'https://t.example/query?a=b' } }] }, /only scripts/],
            [{ steps: [{ agent: 'a' }, { run: 'x', items: true }] }, /cannot be a source/],
            [{ steps: [{ run: 'x', if: 'always' }, { agent: 'a' }] }, /`if:` is for steps after the agent/],
            [{ steps: [{ agent: 'a' }, { run: 'x', if: 'sometimes' }] }, /\.if must be success, failure or always/],
            [{ hand_off: ['nowhere'] }, /hand_off: project "nowhere" has no file/],
            [{ steps: [{ agent: 'a' }, { agent: 'b' }] }, /at most one/],
            [{ steps: [] }, /nothing to run/]
        ])('reports an error for %j', (frontmatter, message) => {
            const parsed = parse(frontmatter)
            expect(parsed.spec).toBeNull()
            expect(parsed.errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]))
        })

        it('reads the scripts after the agent with their condition', () => {
            const parsed = parse({
                steps: [
                    { run: 'before' },
                    { agent: 'reviewer' },
                    { run: 'publish', name: 'Publish' },
                    { run: 'alert', if: 'failure' },
                    { run: 'cleanup', if: 'always', continue_on_error: true }
                ]
            })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.agentStep).toMatchObject({ agent: 'reviewer' })
            expect(parsed.spec?.after.map((s) => [s.run, s.if])).toEqual([
                ['publish', 'success'],
                ['alert', 'failure'],
                ['cleanup', 'always']
            ])
            expect(parsed.spec?.steps).toHaveLength(5)
        })

        it.each([
            [undefined, 300],
            [1, 5],
            [10_000, 3600],
            ['60.7', 60],
            ['soon', 300]
        ])('clamps a script timeout of %j to %d', (timeout, expected) => {
            const spec = parse({ steps: [{ run: ' ls ', timeout_s: timeout }, { agent: 'x' }] }).spec
            expect(spec?.steps[0]).toMatchObject({ kind: 'run', run: 'ls', timeout_s: expected })
        })

        it('reads the repository as owner/name, its GitHub address, or a list of either', () => {
            const parsed = parse({
                steps: [
                    { 'github-prs': { repo: 'https://github.com/Org/Nav' } },
                    { 'github-prs': { repo: ['git@github.com:a/b.git', 'c/d', 'https://github.com/c/d/pulls'] } }
                ]
            })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.steps).toMatchObject([
                { repos: ['Org/Nav'], name: 'PRs of Org/Nav' },
                { repos: ['a/b', 'c/d'], name: 'pull requests' }
            ])
        })

        it('takes only a github.com address as an address, not a host that merely contains it', () => {
            const parsed = parse({ steps: [{ 'github-prs': { repo: 'https://evil.example/github.com/a/b' } }] })
            expect(parsed.errors).toEqual([
                'steps[1].repo "https://evil.example/github.com/a/b" must be owner/name or the repository\'s GitHub address'
            ])
        })

        it('lets a github step use the project instead of a repo', () => {
            const parsed = parse({ project: 'shop', steps: [{ 'github-prs': {} }, { agent: 'reviewer' }] })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.steps[0]).toMatchObject({
                kind: 'github-prs',
                filter: 'open',
                mine: false,
                new_only: true
            })
        })
    })

    describe('the 1.5.0 shape', () => {
        it('reads cron: with prefilter: as a schedule with a source step, and warns', () => {
            const parsed = parse({ cron: '*/10 * * * *', prefilter: { kind: 'command', run: 'ls' } })
            expect(parsed.errors).toEqual([])
            expect(parsed.warnings).toContain('prefilter: is read as the first step; move it under steps:')
            expect(parsed.spec?.triggers).toMatchObject([{ kind: 'schedule' }])
            expect(parsed.spec?.steps).toMatchObject([
                { kind: 'run', run: 'ls', items: true, new_only: true },
                { kind: 'agent', agent: null }
            ])
        })

        it('ignores a top-level prefilter: next to triggers:, as 1.5.0 did, and warns', () => {
            const parsed = parse({ triggers: [], prefilter: { kind: 'command', run: 'ls' } })
            expect(parsed.errors).toEqual([])
            expect(parsed.warnings).toContain('prefilter: is ignored when triggers: is set; move it under steps:')
            expect(parsed.spec?.steps).toMatchObject([{ kind: 'agent' }])
        })

        it('reads a poll: trigger as a schedule and its prefilter as a step, with the file defaults for zone and window', () => {
            const parsed = parse({
                tz: 'UTC',
                window: { days: 'mon-fri' },
                triggers: [
                    { poll: '0 8 * * *' },
                    { poll: '*/15 * * * *', prefilter: { kind: 'github-prs', repo: 'a/b' }, tz: 'Europe/Warsaw' },
                    { poll: '0 20 * * *', window: { hours: '18:00-22:00' } }
                ],
                agent: 'reviewer'
            })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.triggers).toMatchObject([
                { kind: 'schedule', cron_text: 'at 08:00 every day', tz: 'UTC' },
                { kind: 'schedule', tz: 'Europe/Warsaw' },
                { kind: 'schedule', tz: 'UTC', window: { hours: { from: 18 * 60, to: 22 * 60 } } }
            ])
            expect([...parsed.spec!.triggers[0].window.days!]).toEqual([1, 2, 3, 4, 5])
            expect(parsed.spec!.triggers[2].window.days).toBeUndefined()
            expect(parsed.spec?.steps).toMatchObject([
                { kind: 'github-prs', repos: ['a/b'], new_only: true },
                { kind: 'agent', agent: 'reviewer' }
            ])
            expect(parsed.warnings).toContain(
                'triggers[2]: poll: is read as schedule:, its prefilter as a step; move it under steps:'
            )
        })

        it.each([[''], [false]])('reads a poll with an empty prefilter (%j) as a plain schedule, no step', (empty) => {
            const parsed = parse({ triggers: [{ poll: '0 8 * * *', prefilter: empty }], agent: 'reviewer' })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.steps).toMatchObject([{ kind: 'agent', agent: 'reviewer' }])
        })

        it('refuses a schedule next to a poll with a prefilter: one pipeline would gate the schedule too', () => {
            const parsed = parse({
                triggers: [
                    { schedule: '0 8 * * *' },
                    { poll: '*/15 * * * *', prefilter: { kind: 'github-prs', repo: 'a/b' } }
                ],
                agent: 'reviewer'
            })
            expect(parsed.spec).toBeNull()
            expect(parsed.errors.join(' ')).toContain('split the file into two routines')
        })

        it('reads the old trac prefilter with its defaults', () => {
            const spec = parse({
                cron: '0 8 * * *',
                prefilter: { kind: 'trac', query: 'status=new', url: 'https://trac.example.com/login' }
            }).spec
            expect(spec?.steps[0]).toEqual({
                kind: 'trac',
                name: 'Trac tickets',
                url: 'https://trac.example.com/login',
                query: 'status=new',
                on_change: true,
                max: 100,
                new_only: true,
                continue_on_error: false,
                enabled: true
            })
        })

        it.each([false, '', null])('treats prefilter %j as none', (prefilter) => {
            expect(parse({ cron: '0 8 * * *', prefilter }).spec?.steps.map((s) => s.kind)).toEqual(['agent'])
        })
    })

    describe('triggers:', () => {
        it('allows an empty list (Run now only)', () => {
            const parsed = parse({ triggers: [] })
            expect(parsed.errors).toEqual([])
            expect(parsed.spec?.triggers).toEqual([])
        })

        it.each([
            [{ triggers: 'daily' }, /triggers must be a list/],
            [{ triggers: ['0 8 * * *'] }, /triggers\[1\] must be a mapping/],
            [{ triggers: [{}] }, /triggers\[1\] must have `schedule:`/],
            [{ triggers: [{ schedule: '0 8 * * *', poll: '0 9 * * *' }] }, /must have `schedule:`/],
            [{ triggers: [{ schedule: '0 8 * *' }] }, /triggers\[1\]: a cron expression has five fields/],
            [{ triggers: [{ schedule: '' }] }, /triggers\[1\] needs a cron/],
            [{ triggers: [{ schedule: '0 8 * * *', tz: 'Mars/Base' }] }, /triggers\[1\].tz "Mars\/Base"/],
            [
                { triggers: [{ schedule: '0 8 * * *', window: { hours: 'x' } }] },
                /triggers\[1\].window.hours must be like/
            ]
        ])('reports an error for %j', (frontmatter, message) => {
            const parsed = parse(frontmatter)
            expect(parsed.spec).toBeNull()
            expect(parsed.errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]))
        })

        it('ignores a top-level cron: next to triggers:, with a warning', () => {
            const parsed = parse({ cron: '0 8 * * *', triggers: [{ schedule: '0 9 * * *' }] })
            expect(parsed.errors).toEqual([])
            expect(parsed.warnings).toContain('cron: is ignored when triggers: is set; move it under a trigger')
            expect(parsed.spec?.triggers).toHaveLength(1)
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
            model: 'opus',
            steps: [
                { 'github-prs': { filter: 'review-requested', mine: 'yes', drafts: true } },
                { agent: 'reviewer', skill: 'pr-review' }
            ],
            notify: 'none',
            session: 'continue',
            first_run: 'process',
            max_items: '500',
            once: true
        })
        expect(parsed.errors).toEqual([])
        expect(parsed.spec).toMatchObject({
            triggers: [{ kind: 'schedule', tz: 'UTC' }],
            enabled: false,
            project: 'shop',
            hosts: [{ host: 'prod' }, { host: 'prod', path: '/srv/shop', notes: 'read only' }],
            skill: 'pr-review',
            agent: 'reviewer',
            model: 'opus',
            notify: 'none',
            session: 'continue',
            first_run: 'process',
            max_items: 100,
            once: true
        })
        expect(parsed.spec?.steps[0]).toMatchObject({
            kind: 'github-prs',
            filter: 'review-requested',
            mine: true,
            drafts: true
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
        [{ cron: '0 8 * * *', prefilter: 7 }, /prefilter must be a command or a mapping/],
        [{ cron: '0 8 * * *', prefilter: { kind: 'imap' } }, /unknown kind "imap"/]
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
            'the instructions are empty: the agent only gets what the steps found'
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
        [{ run: 'ls', items: true }, 'process'],
        [{ 'github-prs': { repo: 'a/b' } }, 'skip'],
        [{ trac: { url: 'https://trac.example.com/query?status=new' } }, 'skip'],
        [{ run: 'ls' }, 'process']
    ])('defaults first_run for a source %j to %s', (step, firstRun) => {
        expect(parse({ cron: '0 8 * * *', steps: [step, { agent: 'x' }] }).spec?.first_run).toBe(firstRun)
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
