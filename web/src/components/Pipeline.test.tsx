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

function renderGraph(onChange = vi.fn(), steps = STEPS) {
    renderWithProviders(
        <StepsField
            model={null}
            steps={steps}
            onChange={onChange}
            agents={['geometki']}
            skills={[]}
            routine={null}
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
