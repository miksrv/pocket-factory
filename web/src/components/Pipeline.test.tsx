import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch } from '../test/fetch'
import { renderWithProviders } from '../test/render'
import { type RawStep, scriptName, scriptRef, StepsField } from './Pipeline'

const STEPS: RawStep[] = [
    { name: 'Stats', run: 'echo 42' },
    { trac: { query: 'status=new' } },
    { agent: 'orchestrator' }
]

function renderGraph(onChange = vi.fn(), steps = STEPS, routine: string | null = null) {
    renderWithProviders(
        <StepsField
            model={null}
            steps={steps}
            onChange={onChange}
            agents={['geometki']}
            skills={[]}
            routine={routine}
            saved={steps}
            onChanged={vi.fn()}
        />
    )
    return onChange
}

describe('StepsField', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('draws every step as a card, the add card before the agent', () => {
        renderGraph()
        const cards = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
        expect(cards[0]).toContain('Stats')
        expect(cards[1]).toContain('status=new')
        expect(cards[2]).toContain('Add step')
        expect(cards[3]).toContain('orchestrator')
    })

    it('edits a step in a window on a draft: Cancel keeps it, Apply puts it into the form', async () => {
        mockFetch({})
        const onChange = renderGraph()
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /Stats/ }))
        let dialog = await screen.findByRole('dialog')
        await user.clear(within(dialog).getByLabelText(/Command/))
        await user.type(within(dialog).getByLabelText(/Command/), 'echo 43')
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        // A changed draft asks before it is dropped.
        await user.click(await screen.findByRole('button', { name: 'Drop' }))
        expect(onChange).not.toHaveBeenCalled()

        await user.click(screen.getByRole('button', { name: /Stats/ }))
        dialog = await screen.findByRole('dialog')
        await user.clear(within(dialog).getByLabelText(/Command/))
        await user.type(within(dialog).getByLabelText(/Command/), 'echo 43')
        await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
        expect(onChange).toHaveBeenCalledWith([{ name: 'Stats', run: 'echo 43' }, STEPS[1], STEPS[2]])
    })

    it('lets a script and a source continue when they fail', async () => {
        mockFetch({})
        const onChange = renderGraph()
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /Stats/ }))
        let dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('checkbox', { name: 'Continue if it fails' }))
        await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
        expect(onChange).toHaveBeenLastCalledWith([{ ...STEPS[0], continue_on_error: true }, STEPS[1], STEPS[2]])

        await user.click(screen.getByRole('button', { name: /Trac/ }))
        dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('checkbox', { name: 'Continue if it fails' }))
        await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
        expect(onChange).toHaveBeenLastCalledWith([STEPS[0], { ...STEPS[1], continue_on_error: true }, STEPS[2]])
    })

    it('switches a step off', async () => {
        mockFetch({})
        const onChange = renderGraph()
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /Stats/ }))
        const dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('checkbox', { name: 'Step on' }))
        await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
        expect(onChange).toHaveBeenLastCalledWith([{ ...STEPS[0], enabled: false }, STEPS[1], STEPS[2]])
    })

    it('keeps a Trac address as typed and stores it as the site and the query', async () => {
        const onChange = renderGraph(vi.fn(), [{ trac: { url: '' } }, STEPS[2]])
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /no query yet/ }))
        const dialog = await screen.findByRole('dialog')
        const input = within(dialog).getByLabelText(/Query/)
        await user.type(input, 'https://trac.example.com/query?')
        expect(input).toHaveValue('https://trac.example.com/query?')
        await user.type(input, 'status=new')
        await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
        expect(onChange).toHaveBeenCalledWith([
            { trac: { url: 'https://trac.example.com', query: 'status=new' } },
            STEPS[2]
        ])
    })

    it('asks before closing a step window over unsaved script edits', async () => {
        const file = { path: 'scripts/stats.sh', size: 8, text: true, exec: true, updated_at: 't1' }
        mockFetch({
            'GET /api/routines/geo/files': [file],
            'GET /api/routines/geo/files/scripts/stats.sh': { path: file.path, text: 'echo 1\n', updated_at: 't1' }
        })
        const step = { name: 'Stats', run: '"${ROUTINE_DIR}/scripts/stats.sh"' }
        const onChange = renderGraph(vi.fn(), [step, STEPS[2]], 'geo')
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /Stats/ }))
        const dialog = await screen.findByRole('dialog')
        await user.type(await within(dialog).findByLabelText('scripts/stats.sh'), 'x')
        await user.click(within(dialog).getByRole('button', { name: 'Done' }))
        const question = (await screen.findByText('Drop the unsaved edits to the script?')).closest('dialog')!
        await user.click(within(question).getByRole('button', { name: 'Cancel' }))
        expect(onChange).not.toHaveBeenCalled()
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(await screen.findByText('Drop the unsaved edits to the script?')).toBeInTheDocument()
    })

    it('adds a source before the agent and opens it', async () => {
        const onChange = renderGraph()
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /Add step/ }))
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', { name: /GitHub pull requests/ })
        )
        expect(onChange).toHaveBeenCalledWith([STEPS[0], STEPS[1], { 'github-prs': { filter: 'open' } }, STEPS[2]])
    })
})

describe('script helpers', () => {
    it('finds the file a command runs and names a new one', () => {
        expect(scriptRef('"${ROUTINE_DIR}/scripts/gsc.sh" --days 7', 'geo', null)).toEqual({
            kind: 'routines',
            name: 'geo',
            path: 'scripts/gsc.sh'
        })
        expect(scriptRef('${SKILL_DIR}/x.sh', 'geo', null)).toBeNull()
        expect(scriptName('GSC stats', 0, ['scripts/gsc-stats.sh'])).toBe('scripts/gsc-stats-2.sh')
        expect(scriptName('Яндекс Метрика', 2, [])).toBe('scripts/step-3.sh')
    })
})
