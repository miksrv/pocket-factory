import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Catalog } from '../files/catalog.js'
import { Hosts } from '../files/hosts.js'
import {
    addProjectNetwork,
    normalizeResource,
    projectNetworkList,
    sandboxNetwork,
    sshResource,
    urlResource
} from './network.js'

describe('sandbox network', () => {
    let dir: string
    let catalog: Catalog
    let hosts: Hosts
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-net-'))
        catalog = new Catalog(path.join(dir, 'claude'), path.join(dir, 'config'))
        hosts = new Hosts(path.join(dir, 'config', 'hosts.yaml'), catalog)
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('reads hosts as the policy takes them', () => {
        expect(normalizeResource(' Trac.Example.com ')).toBe('trac.example.com')
        expect(normalizeResource('*.bugfocus.com')).toBe('*.bugfocus.com')
        expect(normalizeResource('10.6.108.130:22')).toBe('10.6.108.130:22')
        expect(normalizeResource('http://x.com')).toBeNull()
        expect(normalizeResource('a b')).toBeNull()
        expect(sshResource('deploy@10.6.108.130')).toBe('10.6.108.130:22')
        expect(sshResource('mik@astro.example.org:2222')).toBe('astro.example.org:2222')
        expect(urlResource('https://trac.example.com/query?status=new')).toBe('trac.example.com:443')
        expect(urlResource('http://box:8080/x')).toBe('box:8080')
    })

    it("opens a project's network list, its SSH hosts and its routines' Trac sites", () => {
        hosts.save('tenant', { ssh: 'mik@10.6.108.130' })
        hosts.save('other', { ssh: 'mik@10.0.0.9:2222' })
        catalog.save('projects', 'shop', {
            frontmatter: { network: ['api.stripe.com', 'not a host'], hosts: [{ host: 'tenant', path: '/srv' }] },
            body: ''
        })
        catalog.save('routines', 'tickets', {
            frontmatter: { project: 'shop', steps: [{ trac: { url: 'https://trac.example.com/query?x=1' } }] },
            body: ''
        })
        catalog.save('routines', 'mail', {
            frontmatter: { steps: [{ trac: { url: 'https://trac.other.com/query?x=1' } }] },
            body: ''
        })
        expect(sandboxNetwork(catalog, hosts, 'shop')).toEqual([
            '10.6.108.130:22',
            'api.stripe.com',
            'trac.example.com:443'
        ])
        // The factory's own sandbox: every shared host, the project-less routines.
        expect(sandboxNetwork(catalog, hosts, null)).toEqual(['10.0.0.9:2222', '10.6.108.130:22', 'trac.other.com:443'])
    })

    it('adds an allowed host to the project file once', () => {
        catalog.save('projects', 'shop', { frontmatter: { repo: 'x' }, body: 'notes' })
        expect(addProjectNetwork(catalog, 'shop', 'db.example.com:5432')).toBe(true)
        expect(addProjectNetwork(catalog, 'shop', 'db.example.com:5432')).toBe(false)
        expect(projectNetworkList(catalog, 'shop')).toEqual(['db.example.com:5432'])
        const entry = catalog.get('projects', 'shop')
        expect(entry.frontmatter.repo).toBe('x')
        expect(entry.body.trim()).toBe('notes')
    })
})
