import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'

import { BadName, Catalog, NotFound } from './catalog.js'
import { Hosts, InUse, KEY_NAME, SSH_TARGET } from './hosts.js'

describe('SSH_TARGET', () => {
    it.each([
        ['deploy@example.com', 'deploy', 'example.com', undefined],
        ['root@10.0.0.1:2222', 'root', '10.0.0.1', '2222'],
        ['_svc.user-1@Host-A.local', '_svc.user-1', 'Host-A.local', undefined],
        ['me@[fe80::1]:22', 'me', '[fe80::1]', '22']
    ])('accepts %s', (target, user, host, port) => {
        const m = SSH_TARGET.exec(target)
        expect(m?.slice(1)).toEqual([user, host, port])
    })

    it.each([
        'example.com',
        '@example.com',
        'user@',
        'user@host:',
        'user@host:123456',
        '1user@host',
        'user@host name',
        'user@host;rm -rf /',
        '-oProxyCommand=x@host',
        `${'u'.repeat(33)}@host`
    ])('refuses %j', (target) => {
        expect(SSH_TARGET.test(target)).toBe(false)
    })
})

describe('KEY_NAME', () => {
    it.each(['id_ed25519', 'deploy.key', 'a-b_c.1'])('accepts %s', (name) => {
        expect(KEY_NAME.test(name)).toBe(true)
    })

    it.each(['', '../id_rsa', 'a/b', 'a b', 'x'.repeat(65)])('refuses %j', (name) => {
        expect(KEY_NAME.test(name)).toBe(false)
    })
})

