import { expect, test } from './fixtures'

const PAGES = [
    { link: 'Overview', heading: 'Overview' },
    { link: 'Tasks', heading: 'Tasks' },
    { link: 'Sessions', heading: 'Sessions' },
    { link: 'Audit log', heading: 'Audit log' },
    { link: 'Agents', heading: 'Agents' },
    { link: 'Skills', heading: 'Skills' },
    { link: 'Projects', heading: 'Projects' },
    { link: 'Schedules', heading: 'Schedules' },
    { link: 'Presets', heading: 'Presets' },
    { link: 'Settings', heading: 'Settings' }
]

test.describe('navigation', () => {
    test('every sidebar item opens its page', async ({ page }) => {
        await page.goto('/')
        const sidebar = page.getByRole('navigation')
        for (const { link, heading } of PAGES) {
            // A menu item may carry a count badge after its label ("Tasks 3").
            await sidebar.getByRole('link', { name: new RegExp(`^${link}(\\s|$)`) }).click()
            await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
        }
    })

    test('the sidebar marks the current page', async ({ page }) => {
        await page.goto('/projects')
        await expect(page.getByRole('navigation').getByRole('link', { name: 'Projects' })).toHaveAttribute(
            'aria-current',
            'page'
        )
    })

    test('an unknown address falls back to the overview', async ({ page }) => {
        await page.goto('/no/such/page')
        await expect(page).toHaveURL('/')
        await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
    })

    test('the footer shows the factory and CLI versions', async ({ page }) => {
        await page.goto('/')
        await expect(
            page.getByRole('complementary').getByText(/v\d+\.\d+\.\d+ · 2\.1\.283 \(Claude Code\)/)
        ).toBeVisible()
    })
})
