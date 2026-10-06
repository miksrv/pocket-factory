import { useState } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { json, mockFetch } from '../test/fetch'
import {
    Button,
    CloseButton,
    Empty,
    ErrorBox,
    FilterSelect,
    GrowingTextarea,
    Intro,
    Markdown,
    PageHead,
    Stat,
    StatusBadge,
    StopButton,
    Tabs,
    useToast
} from './ui'

describe('Button', () => {
    it('is a plain button by default and runs onClick', async () => {
        const user = userEvent.setup()
        const onClick = vi.fn()
        render(<Button onClick={onClick}>Save</Button>)
        const button = screen.getByRole('button', { name: 'Save' })
        expect(button).toHaveAttribute('type', 'button')
        await user.click(button)
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('carries its variant and size', () => {
        render(
            <>
                <Button variant='primary'>Create</Button>
                <Button
                    variant='danger'
                    size='sm'
                >
                    Delete
                </Button>
            </>
        )
        expect(screen.getByRole('button', { name: 'Create' })).toHaveClass('btn', 'primary')
        expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('btn', 'danger', 'sm')
    })

    it('does not fire while disabled', async () => {
        const user = userEvent.setup()
        const onClick = vi.fn()
        render(
            <Button
                disabled
                onClick={onClick}
            >
                Save
            </Button>
        )
        await user.click(screen.getByRole('button', { name: 'Save' }))
        expect(onClick).not.toHaveBeenCalled()
    })

    it('with `to` is a router link that navigates and still runs onClick', async () => {
        const user = userEvent.setup()
        const onClick = vi.fn()
        render(
            <MemoryRouter>
                <Routes>
                    <Route
                        path='/'
                        element={
                            <Button
                                to='/tasks'
                                onClick={onClick}
                            >
                                All tasks
                            </Button>
                        }
                    />
                    <Route
                        path='/tasks'
                        element={<h1>Tasks</h1>}
                    />
                </Routes>
            </MemoryRouter>
        )
        const link = screen.getByRole('link', { name: 'All tasks' })
        expect(link).toHaveAttribute('href', '/tasks')
        await user.click(link)
        expect(onClick).toHaveBeenCalledOnce()
        expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
    })

    it('with `href` opens another site in a new tab', () => {
        render(<Button href='https://github.com/acme/repo/pull/7'>PR #7</Button>)
        const link = screen.getByRole('link', { name: 'PR #7' })
        expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/pull/7')
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })
})

describe('CloseButton', () => {
    it('is named by what it closes', async () => {
        const user = userEvent.setup()
        const onClick = vi.fn()
        render(
            <CloseButton
                label='Close menu'
                onClick={onClick}
            />
        )
        await user.click(screen.getByRole('button', { name: 'Close menu' }))
        expect(onClick).toHaveBeenCalledOnce()
    })
})

describe('small pieces', () => {
    it('PageHead shows the title, the subtitle and the toolbar', () => {
        render(
            <PageHead
                title='Agents'
                sub='12 files'
            >
                <Button>New agent</Button>
            </PageHead>
        )
        expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeInTheDocument()
        expect(screen.getByText('12 files')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'New agent' })).toBeInTheDocument()
    })

    it('Empty and StatusBadge show their text', () => {
        render(
            <>
                <Empty>No tasks yet</Empty>
                <StatusBadge status='running' />
            </>
        )
        expect(screen.getByText('No tasks yet')).toBeInTheDocument()
        expect(screen.getByText('running')).toBeInTheDocument()
    })

    it('ErrorBox shows an error and nothing without one', () => {
        const { container, rerender } = render(<ErrorBox error={null} />)
        expect(container).toBeEmptyDOMElement()
        rerender(<ErrorBox error='The API is down' />)
        expect(screen.getByText('The API is down')).toBeInTheDocument()
    })

    it('Intro offers its one action', async () => {
        const user = userEvent.setup()
        const onAction = vi.fn()
        render(
            <Intro
                text='No conversation open.'
                action='New chat'
                onAction={onAction}
                note='Or pick one on the left.'
            >
                <label>
                    Project
                    <select>
                        <option>pf</option>
                    </select>
                </label>
            </Intro>
        )
        expect(screen.getByText('No conversation open.')).toBeInTheDocument()
        expect(screen.getByText('Or pick one on the left.')).toBeInTheDocument()
        expect(screen.getByRole('combobox', { name: 'Project' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'New chat' }))
        expect(onAction).toHaveBeenCalledOnce()
    })

    it('Stat shows a figure, as a link when it leads somewhere', () => {
        render(
            <MemoryRouter>
                <Stat
                    label='Running'
                    value={3}
                    sub='of 4'
                />
                <Stat
                    label='Failed today'
                    value={1}
                    to='/tasks?status=failed'
                />
            </MemoryRouter>
        )
        expect(screen.getByText('Running').nextSibling).toHaveTextContent('3')
        expect(screen.getByText('of 4')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Failed today/ })).toHaveAttribute('href', '/tasks?status=failed')
    })

    it('Markdown renders sanitized HTML', () => {
        render(<Markdown source={'**bold** <script>alert(1)</script>'} />)
        expect(screen.getByText('bold').tagName).toBe('STRONG')
        expect(document.querySelector('script')).toBeNull()
    })
})

