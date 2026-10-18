import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { FileEditor, fileTemplate, parseCsv } from './Files'

describe('parseCsv', () => {
    it('reads quoted fields, escaped quotes, newlines inside quotes and a BOM', () => {
        expect(parseCsv('﻿id,name\n1,"a, ""b"""\n2,"x\ny"\n')).toEqual([
            ['id', 'name'],
            ['1', 'a, "b"'],
            ['2', 'x\ny']
        ])
    })
})

describe('fileTemplate', () => {
    it('gives a script a header that says what it is', () => {
        expect(fileTemplate('scripts/gsc.sh', 'GSC stats')).toBe(
            '#!/usr/bin/env bash\n# GSC stats\n# secrets:\nset -euo pipefail\n\n'
        )
        expect(fileTemplate('data/queue.csv')).toBe('')
    })
})

describe('FileEditor', () => {
    afterEach(() => vi.unstubAllGlobals())
    const file = { path: 'data/places.csv', size: 20, text: true, exec: false, updated_at: '2026-10-17T10:00:00Z' }

    it('shows a CSV as a table and saves the text with the version it opened', async () => {
        const fetch = mockFetch({
            'GET /api/routines/geo/files/data/places.csv': {
                path: 'data/places.csv',
                text: 'id,name\n1,Vottovaara\n',
                updated_at: '2026-10-17T10:00:00Z'
            },
            'PUT /api/routines/geo/files/data/places.csv': file
        })
        renderWithProviders(
            <FileEditor
                kind='routines'
                name='geo'
                file={file}
            />
        )
        expect(await screen.findByRole('cell', { name: 'Vottovaara' })).toBeInTheDocument()
        const user = userEvent.setup()
        await user.click(screen.getByRole('tab', { name: 'Text' }))
        await user.type(screen.getByLabelText('data/places.csv'), '2,Shikhany\n')
        await user.click(screen.getByRole('button', { name: 'Save file' }))
        expect(fetch.requests().find((r) => r.method === 'PUT')?.body).toEqual({
            text: 'id,name\n1,Vottovaara\n2,Shikhany\n',
            updated_at: '2026-10-17T10:00:00Z'
        })
    })

    it('keeps the saved text in the editor and sends its new version with the next save', async () => {
        const fetch = mockFetch({
            'GET /api/routines/geo/files/scripts/a.sh': { path: 'scripts/a.sh', text: 'echo 1\n', updated_at: 't1' },
            'PUT /api/routines/geo/files/scripts/a.sh': { ...file, path: 'scripts/a.sh', updated_at: 't2' }
        })
        renderWithProviders(
            <FileEditor
                kind='routines'
                name='geo'
                file={{ ...file, path: 'scripts/a.sh' }}
            />
        )
        const user = userEvent.setup()
        const editor = await screen.findByLabelText('scripts/a.sh')
        await user.type(editor, 'x')
        await user.click(screen.getByRole('button', { name: 'Save file' }))
        expect(screen.getByLabelText('scripts/a.sh')).toHaveValue('echo 1\nx')
        await user.type(screen.getByLabelText('scripts/a.sh'), 'y')
        await user.click(screen.getByRole('button', { name: 'Save file' }))
        const puts = fetch.requests().filter((r) => r.method === 'PUT')
        expect(puts.map((r) => r.body)).toEqual([
            { text: 'echo 1\nx', updated_at: 't1' },
            { text: 'echo 1\nxy', updated_at: 't2' }
        ])
        expect(fetch.requests().filter((r) => r.method === 'GET')).toHaveLength(1)
    })

    it('offers a reload when a run changed the file since it was opened', async () => {
        mockFetch({
            'GET /api/routines/geo/files/scripts/a.sh': { path: 'scripts/a.sh', text: 'echo 1\n', updated_at: 't1' },
            'PUT /api/routines/geo/files/scripts/a.sh': new Response(
                JSON.stringify({ error: 'scripts/a.sh changed on disk since you opened it', changed: true }),
                { status: 409 }
            )
        })
        renderWithProviders(
            <FileEditor
                kind='routines'
                name='geo'
                file={{ ...file, path: 'scripts/a.sh', exec: true }}
            />
        )
        const user = userEvent.setup()
        await user.type(await screen.findByLabelText('scripts/a.sh'), 'x')
        await user.click(screen.getByRole('button', { name: 'Save file' }))
        expect(await screen.findByRole('button', { name: 'Reload from disk' })).toBeInTheDocument()
        expect(screen.getByLabelText('executable')).toBeChecked()
    })
})
