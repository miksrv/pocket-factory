import { expect, type Page } from '@playwright/test'

/** The credentials e2e/server.mjs starts the supervisor with. */
export const OWNER = { user: 'owner', password: 'e2e-secret' }

export async function signIn(page: Page, user: string, password: string): Promise<void> {
    await page.getByRole('textbox', { name: 'Username' }).fill(user)
    // The label also holds the "Show password" toggle, so the field is found by name.
    await page.locator('input[name="password"]').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
}

/** Opens a fresh conversation and sends one message from the composer. */
export async function startChat(page: Page, prompt: string): Promise<void> {
    await page.goto('/chat/new')
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
    const composer = page.getByRole('textbox', { name: 'Describe the task…' })
    await composer.fill(prompt)
    await composer.press('Enter')
}

/** A string no earlier run has used: a reused dev server keeps the conversations of the last run. */
export const unique = (text: string) => `${text} ${Date.now().toString(36)}`
