import { expect, test } from './fixtures'
import { startChat, unique } from './helpers'

test.describe('chat', () => {
    test('a message becomes a task and the agent replies', async ({ page }) => {
        const prompt = unique('hello from playwright')
        await startChat(page, prompt)

        await expect(page.getByText(`Echo: ${prompt}`)).toBeVisible()
        await expect(page.getByText('done', { exact: true })).toBeVisible()
        // The conversation is listed under its first message.
        await expect(page.getByRole('link', { name: new RegExp(prompt) })).toBeVisible()
        // The composer is empty again and ready for the next message.
        await expect(page.getByRole('textbox', { name: 'Describe the task…' })).toHaveValue('')
    })

    test('the task page shows the prompt and the result', async ({ page }) => {
        const prompt = unique('open the task page')
        await startChat(page, prompt)
        await expect(page.getByText(`Echo: ${prompt}`)).toBeVisible()

        await page.getByRole('link', { name: 'Task', exact: true }).click()
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/)
        await expect(page.getByText(`Echo: ${prompt}`).first()).toBeVisible()
    })

    test('the agent asks a question and the answer continues the task', async ({ page }) => {
        await startChat(page, 'please ask me something')

        const question = page.getByRole('group', { name: /Which colour\?/ })
        await expect(question).toBeVisible()
        await expect(page.getByRole('textbox', { name: 'Type your answer to the question above…' })).toBeVisible()

        const answer = page.getByRole('button', { name: 'Answer' })
        await expect(answer).toBeDisabled()
        await question.getByRole('radio', { name: /Blue/ }).check()
        await answer.click()

        await expect(page.getByText('You chose: Blue')).toBeVisible()
        await expect(question).toBeHidden()
    })

    test('a failed run is reported as failed', async ({ page }) => {
        await startChat(page, 'this one should fail')
        await expect(page.getByText('failed', { exact: true })).toBeVisible()
    })

    test('a draft survives leaving the thread', async ({ page }) => {
        await startChat(page, 'first message')
        await expect(page.getByText('Echo: first message')).toBeVisible()
        const thread = page.url()

        await page.getByRole('textbox', { name: 'Describe the task…' }).fill('unsent words')
        await page.getByRole('navigation').getByRole('link', { name: 'Overview' }).click()
        await page.goto(thread)
        await expect(page.getByRole('textbox', { name: 'Describe the task…' })).toHaveValue('unsent words')
    })

    test('a conversation is deleted after confirmation', async ({ page }) => {
        const prompt = unique('delete me please')
        await startChat(page, prompt)
        await expect(page.getByText(`Echo: ${prompt}`)).toBeVisible()

        await page.getByRole('button', { name: 'Delete' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        // A destructive question starts on Cancel.
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
        await dialog.getByRole('button', { name: /^Delete/ }).click()

        await expect(page).toHaveURL(/\/chat$/)
        await expect(page.getByRole('link', { name: new RegExp(prompt) })).toHaveCount(0)
    })
})
