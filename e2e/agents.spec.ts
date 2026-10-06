import { expect, test } from './fixtures'

test.describe('agents editor', () => {
    test('creates an agent file and deletes it', async ({ page }) => {
        const name = `e2e-agent-${Date.now()}`

        await page.goto('/agents')
        await page.getByRole('button', { name: 'New agent' }).click()
        await expect(page).toHaveURL(/\/agents\/new$/)

        const save = page.getByRole('button', { name: 'Save' })
        await expect(save).toBeDisabled()
        await page.getByRole('textbox', { name: /^Name/ }).fill(name)
        await page.getByRole('textbox', { name: /^Description/ }).fill('Checks things in end-to-end tests.')
        await save.click()

        await expect(page).toHaveURL(new RegExp(`/agents/${name}$`))
        await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible()

        // The file is on disk: the API reads it back.
        const saved = await page.request.get(`/api/agents/${name}`)
        expect(saved.ok()).toBe(true)
        expect(await saved.json()).toMatchObject({ name })

        await page.getByRole('button', { name: 'Delete' }).click()
        await page
            .getByRole('dialog')
            .getByRole('button', { name: /^Delete/ })
            .click()
        await expect(page).toHaveURL(/\/agents$/)
        await expect(page.getByRole('dialog')).toBeHidden()
        await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0)
        expect((await page.request.get(`/api/agents/${name}`)).status()).toBe(404)
    })

    test('warns before leaving unsaved edits', async ({ page }) => {
        await page.goto('/agents/new')
        await page.getByRole('textbox', { name: /^Name/ }).fill('never-saved')
        await page.getByRole('navigation').getByRole('link', { name: 'Skills' }).click()

        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(page).toHaveURL(/\/agents\/new$/)
        await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('never-saved')
    })
})
