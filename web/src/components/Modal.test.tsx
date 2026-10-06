import { useState } from 'react'
import { render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { type ConfirmOptions, ConfirmProvider, Modal, useConfirm } from './Modal'

/** A page with one button that asks `options` and prints the answer. */
function Asker({ options }: { options: ConfirmOptions }) {
    const confirm = useConfirm()
    const [answer, setAnswer] = useState('none')
    return (
        <>
            <button
                type='button'
                onClick={() => void confirm(options).then((ok) => setAnswer(String(ok)))}
            >
                Ask
            </button>
            <output aria-label='answer'>{answer}</output>
        </>
    )
}

const ask = async (options: ConfirmOptions) => {
    const user = userEvent.setup()
    render(
        <ConfirmProvider>
            <Asker options={options} />
        </ConfirmProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    return user
}

const answer = () => screen.getByRole('status', { name: 'answer' })

/** A promise the test settles by hand. */
function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('useConfirm', () => {
    it('asks the question and resolves true on the action', async () => {
        const user = await ask({ title: 'Install the preset?', message: 'Adds 3 agents.', action: 'Install' })
        const dialog = screen.getByRole('dialog', { name: 'Install the preset?' })
        expect(dialog).toHaveAccessibleDescription('Adds 3 agents.')
        // A harmless question: the action takes the focus.
        expect(screen.getByRole('button', { name: 'Install' })).toHaveFocus()
        await user.click(screen.getByRole('button', { name: 'Install' }))
        expect(answer()).toHaveTextContent('true')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('resolves false on Cancel', async () => {
        const user = await ask({ title: 'Install the preset?', action: 'Install', cancel: 'Not now' })
        await user.click(screen.getByRole('button', { name: 'Not now' }))
        expect(answer()).toHaveTextContent('false')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('focuses Cancel first on a destructive question', async () => {
        await ask({ title: 'Delete agent?', action: 'Delete', danger: true })
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
        expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('danger')
    })

    it('closes with "no" on Escape', async () => {
        const user = await ask({ title: 'Delete agent?', action: 'Delete', danger: true })
        await user.keyboard('{Escape}')
        expect(answer()).toHaveTextContent('false')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('keeps the window open and busy while the action runs, then closes', async () => {
        const job = deferred()
        const user = await ask({
            title: 'Delete agent?',
            action: 'Delete',
            pending: 'Deleting…',
            danger: true,
            onConfirm: () => job.promise
        })
        await user.click(screen.getByRole('button', { name: 'Delete' }))
        expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
        expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
        // Escape cannot dismiss a window whose action is in flight.
        await user.keyboard('{Escape}')
        expect(screen.getByRole('dialog', { name: 'Delete agent?' })).toBeInTheDocument()
        expect(answer()).toHaveTextContent('none')
        job.resolve()
        await vi.waitFor(() => expect(answer()).toHaveTextContent('true'))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('names the busy action after the verb when no pending label is given', async () => {
        const job = deferred()
        const user = await ask({ title: 'Reinstall?', action: 'Reinstall', onConfirm: () => job.promise })
        await user.click(screen.getByRole('button', { name: 'Reinstall' }))
        expect(screen.getByRole('button', { name: 'Reinstall…' })).toBeDisabled()
        job.resolve()
        await vi.waitFor(() => expect(answer()).toHaveTextContent('true'))
    })

    it('shows a failed action inline and lets the reader retry or cancel', async () => {
        const onConfirm = vi.fn().mockRejectedValueOnce(new Error('File is locked')).mockResolvedValueOnce(undefined)
        const user = await ask({ title: 'Delete agent?', action: 'Delete', danger: true, onConfirm })
        await user.click(screen.getByRole('button', { name: 'Delete' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('File is locked')
        expect(screen.getByRole('dialog', { name: 'Delete agent?' })).toBeInTheDocument()
        expect(answer()).toHaveTextContent('none')
        await user.click(screen.getByRole('button', { name: 'Delete' }))
        await vi.waitFor(() => expect(answer()).toHaveTextContent('true'))
        expect(onConfirm).toHaveBeenCalledTimes(2)
    })

    it('resolves false when the reader cancels after a failure', async () => {
        const user = await ask({
            title: 'Delete agent?',
            action: 'Delete',
            onConfirm: () => Promise.reject(new Error('nope'))
        })
        await user.click(screen.getByRole('button', { name: 'Delete' }))
        await screen.findByRole('alert')
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(answer()).toHaveTextContent('false')
    })

    it('answers an earlier question "no" when a new one is asked over it', async () => {
        const user = userEvent.setup()
        const answers: boolean[] = []
        function Twice() {
            const confirm = useConfirm()
            return (
                <button
                    type='button'
                    onClick={() => {
                        void confirm({ title: 'First?' }).then((ok) => answers.push(ok))
                        void confirm({ title: 'Second?', action: 'Yes, second' }).then((ok) => answers.push(ok))
                    }}
                >
                    Ask twice
                </button>
            )
        }
        render(
            <ConfirmProvider>
                <Twice />
            </ConfirmProvider>
        )
        await user.click(screen.getByRole('button', { name: 'Ask twice' }))
        expect(screen.getByRole('dialog', { name: 'Second?' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Yes, second' }))
        await vi.waitFor(() => expect(answers).toEqual([false, true]))
    })

    it('needs a ConfirmProvider', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(() => renderHook(() => useConfirm())).toThrow(/ConfirmProvider/)
    })
})

describe('Modal', () => {
    const renderModal = (props: Partial<Parameters<typeof Modal>[0]> = {}) => {
        const onClose = vi.fn()
        const result = render(
            <Modal
                open
                onClose={onClose}
                title='Add host'
                {...props}
            >
                <label>
                    Name
                    <input />
                </label>
            </Modal>
        )
        return { onClose, ...result }
    }

    it('shows its title and content and closes from the ×', async () => {
        const user = userEvent.setup()
        const { onClose } = renderModal()
        expect(screen.getByRole('dialog', { name: 'Add host' })).toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Close' }))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('closes on a click on the backdrop but not inside the window', async () => {
        const user = userEvent.setup()
        const { onClose } = renderModal()
        await user.click(screen.getByRole('textbox', { name: 'Name' }))
        expect(onClose).not.toHaveBeenCalled()
        await user.click(screen.getByRole('dialog'))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('cannot be dismissed while busy', async () => {
        const user = userEvent.setup()
        const { onClose } = renderModal({ busy: true })
        expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
        await user.keyboard('{Escape}')
        await user.click(screen.getByRole('dialog'))
        expect(onClose).not.toHaveBeenCalled()
    })

    it('opens and closes with its prop', () => {
        const { rerender, onClose } = renderModal({ open: false })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        rerender(
            <Modal
                open
                onClose={onClose}
                title='Add host'
            />
        )
        expect(screen.getByRole('dialog', { name: 'Add host' })).toBeInTheDocument()
        rerender(
            <Modal
                open={false}
                onClose={onClose}
                title='Add host'
            />
        )
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()
    })
})