describe('Tabs', () => {
    function Period() {
        const [value, setValue] = useState<'24h' | '7d'>('24h')
        return (
            <>
                <Tabs
                    items={[
                        { value: '24h', label: 'Day' },
                        { value: '7d', label: 'Week' }
                    ]}
                    value={value}
                    onChange={setValue}
                />
                <p>Showing {value}</p>
            </>
        )
    }

    it('marks the active tab and switches on a click', async () => {
        const user = userEvent.setup()
        render(<Period />)
        expect(screen.getByRole('tablist')).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: 'Day' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'false')
        await user.click(screen.getByRole('tab', { name: 'Week' }))
        expect(screen.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: 'Day' })).toHaveAttribute('aria-selected', 'false')
        expect(screen.getByText('Showing 7d')).toBeInTheDocument()
    })
})

describe('FilterSelect', () => {
    it('offers "all" plus the options and reports a choice', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(
            <FilterSelect
                label='Project'
                all='All projects'
                value=''
                options={['pf', 'site']}
                onChange={onChange}
            />
        )
        const select = screen.getByRole('combobox', { name: 'Project' })
        expect(select).toHaveDisplayValue('All projects')
        expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['All projects', 'pf', 'site'])
        await user.selectOptions(select, 'site')
        expect(onChange).toHaveBeenCalledWith('site')
    })

    it('still shows a value that is not among the options', () => {
        render(
            <FilterSelect
                label='Project'
                all='All projects'
                value='gone'
                options={['pf']}
                onChange={() => {}}
            />
        )
        expect(screen.getByRole('combobox', { name: 'Project' })).toHaveDisplayValue('gone')
    })

    it('can be disabled', () => {
        render(
            <FilterSelect
                label='Agent'
                all='All agents'
                value=''
                options={[]}
                onChange={() => {}}
                disabled
            />
        )
        expect(screen.getByRole('combobox', { name: 'Agent' })).toBeDisabled()
    })
})

describe('GrowingTextarea', () => {
    function Notes() {
        const [value, setValue] = useState('')
        return (
            <GrowingTextarea
                aria-label='Notes'
                value={value}
                onChange={(e) => setValue(e.target.value)}
            />
        )
    }

    it('is a one-row text box that takes typing', async () => {
        const user = userEvent.setup()
        render(<Notes />)
        const box = screen.getByRole('textbox', { name: 'Notes' })
        expect(box).toHaveAttribute('rows', '1')
        await user.type(box, 'first line{Enter}second')
        expect(box).toHaveValue('first line\nsecond')
        expect(box.style.height).toMatch(/px$/)
    })
})

describe('StopButton', () => {
    it('stops the task and reports back', async () => {
        const user = userEvent.setup()
        const fetch = mockFetch({ 'POST /api/tasks/t1/stop': { stopped: true } })
        const onStopped = vi.fn()
        render(
            <StopButton
                taskId='t1'
                onStopped={onStopped}
            />
        )
        await user.click(screen.getByRole('button', { name: 'Stop' }))
        await vi.waitFor(() => expect(onStopped).toHaveBeenCalledOnce())
        expect(fetch.requests()).toEqual([{ method: 'POST', url: '/api/tasks/t1/stop', body: undefined }])
        expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    })

    it('is busy while the request runs', async () => {
        const user = userEvent.setup()
        let answer!: (r: Response) => void
        mockFetch({ 'POST /api/tasks/t1/stop': () => new Promise<Response>((resolve) => (answer = resolve)) })
        render(<StopButton taskId='t1' />)
        await user.click(screen.getByRole('button', { name: 'Stop' }))
        expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeDisabled()
        answer(json({ stopped: true }))
        expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled()
    })

    it('offers a retry with the reason when the stop fails', async () => {
        const user = userEvent.setup()
        mockFetch({ 'POST /api/tasks/t1/stop': json({ error: 'task is not running' }, 409) })
        const onStopped = vi.fn()
        render(
            <StopButton
                taskId='t1'
                onStopped={onStopped}
            />
        )
        await user.click(screen.getByRole('button', { name: 'Stop' }))
        const retry = await screen.findByRole('button', { name: 'Retry stop' })
        expect(retry).toHaveAttribute('title', 'task is not running')
        expect(onStopped).not.toHaveBeenCalled()
    })
})

describe('useToast', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    function Saver() {
        const [toast, show] = useToast()
        return (
            <>
                <button
                    type='button'
                    onClick={() => show('Saved')}
                >
                    Save
                </button>
                {toast}
            </>
        )
    }

    // fireEvent rather than userEvent: Testing Library's async wrapper waits on a real setTimeout,
    // which never fires under Vitest's fake timers.
    it('shows a message and hides it after a moment', () => {
        vi.useFakeTimers()
        render(<Saver />)
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(screen.getByText('Saved')).toBeInTheDocument()
        act(() => {
            vi.advanceTimersByTime(2400)
        })
        expect(screen.getByText('Saved')).toBeInTheDocument()
        act(() => {
            vi.advanceTimersByTime(200)
        })
        expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })
})
