import { expect, test } from './fixtures'
import { OWNER, signIn } from './helpers'

// Every test here starts signed out, with a browser of its own.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('sign-in', () => {
    test('shows the sign-in page instead of the app', async ({ page }) => {
        await page.goto('/agents')
        await expect(page.getByText('Sign in to your factory.')).toBeVisible()
        await expect(page.getByRole('navigation')).toBeHidden()
    })

    test('keeps the button disabled until both fields are filled', async ({ page }) => {
        await page.goto('/')
        const submit = page.getByRole('button', { name: 'Sign in' })
        await expect(submit).toBeDisabled()
        await page.getByRole('textbox', { name: 'Username' }).fill(OWNER.user)
        await expect(submit).toBeDisabled()
        await page.locator('input[name="password"]').fill('x')
        await expect(submit).toBeEnabled()
    })

    test('refuses a wrong password', async ({ page }) => {
        await page.goto('/')
        await signIn(page, OWNER.user, 'not-the-password')
        await expect(page.getByRole('alert')).toBeVisible()
        await expect(page.locator('input[name="password"]')).toHaveAttribute('aria-invalid', 'true')
        await expect(page.getByRole('navigation')).toBeHidden()
    })

    test('the eye button reveals the password', async ({ page }) => {
        await page.goto('/')
        const password = page.locator('input[name="password"]')
        await password.fill('secret')
        await expect(password).toHaveAttribute('type', 'password')
        await page.getByRole('button', { name: 'Show password' }).click()
        await expect(password).toHaveAttribute('type', 'text')
    })

    test('signs in, lands on the page asked for, and signs out', async ({ page }) => {
        await page.goto('/skills')
        await signIn(page, OWNER.user, OWNER.password)
        await expect(page.getByRole('heading', { name: 'Skills', level: 1 })).toBeVisible()

        await page.getByRole('button', { name: 'Sign out' }).click()
        await expect(page.getByText('Sign in to your factory.')).toBeVisible()
        // The session is gone on the server too, not only in this tab.
        const me = await page.request.get('/api/auth/me')
        expect(await me.json()).toMatchObject({ authenticated: false })
    })
})
