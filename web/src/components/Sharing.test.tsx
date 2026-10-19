import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ImportPreview } from '../lib/api'
import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { ExportDialog, ImportDialog } from './Sharing'

const PREVIEW: ImportPreview = {
    title: 'Team kit',
    description: null,
    items: [
        {
            kind: 'skills',
            name: 'triage',
            description: 'Sorts tickets.',
            exists: false,
            files: ['scripts/fetch.sh'],
            needs: [
                { name: 'TRIAGE_TOKEN', secret: true, set: false },
                { name: 'TRIAGE_URL', secret: false, set: true }
            ],
            errors: [],
            notes: []
        },
        {
            kind: 'routines',
            name: 'nightly',
            description: null,
            exists: true,
            files: [],
            needs: [],
            errors: [],
            notes: ['arrives switched off']
        },
        {
            kind: 'agents',
            name: 'broken',
            description: null,
            exists: false,
            files: [],
            needs: [],
            errors: ['no `description:` in the frontmatter'],
            notes: []
        }
    ],
    ignored: ['other/thing.txt'],
    ignored_count: 1
}

const zip = () => new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], 'kit.zip', { type: 'application/zip' })

describe('ImportDialog', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('ticks the new items, leaves what would replace yours and what cannot install, and installs the ticked ones', async () => {
        const fetch = mockFetch({
            'POST /api/share/import': ({ url }: { url: string }) =>
                url.includes('install=') ? { installed: [{ kind: 'skills', name: 'triage' }] } : PREVIEW
        })
        const onImported = vi.fn()
        renderWithProviders(
            <ImportDialog
                file={zip()}
                onClose={() => {}}
                onImported={onImported}
            />
        )
        const triage = await screen.findByRole('checkbox', { name: /triage/ })
        expect(triage).toBeChecked()
        expect(screen.getByRole('checkbox', { name: /nightly/ })).not.toBeChecked()
        expect(screen.getByRole('checkbox', { name: /broken/ })).toBeDisabled()
        expect(screen.getByText('replaces yours')).toBeInTheDocument()
        expect(screen.getByText('TRIAGE_TOKEN').closest('.need')).toHaveClass('missing')
        expect(screen.getByText('TRIAGE_URL').closest('.need')).toHaveClass('ok')
        expect(screen.getByText('arrives switched off')).toBeInTheDocument()
        expect(screen.getByText(/1 file belong to nothing here/)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: 'Install 1 item' }))
        expect(onImported).toHaveBeenCalledWith(1)
        const install = fetch.requests().find((r) => r.url.includes('install='))
        expect(decodeURIComponent(install!.url)).toContain('install=skills/triage')
    })

    it('asks before replacing an item you have', async () => {
        mockFetch({
            'POST /api/share/import': ({ url }: { url: string }) =>
                url.includes('install=') ? { installed: [{ kind: 'routines', name: 'nightly' }] } : PREVIEW
        })
        const onImported = vi.fn()
        renderWithProviders(
            <ImportDialog
                file={zip()}
                onClose={() => {}}
                onImported={onImported}
            />
        )
        await userEvent.click(await screen.findByRole('checkbox', { name: /nightly/ }))
        await userEvent.click(screen.getByRole('button', { name: 'Install 2 items' }))
        expect(await screen.findByText('Replace 1 item?')).toBeInTheDocument()
        expect(onImported).not.toHaveBeenCalled()
        await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
        expect(onImported).toHaveBeenCalledWith(1)
    })

    it('offers to read one Markdown file as a skill or an agent', async () => {
        const fetch = mockFetch({
            'POST /api/share/import': {
                ...PREVIEW,
                items: [{ ...PREVIEW.items[0], kind: 'skills', name: 'writer', files: [], needs: [] }]
            }
        })
        renderWithProviders(
            <ImportDialog
                file={new File(['---\ndescription: x\n---\n'], 'writer.md')}
                onClose={() => {}}
                onImported={() => {}}
            />
        )
        await screen.findByRole('checkbox', { name: /writer/ })
        await userEvent.click(screen.getByRole('tab', { name: 'Agent' }))
        expect(fetch.requests().at(-1)?.url).toContain('as=agents')
    })
})

describe('ExportDialog', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('exports the ticked items with the options', async () => {
        const fetch = mockFetch({
            'GET /api/agents': [{ name: 'reviewer' }],
            'GET /api/skills': [{ name: 'triage' }],
            'GET /api/routines': [{ name: 'nightly' }],
            'POST /api/share/export': () =>
                new Response(new Blob(['zip']), {
                    headers: { 'content-disposition': 'attachment; filename="nightly.zip"', 'x-masked-files': '0' }
                })
        })
        URL.createObjectURL = vi.fn(() => 'blob:x')
        URL.revokeObjectURL = vi.fn()
        const onExported = vi.fn()
        renderWithProviders(
            <ExportDialog
                onClose={() => {}}
                onExported={onExported}
            />
        )
        expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
        await userEvent.click(await screen.findByRole('checkbox', { name: 'nightly' }))
        await userEvent.click(screen.getByRole('checkbox', { name: /data\// }))
        await userEvent.click(screen.getByRole('button', { name: 'Export 1 item' }))
        expect(onExported).toHaveBeenCalledWith('Saved nightly.zip')
        expect(fetch.requests().find((r) => r.method === 'POST')?.body).toEqual({
            agents: [],
            skills: [],
            routines: ['nightly'],
            with_deps: true,
            with_data: true
        })
    })
})