describe('Hosts', () => {
    let dir: string
    let file: string
    let catalog: Catalog
    let hosts: Hosts

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hosts-'))
        file = path.join(dir, 'config', 'hosts.yaml')
        catalog = new Catalog(path.join(dir, 'claude'), path.join(dir, 'config'))
        hosts = new Hosts(file, catalog)
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const project = (slug: string, list: unknown[]) =>
        catalog.save('projects', slug, { frontmatter: { hosts: list }, body: 'b' })

    it('lists nothing without a file', () => {
        expect(hosts.list()).toEqual({ file, hosts: [], inline: [], error: null })
    })

    it('saves hosts sorted, with a header and without empty fields', () => {
        hosts.save('zeta', { ssh: ' deploy@zeta.example.com ', key: '' })
        hosts.save('Alpha', { ssh: 'root@alpha.example.com:2222', key: 'id_alpha' })
        const text = fs.readFileSync(file, 'utf8')
        expect(text.startsWith('# Shared SSH hosts')).toBe(true)
        expect(YAML.parse(text)).toEqual({
            hosts: [
                { name: 'Alpha', ssh: 'root@alpha.example.com:2222', key: 'id_alpha' },
                { name: 'zeta', ssh: 'deploy@zeta.example.com' }
            ]
        })
        expect(hosts.get('zeta')).toEqual({ name: 'zeta', ssh: 'deploy@zeta.example.com' })
        expect(hosts.get('nope')).toBeUndefined()
    })

    it.each([
        ['bad name', { ssh: 'a@b' }, /Invalid host name/],
        ['ok', { ssh: 'not a target' }, /ssh target must look like/],
        ['ok', { ssh: 'a@b', key: '../id_rsa' }, /invalid key name/],
        ['ok', { ssh: 'a@b', name: '../x' }, /Invalid host name/]
    ])('refuses to save %s with %j', (name, host, message) => {
        expect(() => hosts.save(name, host)).toThrow(BadName)
        expect(() => hosts.save(name, host)).toThrow(message)
    })

    it('shows which projects and schedules use a host, and dangling references', () => {
        hosts.save('prod', { ssh: 'deploy@prod.example.com' })
        project('shop', [{ host: 'prod', path: '/srv/shop', notes: 'careful' }, { host: 'gone' }])
        catalog.save('schedules', 'nightly', { frontmatter: { hosts: ['prod', '', 5] }, body: 'b' })
        const { hosts: views } = hosts.list()
        expect(views).toEqual([
            {
                name: 'prod',
                ssh: 'deploy@prod.example.com',
                projects: [
                    { project: 'shop', kind: 'project', path: '/srv/shop', notes: 'careful' },
                    { project: 'nightly', kind: 'schedule' }
                ]
            },
            { name: 'gone', ssh: '', projects: [{ project: 'shop', kind: 'project' }] }
        ])
    })

    it('lists hosts written inside a project and finds their shared twin', () => {
        hosts.save('prod', { ssh: 'deploy@prod.example.com', key: 'k' })
        project('shop', [
            { name: 'inline', ssh: ' deploy@prod.example.com ', key: 'k', path: '/srv' },
            { ssh: 'other@host' }
        ])
        catalog.save('schedules', 'nightly', { frontmatter: { hosts: [{ ssh: 'x@y' }] }, body: 'b' })
        expect(hosts.list().inline).toEqual([
            {
                project: 'shop',
                index: 0,
                host: { name: 'inline', ssh: ' deploy@prod.example.com ', key: 'k', path: '/srv' },
                same_as: 'prod'
            },
            { project: 'shop', index: 1, host: { ssh: 'other@host' }, same_as: null }
        ])
    })

    it('renames a host and every reference follows', () => {
        hosts.save('prod', { ssh: 'deploy@prod.example.com' })
        project('shop', [{ host: 'prod', path: '/srv/shop' }, { ssh: 'x@y' }])
        catalog.save('schedules', 'nightly', { frontmatter: { cron: '0 8 * * *', hosts: ['prod'] }, body: 'b' })
        const view = hosts.save('prod', { name: 'production', ssh: 'deploy@prod.example.com' })
        expect(view.name).toBe('production')
        expect(hosts.get('prod')).toBeUndefined()
        expect(catalog.get('projects', 'shop').frontmatter.hosts).toEqual([
            { host: 'production', path: '/srv/shop' },
            { ssh: 'x@y' }
        ])
        expect(catalog.get('schedules', 'nightly').frontmatter).toMatchObject({
            cron: '0 8 * * *',
            hosts: [{ host: 'production' }]
        })
    })

    it('refuses a rename onto an existing name', () => {
        hosts.save('a', { ssh: 'u@a' })
        hosts.save('b', { ssh: 'u@b' })
        expect(() => hosts.save('a', { name: 'b', ssh: 'u@a' })).toThrow('already exists')
    })

    it('removes an unused host and refuses a used one unless detached', () => {
        hosts.save('free', { ssh: 'u@free' })
        hosts.save('prod', { ssh: 'u@prod' })
        project('shop', [{ host: 'prod' }, { host: 'free2' }])
        hosts.remove('free', false)
        expect(hosts.get('free')).toBeUndefined()

        let error: unknown
        try {
            hosts.remove('prod', false)
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(InUse)
        expect((error as InUse).projects).toEqual(['shop'])

        hosts.remove('prod', true)
        expect(hosts.get('prod')).toBeUndefined()
        expect(catalog.get('projects', 'shop').frontmatter.hosts).toEqual([{ host: 'free2' }])
        expect(() => hosts.remove('prod', true)).toThrow(NotFound)
    })

    it('reports a broken hosts.yaml and refuses to write over it', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'hosts: [unclosed\n')
        const overview = hosts.list()
        expect(overview.hosts).toEqual([])
        expect(overview.error).toEqual(expect.any(String))
        expect(() => hosts.save('a', { ssh: 'u@a' })).toThrow('not valid YAML')
        expect(() => hosts.remove('a', true)).toThrow('not valid YAML')
        expect(fs.readFileSync(file, 'utf8')).toBe('hosts: [unclosed\n')
    })

    it('ignores malformed entries in the file', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(
            file,
            YAML.stringify({ hosts: [{ name: 'ok', ssh: 'u@h', key: '' }, { name: 'no-ssh' }, 'x', null] })
        )
        expect(hosts.list().hosts).toEqual([{ name: 'ok', ssh: 'u@h', projects: [] }])
    })
})
