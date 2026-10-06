import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BadName, Catalog, NotFound } from './catalog.js'

describe('Catalog', () => {
    let dir: string
    let claude: string
    let config: string
    let catalog: Catalog

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-'))
        claude = path.join(dir, 'claude')
        config = path.join(dir, 'config')
        catalog = new Catalog(claude, config)
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('places each kind in its own directory', () => {
        expect(catalog.fileFor('agents', 'reviewer')).toBe(path.join(claude, 'agents', 'reviewer.md'))
        expect(catalog.fileFor('skills', 'pr-review')).toBe(path.join(claude, 'skills', 'pr-review', 'SKILL.md'))
        expect(catalog.fileFor('projects', 'shop')).toBe(path.join(config, 'projects', 'shop.md'))
        expect(catalog.fileFor('schedules', 'nightly')).toBe(path.join(config, 'schedules', 'nightly.md'))
    })

    it.each(['', '../etc/passwd', 'a/b', '.hidden', '-dash', 'a b', 'x'.repeat(65), 'a\\b', '..'])(
        'refuses the name %j',
        (name) => {
            expect(() => catalog.fileFor('agents', name)).toThrow(BadName)
            expect(() => catalog.get('agents', name)).toThrow(BadName)
            expect(() => catalog.save('agents', name, { frontmatter: {}, body: '' })).toThrow(BadName)
            expect(catalog.exists('agents', name)).toBe(false)
        }
    )

    it.each(['Explore', 'miksoft.pro', 'a_b-c.1', 'x'.repeat(64)])('accepts the name %j', (name) => {
        expect(() => catalog.fileFor('agents', name)).not.toThrow()
    })

    it('lists nothing before the directory exists', () => {
        expect(catalog.list('agents')).toEqual([])
    })

    it('saves an agent with its name forced into the frontmatter and reads it back', () => {
        const saved = catalog.save('agents', 'reviewer', {
            frontmatter: { name: 'other', model: 'haiku' },
            body: 'Review things.\n'
        })
        expect(saved).toMatchObject({
            kind: 'agents',
            name: 'reviewer',
            path: path.join(claude, 'agents', 'reviewer.md'),
            frontmatter: { name: 'reviewer', model: 'haiku' },
            // The blank line after the frontmatter comes back with the body; the next save drops it again.
            body: '\nReview things.\n'
        })
        expect(saved.frontmatter_error).toBeUndefined()
        expect(saved.size).toBe(fs.statSync(saved.path).size)
        expect(new Date(saved.updated_at).toISOString()).toBe(saved.updated_at)
        expect(catalog.get('agents', 'reviewer')).toEqual(saved)
        expect(catalog.exists('agents', 'reviewer')).toBe(true)
    })

    it('keeps a file stable across repeated saves', () => {
        const first = catalog.save('agents', 'a', { frontmatter: { x: 1 }, body: 'Body\n' })
        const text = fs.readFileSync(first.path, 'utf8')
        const second = catalog.save('agents', 'a', { frontmatter: first.frontmatter, body: first.body })
        expect(fs.readFileSync(second.path, 'utf8')).toBe(text)
    })

    it('gives a project its slug unless it has one, and no name', () => {
        expect(catalog.save('projects', 'shop', { frontmatter: {}, body: 'x' }).frontmatter).toEqual({ slug: 'shop' })
        expect(catalog.save('projects', 'p2', { frontmatter: { slug: 'kept' }, body: 'x' }).frontmatter).toEqual({
            slug: 'kept'
        })
    })

    it('lists files alphabetically regardless of case and skips foreign files', () => {
        for (const name of ['zeta', 'Explore', 'developer', 'alpha'])
            catalog.save('agents', name, { frontmatter: {}, body: '' })
        fs.writeFileSync(path.join(claude, 'agents', 'notes.txt'), 'x')
        fs.writeFileSync(path.join(claude, 'agents', '.hidden.md'), 'x')
        fs.mkdirSync(path.join(claude, 'agents', 'folder.md'))
        expect(catalog.list('agents').map((e) => e.name)).toEqual(['alpha', 'developer', 'Explore', 'zeta'])
    })

    it('lists skills by directory and skips a directory without SKILL.md', () => {
        catalog.save('skills', 'pr-review', { frontmatter: { description: 'd' }, body: 'Steps' })
        fs.mkdirSync(path.join(claude, 'skills', 'empty'))
        fs.writeFileSync(path.join(claude, 'skills', 'loose.md'), 'x')
        const list = catalog.list('skills')
        expect(list.map((e) => e.name)).toEqual(['pr-review'])
        expect(list[0].frontmatter).toEqual({ description: 'd', name: 'pr-review' })
    })

    it('reports invalid frontmatter instead of hiding the file', () => {
        fs.mkdirSync(path.join(config, 'schedules'), { recursive: true })
        fs.writeFileSync(path.join(config, 'schedules', 'broken.md'), '---\ncron: [0 8\n---\nbody\n')
        const entry = catalog.get('schedules', 'broken')
        expect(entry.frontmatter).toEqual({})
        expect(entry.body).toBe('body\n')
        expect(entry.frontmatter_error).toEqual(expect.any(String))
        expect(catalog.list('schedules').map((e) => e.name)).toEqual(['broken'])
    })

    it('throws NotFound for a missing file', () => {
        expect(() => catalog.get('agents', 'ghost')).toThrow(NotFound)
        expect(() => catalog.remove('agents', 'ghost')).toThrow(NotFound)
        expect(catalog.exists('agents', 'ghost')).toBe(false)
    })

    it('removes a file, and a skill with its directory', () => {
        catalog.save('agents', 'a', { frontmatter: {}, body: '' })
        catalog.save('skills', 's', { frontmatter: {}, body: '' })
        fs.writeFileSync(path.join(claude, 'skills', 's', 'helper.sh'), 'echo')
        catalog.remove('agents', 'a')
        catalog.remove('skills', 's')
        expect(fs.existsSync(path.join(claude, 'agents', 'a.md'))).toBe(false)
        expect(fs.existsSync(path.join(claude, 'skills', 's'))).toBe(false)
    })
})
