import { expect, test } from './fixtures'

test.describe('routines', () => {
    test('a scripts-only routine runs by hand, offers "Run with all", and saves after a switch', async ({ page }) => {
        const name = `e2e-routine-${Date.now()}`
        const created = await page.request.put(`/api/routines/${name}?create=1`, {
            data: {
                frontmatter: {
                    enabled: false,
                    notify: 'none',
                    triggers: [],
                    steps: [
                        { name: 'hello', run: 'echo hello' },
                        { name: 'list', run: 'printf "a\\nb\\n"', items: true, new_only: true }
                    ]
                },
                body: 'End-to-end routine.'
            }
        })
        expect(created.status()).toBe(201)

        await page.goto(`/routines/${name}`)
        const runNow = page.getByRole('button', { name: 'Run now' })
        await runNow.click()
        await expect(page.getByText(/done — hello: hello/)).toBeVisible()

        // Both items are seen now: the next run finds nothing new and offers them again.
        await runNow.click()
        const all = page.getByRole('button', { name: 'Run with all 2' })
        await expect(all).toBeVisible()
        await all.click()
        await expect(all).toBeHidden()
        await expect(page.getByText(/2 item\(s\) — a; b/).first()).toBeVisible()

        // A switch on the side panel never makes the open form's next save "changed on disk".
        await page.getByRole('button', { name: 'Switch on' }).click()
        await expect(page.getByRole('button', { name: 'Switch off' })).toBeVisible()
        await page.getByRole('textbox', { name: /^Cron/ }).fill('0 8 * * *')
        await page.getByRole('button', { name: 'Save' }).click()
        await expect(page.getByText(/changed on disk/)).toHaveCount(0)
        await expect
            .poll(async () => {
                const file = (await (await page.request.get(`/api/routines/${name}`)).json()) as {
                    frontmatter: { enabled: boolean; triggers: unknown; steps: unknown[] }
                }
                return file.frontmatter
            })
            .toMatchObject({ enabled: true, triggers: [{ schedule: '0 8 * * *' }], steps: [{}, {}] })

        expect((await page.request.delete(`/api/routines/${name}`)).status()).toBe(204)
    })
})
