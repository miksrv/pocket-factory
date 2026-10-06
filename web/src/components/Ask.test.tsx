import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { AskQuestion } from '../lib/api'
import { json, mockFetch } from '../test/fetch'
import { makeAsk, makeTask } from '../test/fixtures'
import { AskForm, askQuestions } from './Ask'

const BRANCH: AskQuestion = {
    question: 'Which branch?',
    header: 'Branch',
    options: [{ label: 'main', description: 'the default' }, { label: 'develop' }]
}
const CHECKS: AskQuestion = {
    question: 'Which checks?',
    multiSelect: true,
    options: [{ label: 'lint' }, { label: 'tests' }]
}

const questionTask = (questions: AskQuestion[], answers: Record<string, string> = {}) =>
    makeTask({ ask: makeAsk({ input: { questions }, answers }) })

const renderForm = (task = questionTask([BRANCH])) => {
    const onAnswered = vi.fn()
    const fetch = mockFetch({ 'POST /api/tasks/t1/answer': makeTask({ ask: null }) })
    render(
        <AskForm
            task={task}
            onAnswered={onAnswered}
        />
    )
    return { onAnswered, fetch, user: userEvent.setup() }
}

describe('askQuestions', () => {
    it('keeps only well-formed questions', () => {
        const ask = makeAsk({ input: { questions: [BRANCH, null, { header: 'no text' }, 'text', CHECKS] } })
        expect(askQuestions(ask)).toEqual([BRANCH, CHECKS])
    })

    it('is empty for a permission or a malformed input', () => {
        expect(askQuestions(makeAsk({ kind: 'permission', input: { questions: [BRANCH] } }))).toEqual([])
        expect(askQuestions(makeAsk({ input: { questions: 'nope' } }))).toEqual([])
    })
})

describe('AskForm: a question', () => {
    it('sends the picked option', async () => {
        const { user, fetch, onAnswered } = renderForm()
        expect(screen.getByRole('group', { name: /Which branch\?/ })).toBeInTheDocument()
        const submit = screen.getByRole('button', { name: 'Answer' })
        expect(submit).toBeDisabled()
        await user.click(screen.getByRole('radio', { name: 'develop' }))
        expect(submit).toBeEnabled()
        await user.click(submit)
        await vi.waitFor(() => expect(onAnswered).toHaveBeenCalledOnce())
        expect(fetch.requests()[0].body).toEqual({ answers: { 'Which branch?': 'develop' } })
        expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', ask: null }))
    })

    it('picks one radio at a time', async () => {
        const { user } = renderForm()
        await user.click(screen.getByRole('radio', { name: /main/ }))
        await user.click(screen.getByRole('radio', { name: 'develop' }))
        expect(screen.getByRole('radio', { name: /main/ })).not.toBeChecked()
        expect(screen.getByRole('radio', { name: 'develop' })).toBeChecked()
    })

    it('takes a free-text answer on the Other line', async () => {
        const { user, fetch } = renderForm()
        await user.type(screen.getByPlaceholderText('Other…'), 'release/1.2')
        await user.click(screen.getByRole('button', { name: 'Answer' }))
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
        expect(fetch.requests()[0].body).toEqual({ answers: { 'Which branch?': 'release/1.2' } })
    })

    it('does not count an empty Other line as an answer', async () => {
        const { user } = renderForm()
        await user.type(screen.getByPlaceholderText('Other…'), '   ')
        expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled()
    })

    it('joins the boxes of a multi-select with the Other text', async () => {
        const { user, fetch } = renderForm(questionTask([CHECKS]))
        await user.click(screen.getByRole('checkbox', { name: 'lint' }))
        await user.click(screen.getByRole('checkbox', { name: 'tests' }))
        await user.click(screen.getByRole('checkbox', { name: 'lint' }))
        await user.type(screen.getByPlaceholderText('Other…'), 'e2e')
        await user.click(screen.getByRole('button', { name: 'Answer' }))
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
        expect(fetch.requests()[0].body).toEqual({ answers: { 'Which checks?': 'tests, e2e' } })
    })

    it('waits for every open question and sends only those', async () => {
        const { user, fetch } = renderForm(
            questionTask([BRANCH, CHECKS, { question: 'Anything else?' }], { 'Which branch?': 'main' })
        )
        // The answered one is shown as done and is not asked again.
        expect(screen.getByText('✓ main')).toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: 'develop' })).not.toBeInTheDocument()
        expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument()
        await user.click(screen.getByRole('checkbox', { name: 'tests' }))
        expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled()
        await user.type(screen.getByPlaceholderText('Your answer…'), 'no')
        await user.click(screen.getByRole('button', { name: 'Answer' }))
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
        expect(fetch.requests()[0].body).toEqual({ answers: { 'Which checks?': 'tests', 'Anything else?': 'no' } })
    })

    it('shows an error from the API and keeps the form', async () => {
        const user = userEvent.setup()
        mockFetch({ 'POST /api/tasks/t1/answer': json({ error: 'the task is no longer waiting' }, 409) })
        const onAnswered = vi.fn()
        render(
            <AskForm
                task={questionTask([BRANCH])}
                onAnswered={onAnswered}
            />
        )
        await user.click(screen.getByRole('radio', { name: 'develop' }))
        await user.click(screen.getByRole('button', { name: 'Answer' }))
        expect(await screen.findByText('the task is no longer waiting')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Answer' })).toBeEnabled()
        expect(onAnswered).not.toHaveBeenCalled()
    })
})

describe('AskForm: a permission', () => {
    const permissionTask = makeTask({
        ask: makeAsk({ kind: 'permission', tool_name: 'Bash', input: { command: 'rm -rf build' } })
    })

    it('names the tool and its input', () => {
        renderForm(permissionTask)
        expect(screen.getByText('Bash', { selector: 'strong' })).toBeInTheDocument()
        // The command is highlighted, so its text is spread over several elements.
        expect(document.body).toHaveTextContent('rm -rf build')
    })

    it('allows', async () => {
        const { user, fetch, onAnswered } = renderForm(permissionTask)
        await user.click(screen.getByRole('button', { name: 'Allow' }))
        await vi.waitFor(() => expect(onAnswered).toHaveBeenCalledOnce())
        expect(fetch.requests()[0].body).toEqual({ behavior: 'allow' })
    })

    it('denies', async () => {
        const { user, fetch } = renderForm(permissionTask)
        await user.click(screen.getByRole('button', { name: 'Deny' }))
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
        expect(fetch.requests()[0].body).toEqual({ behavior: 'deny' })
    })
})
