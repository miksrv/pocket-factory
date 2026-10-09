import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectToolchain, ToolchainsOverview } from '../lib/api'
import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { ProjectToolchainField, ToolchainsSection } from './Toolchains'

const OVERVIEW: ToolchainsOverview = {
    mise: {
        version: '2026.10.6 linux-x64 (2026-10-09)',
        data_dir: '/data/tools/mise',
        size_kb: 1_300_000,
        tools: [
            {
                tool: 'go',
                version: '1.25.1',
                install_path: '/data/tools/mise/installs/go/1.25.1',
                source: null,
                active: false,
                size_kb: 250_000,
                used_by: ['user-management', 'tenant-management']
            },
            {
                tool: 'node',
                version: '20.11.0',
                install_path: '/data/tools/mise/installs/node/20.11.0',
                source: '/data/workspaces/geometki/client/.nvmrc',
                active: false,
                size_kb: 60_000,
                used_by: []
            }
        ]
    },
    image: { php: '8.2.34', composer: '2.10.3 2026-08-27' },
    docker: {
        enabled: true,
        host: 'tcp://docker:2376',
        reachable: true,
        version: '29.9.0',
        error: null,
        containers: [
            {
                id: 'abc',
                name: 'geometki-db-1',
                image: 'mysql:8',
                state: 'running',
                status: 'Up 3 minutes',
                ports: '3306/tcp',
                created: '',
                compose: { working_dir: '/data/workspaces/geometki', project: 'geometki', service: 'db' }
            }
        ],
        disk: [{ type: 'Images', total: 3, active: 1, size: '1.2GB', reclaimable: '800MB (66%)' }]
    }
}

const PROJECT: ProjectToolchain = {
    slug: 'geometki',
    path: '/data/workspaces/geometki',
    tools: [
        {
            tool: 'php',
            version: '^8.2',
            source: 'server/composer.json',
            spec: 'php@8.2',
            status: 'image',
            installed_version: '8.2.34'
        },
        {
            tool: 'node',
            version: '20.11.0',
            source: 'client/.nvmrc',
            spec: 'node@20.11.0',
            status: 'missing',
            installed_version: null
        }
    ],
    services: [{ file: 'config/docker-compose.yml', services: ['db', 'redis'] }],
    docker: { enabled: true }
}

describe('ToolchainsSection', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('lists the versions with their size and projects, the image, Docker and its containers', () => {
        renderWithProviders(
            <ToolchainsSection
                data={OVERVIEW}
                onChanged={() => {}}
            />
        )
        expect(screen.getByText(/mise 2026\.10\.6 · 2 versions in/)).toBeInTheDocument()
        expect(screen.getByText('go 1.25.1')).toBeInTheDocument()
        expect(screen.getByText(/244\.1 MB · user-management, tenant-management/)).toBeInTheDocument()
        expect(screen.getByText(/asked by geometki\/client\/\.nvmrc/)).toBeInTheDocument()
        expect(screen.getByText(/PHP 8\.2\.34/)).toBeInTheDocument()
        expect(screen.getByText(/dind 29\.9\.0 at/)).toBeInTheDocument()
        expect(screen.getByText('geometki-db-1')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    })

    it('installs what is typed and asks before removing a version', async () => {
        const fetch = mockFetch({
            'POST /api/toolchains/install': { installed: 'python@3.12' },
            'DELETE /api/toolchains/tools/go/1.25.1': { removed: true }
        })
        const onChanged = vi.fn()
        renderWithProviders(
            <ToolchainsSection
                data={OVERVIEW}
                onChanged={onChanged}
            />
        )
        const user = userEvent.setup()
        await user.type(screen.getByLabelText('Tool to install'), 'python@3.12')
        await user.click(screen.getByRole('button', { name: 'Install' }))
        expect(fetch.requests().at(-1)).toMatchObject({ method: 'POST', body: { spec: 'python@3.12' } })
        expect(await screen.findByText('Installed python@3.12')).toBeInTheDocument()
        expect(onChanged).toHaveBeenCalledTimes(1)

        await user.click(screen.getAllByRole('button', { name: 'Remove' })[0])
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText(/user-management, tenant-management resolve to it/)).toBeInTheDocument()
        await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
        expect(fetch.requests().at(-1)).toMatchObject({ method: 'DELETE', url: '/api/toolchains/tools/go/1.25.1' })
    })

    it('says when mise is missing and Docker is off', () => {
        renderWithProviders(
            <ToolchainsSection
                data={{
                    ...OVERVIEW,
                    mise: { ...OVERVIEW.mise, version: null, tools: [] },
                    docker: { ...OVERVIEW.docker, enabled: false, reachable: false, containers: [] }
                }}
                onChanged={() => {}}
            />
        )
        expect(screen.getByText(/mise is not on PATH here/)).toBeInTheDocument()
        expect(screen.getByText(/off — the agents have no Docker/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    })
})

describe('ProjectToolchainField', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('shows the needs with a badge each and installs a missing one', async () => {
        const fetch = mockFetch({
            'GET /api/toolchains/projects/geometki': PROJECT,
            'POST /api/toolchains/install': { installed: 'node@20.11.0' }
        })
        renderWithProviders(<ProjectToolchainField slug='geometki' />)
        expect(await screen.findByText('php')).toBeInTheDocument()
        expect(screen.getByText('in the image (8.2.34)')).toBeInTheDocument()
        expect(screen.getByText('missing')).toBeInTheDocument()
        expect(screen.getByText(/db, redis · config\/docker-compose\.yml/)).toBeInTheDocument()
        expect(screen.getByText('docker on')).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Install node@20.11.0' }))
        expect(fetch.requests().find((r) => r.method === 'POST')).toMatchObject({ body: { spec: 'node@20.11.0' } })
    })

    it('renders nothing without a slug', () => {
        const { container } = renderWithProviders(<ProjectToolchainField slug='' />)
        expect(container).toBeEmptyDOMElement()
    })
})
