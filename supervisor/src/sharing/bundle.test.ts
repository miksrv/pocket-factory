import { describe, expect, it } from 'vitest'

import { itemNeeds, readBundle, readMarkdownBundle, routineRefs } from './bundle.js'
import type { ZipEntry } from './zip.js'

const file = (path: string, text: string, exec = false): ZipEntry => ({ path, bytes: Buffer.from(text), exec })
const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: Does ${name}.${extra}\n---\n\nBody.\n`
const summary = (entries: ZipEntry[], fallback = 'upload') =>
    readBundle(entries, fallback).items.map((item) => ({
        key: `${item.kind}/${item.name}`,
        files: item.files.map((f) => f.path),
        errors: item.errors
    }))

describe('readBundle', () => {
    it('reads the preset layout: agents, skill and routine folders, flat routines, projects; strays are listed', () => {
        const bundle = readBundle(
            [
                file('preset.json', '{"title":"Team kit","description":"For the team"}'),
                file('README.md', '# Team kit'),
                file('agents/reviewer.md', skill('reviewer')),
                file('skills/triage/SKILL.md', skill('triage')),
                file('skills/triage/scripts/fetch.sh', '#!/bin/sh\n', true),
                file('skills/stub/notes.md', 'a folder without SKILL.md is not a skill'),
                file('routines/nightly/ROUTINE.md', '---\nsteps:\n  - run: echo hi\n---\n\nGo.\n'),
                file('routines/nightly/scripts/a.sh', 'echo a\n'),
                file('routines/old.md', '---\ncron: "0 9 * * *"\n---\n\nOld.\n'),
                file('projects/shop.md', '---\nrepo: o/shop\n---\n'),
                file('other/thing.txt', 'x')
            ],
            'upload'
        )
        expect(bundle.title).toBe('Team kit')
        expect(bundle.description).toBe('For the team')
        expect(bundle.items.map((i) => `${i.kind}/${i.name}:${i.files.map((f) => f.path).join('+')}`)).toEqual([
            'agents/reviewer:',
            'skills/triage:scripts/fetch.sh',
            'routines/nightly:scripts/a.sh',
            'routines/old:',
            'projects/shop:'
        ])
        expect(bundle.items.every((i) => i.errors.length === 0)).toBe(true)
        expect(bundle.ignored).toEqual(['skills/stub/notes.md', 'other/thing.txt'])
        expect(bundle.items[1].files[0].exec).toBe(true)
    })

    it('takes a zipped folder or a repository download as its contents, and drops junk', () => {
        expect(
            summary([
                file('kit-main/skills/a/SKILL.md', skill('a')),
                file('kit-main/skills/a/.DS_Store', 'junk'),
                file('__MACOSX/kit-main/skills/a/._SKILL.md', 'junk'),
                file('kit-main/skills/a/node_modules/x/index.js', 'junk')
            ])
        ).toEqual([{ key: 'skills/a', files: [], errors: [] }])
    })

    it('reads one skill (SKILL.md at the root, a .skill file) under its own name, else its folder, else the file', () => {
        expect(summary([file('design/SKILL.md', skill('design-taste')), file('design/scripts/draw.mjs', 'x')])).toEqual(
            [{ key: 'skills/design-taste', files: ['scripts/draw.mjs'], errors: [] }]
        )
        const unnamed = '---\ndescription: No name here.\n---\n\nBody.\n'
        expect(summary([file('design/SKILL.md', unnamed)])[0].key).toBe('skills/design')
        expect(summary([file('SKILL.md', unnamed)], 'from-file')[0].key).toBe('skills/from-file')
        expect(summary([file('ROUTINE.md', '---\nsteps:\n  - run: echo\n---\n')], 'job')[0].key).toBe('routines/job')
    })

    it('names a skill and an agent of a repository by their own `name:`, and flags two with the same', () => {
        expect(
            summary([
                file('skills/taste-skill/SKILL.md', skill('design-taste-frontend')),
                file('skills/copy/SKILL.md', skill('design-taste-frontend')),
                file('agents/rev.md', skill('code-reviewer'))
            ])
        ).toEqual([
            { key: 'agents/code-reviewer', files: [], errors: [] },
            { key: 'skills/design-taste-frontend', files: [], errors: [] },
            { key: 'skills/design-taste-frontend', files: [], errors: ['another skill in the file has this name'] }
        ])
    })

    it('says why an item cannot be installed: a bad name, broken YAML, no description', () => {
        expect(
            readBundle(
                [
                    file('skills/bad name/SKILL.md', '---\ndescription: No name of its own.\n---\n'),
                    file('skills/yaml/SKILL.md', '---\nname: [unclosed\n---\n'),
                    file('agents/silent.md', '---\nname: silent\n---\n\nNo description.\n')
                ],
                'u'
            ).items.map((i) => [i.name, i.errors.join('; ')])
        ).toEqual([
            ['silent', expect.stringContaining('no `description:`')],
            ['bad name', expect.stringContaining('not a valid name')],
            ['yaml', expect.stringContaining('not valid YAML')]
        ])
    })
})

describe('readMarkdownBundle', () => {
    it('makes one skill or one agent of a Markdown file', () => {
        const asSkill = readMarkdownBundle(Buffer.from(skill('writer')), 'whatever.md', 'skills')
        expect(asSkill.items.map((i) => `${i.kind}/${i.name}`)).toEqual(['skills/writer'])
        const asAgent = readMarkdownBundle(
            Buffer.from('---\ndescription: Reviews.\n---\n\nYou review.\n'),
            'rev.md',
            'agents'
        )
        expect(asAgent.items.map((i) => `${i.kind}/${i.name}`)).toEqual(['agents/rev'])
        expect(readMarkdownBundle(Buffer.from('no frontmatter'), 'SKILL.md', 'skills').items[0]).toMatchObject({
            name: 'skill',
            errors: [expect.stringContaining('no `description:`')]
        })
    })
})

describe('itemNeeds and routineRefs', () => {
    it('lists what the scripts declare, secrets apart from variables', () => {
        const [item] = readBundle(
            [
                file('SKILL.md', skill('gsc')),
                file(
                    'scripts/fetch.sh',
                    '#!/bin/sh\n# Pulls the stats.\n# secrets: GSC_TOKEN\n# vars: SITE_URL\ncurl "$SITE_URL"\n'
                ),
                file('notes.md', '# secrets: NOT_A_SCRIPT\n')
            ],
            'u'
        ).items
        expect(itemNeeds(item)).toEqual([
            { name: 'GSC_TOKEN', secret: true },
            { name: 'SITE_URL', secret: false }
        ])
    })

    it('reads the agent, the skill and the project a routine names', () => {
        const [item] = readBundle(
            [
                file(
                    'ROUTINE.md',
                    '---\nproject: shop\nsteps:\n  - run: echo\n  - agent: reviewer\n    skill: triage\n---\n\nGo.\n'
                )
            ],
            'r'
        ).items
        expect(routineRefs(item)).toEqual({ agent: 'reviewer', skill: 'triage', project: 'shop' })
    })
})
