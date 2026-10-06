import { Link, Route, Routes } from 'react-router-dom'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '../test/render'
import { isUnsaved, setUnsaved, useLeaveGuard } from './unsaved'

function Page({ onLeave }: { onLeave: () => void }) {
    const { leave, guard } = useLeaveGuard()
    return (
        <>
            <Link
                to='/other'
                onClick={guard('/other')}
            >
                Other page
            </Link>
            <button
                type='button'
                onClick={() => leave(onLeave)}
            >
                Close editor
            </button>
        </>
    )
}

const renderPage = (onLeave = vi.fn()) =>
    renderWithProviders(
        <Routes>
            <Route
                path='/'
                element={<Page onLeave={onLeave} />}
            />
            <Route
                path='/other'
                element={<h1>Other</h1>}
            />
        </Routes>
    )

describe('unsaved', () => {
    afterEach(() => {
        setUnsaved(false)
    })

    it('keeps one flag', () => {
        expect(isUnsaved()).toBe(false)
        setUnsaved(true)
        expect(isUnsaved()).toBe(true)
        setUnsaved(false)
        expect(isUnsaved()).toBe(false)
    })

    it('lets a clean form go without asking', async () => {
        const user = userEvent.setup()
        const onLeave = vi.fn()
        renderPage(onLeave)
        await user.click(screen.getByRole('button', { name: 'Close editor' }))
        expect(onLeave).toHaveBeenCalledOnce()
        await user.click(screen.getByRole('link', { name: 'Other page' }))
        expect(screen.getByRole('heading', { name: 'Other' })).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('asks before a link drops unsaved edits and stays on Cancel', async () => {
        const user = userEvent.setup()
        setUnsaved(true)
        renderPage()
        await user.click(screen.getByRole('link', { name: 'Other page' }))
        const dialog = screen.getByRole('dialog', { name: 'Discard unsaved changes?' })
        expect(dialog).toHaveAccessibleDescription(/edits that are not saved/)
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Other page' })).toBeInTheDocument()
    })

    it('navigates once the reader agrees to discard', async () => {
        const user = userEvent.setup()
        setUnsaved(true)
        renderPage()
        await user.click(screen.getByRole('link', { name: 'Other page' }))
        await user.click(screen.getByRole('button', { name: 'Discard' }))
        expect(await screen.findByRole('heading', { name: 'Other' })).toBeInTheDocument()
    })

    it('runs a guarded action after the discard', async () => {
        const user = userEvent.setup()
        const onLeave = vi.fn()
        setUnsaved(true)
        renderPage(onLeave)
        await user.click(screen.getByRole('button', { name: 'Close editor' }))
        expect(onLeave).not.toHaveBeenCalled()
        await user.click(screen.getByRole('button', { name: 'Discard' }))
        await vi.waitFor(() => expect(onLeave).toHaveBeenCalledOnce())
    })
})
