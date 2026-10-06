import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Attachment } from '../lib/api'
import { json, mockFetch } from '../test/fetch'
import { displayName, MAX_FILES, PendingUploads, SentAttachments, type Upload, useUploads } from './Attachments'

const PHOTO: Attachment = {
    name: '20261006-094112-a1b2c3-screen shot.png',
    path: '/data/inbox/c1/20261006-094112-a1b2c3-screen shot.png',
    type: 'image/png',
    size: 2048
}
const LOG: Attachment = {
    name: '20261006-094113-d4e5f6-build.log',
    path: '/data/inbox/c1/20261006-094113-d4e5f6-build.log',
    type: 'text/plain',
    size: 512
}

describe('displayName', () => {
    it('drops the inbox prefix', () => {
        expect(displayName(PHOTO)).toBe('screen shot.png')
        expect(displayName({ ...LOG, name: 'plain.txt' })).toBe('plain.txt')
    })
})

describe('SentAttachments', () => {
    it('shows an image as a thumbnail that opens full size, and a file as a download', () => {
        render(
            <SentAttachments
                conversationId='c1'
                attachments={[PHOTO, LOG]}
            />
        )
        const image = screen.getByRole('img', { name: 'screen shot.png' })
        const url = '/api/conversations/c1/attachments/20261006-094112-a1b2c3-screen%20shot.png'
        expect(image).toHaveAttribute('src', url)
        expect(image.closest('a')).toHaveAttribute('href', url)
        expect(image.closest('a')).toHaveAttribute('target', '_blank')
        const file = screen.getByRole('link', { name: /build\.log/ })
        expect(file).toHaveAttribute('download', 'build.log')
        expect(file).toHaveTextContent('512 B')
    })

    it('marks files of a deleted conversation as removed', () => {
        render(
            <SentAttachments
                conversationId='c1'
                attachments={[PHOTO, LOG]}
                removed
            />
        )
        expect(screen.queryByRole('img')).not.toBeInTheDocument()
        expect(screen.queryByRole('link')).not.toBeInTheDocument()
        expect(screen.getAllByText('removed')).toHaveLength(2)
    })

    it('marks an image that no longer loads as removed', () => {
        render(
            <SentAttachments
                conversationId='c1'
                attachments={[PHOTO]}
            />
        )
        fireEvent.error(screen.getByRole('img', { name: 'screen shot.png' }))
        expect(screen.queryByRole('img')).not.toBeInTheDocument()
        expect(screen.getByText('screen shot.png')).toBeInTheDocument()
        expect(screen.getByText('removed')).toBeInTheDocument()
    })

    it('renders nothing without files', () => {
        const { container } = render(
            <SentAttachments
                conversationId='c1'
                attachments={null}
            />
        )
        expect(container).toBeEmptyDOMElement()
    })
})

describe('PendingUploads', () => {
    const upload = (overrides: Partial<Upload>): Upload => ({
        key: 'k',
        file: new File(['x'.repeat(3000)], 'notes.txt', { type: 'text/plain' }),
        preview: null,
        status: 'done',
        ...overrides
    })

    it('shows each file with its state and removes one on request', async () => {
        const user = userEvent.setup()
        const onRemove = vi.fn()
        render(
            <PendingUploads
                uploads={[
                    upload({ key: 'a', status: 'uploading' }),
                    upload({ key: 'b', status: 'done' }),
                    upload({
                        key: 'c',
                        status: 'error',
                        error: 'larger than 20 MB',
                        file: new File([''], 'huge.zip')
                    }),
                    upload({ key: 'd', file: new File([''], '', { type: 'image/png' }) })
                ]}
                onRemove={onRemove}
            />
        )
        expect(screen.getByText('uploading…')).toBeInTheDocument()
        expect(screen.getByText('2.9 KB')).toBeInTheDocument()
        expect(screen.getByText('larger than 20 MB')).toBeInTheDocument()
        expect(screen.getByText('pasted image')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Remove huge.zip' }))
        expect(onRemove).toHaveBeenCalledWith('c')
        expect(screen.getByRole('button', { name: 'Remove the pasted image' })).toBeInTheDocument()
    })

    it('renders nothing for no files', () => {
        const { container } = render(
            <PendingUploads
                uploads={[]}
                onRemove={() => {}}
            />
        )
        expect(container).toBeEmptyDOMElement()
    })
})

describe('useUploads', () => {
    const text = (name: string) => new File(['hello'], name, { type: 'text/plain' })

    it('uploads a file at once and names it for the message once it is in', async () => {
        const fetch = mockFetch({
            'POST /api/conversations/c1/attachments': ({ url }: { url: string }) => ({
                ...LOG,
                name: `stamp-${new URL(url, 'http://x').searchParams.get('name')}`
            })
        })
        const { result } = renderHook(() => useUploads('c1'))
        act(() => result.current.add([text('a.txt')]))
        expect(result.current.busy).toBe(true)
        expect(result.current.names).toEqual([])
        await vi.waitFor(() => expect(result.current.busy).toBe(false))
        expect(result.current.names).toEqual(['stamp-a.txt'])
        expect(fetch).toHaveBeenCalledOnce()
    })

    it('keeps a failed upload as an error until removed', async () => {
        mockFetch({ 'POST /api/conversations/c1/attachments': json({ error: 'disk full' }, 507) })
        const { result } = renderHook(() => useUploads('c1'))
        act(() => result.current.add([text('a.txt')]))
        await vi.waitFor(() => expect(result.current.uploads[0].status).toBe('error'))
        expect(result.current.uploads[0].error).toBe('disk full')
        act(() => result.current.remove(result.current.uploads[0].key))
        expect(result.current.uploads).toEqual([])
    })

    it('refuses a file over 20 MB without sending it', () => {
        const fetch = mockFetch({})
        const big = text('big.bin')
        Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 })
        const { result } = renderHook(() => useUploads('c1'))
        act(() => result.current.add([big]))
        expect(result.current.uploads[0]).toMatchObject({ status: 'error', error: 'larger than 20 MB' })
        expect(fetch).not.toHaveBeenCalled()
    })

    it(`holds at most ${MAX_FILES} files`, async () => {
        mockFetch({ 'POST /api/conversations/c1/attachments': LOG })
        const { result } = renderHook(() => useUploads('c1'))
        act(() => result.current.add(Array.from({ length: 8 }, (_, i) => text(`${i}.txt`))))
        act(() => result.current.add(Array.from({ length: 8 }, (_, i) => text(`more-${i}.txt`))))
        expect(result.current.uploads).toHaveLength(MAX_FILES)
        await vi.waitFor(() => expect(result.current.busy).toBe(false))
        act(() => result.current.clear())
        expect(result.current.uploads).toEqual([])
    })
})
