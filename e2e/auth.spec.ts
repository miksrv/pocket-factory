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

    // The button stays enabled with empty fields (a password manager may fill them without
    // React noticing; Enter submits only through an enabled button); an empty submit sends nothing.
    test('an empty or half-filled form does not submit', async ({ page }) => {
        await page.goto('/')
        const logins: string[] = []
        page.on('request', (r) => {
            if (r.url().endsWith('/api/auth/login')) logins.push(r.method())
        })
        const submit = page.getByRole('button', { name: 'Sign in' })
        await expect(submit).toBeEnabled()
        await submit.click()
        await page.getByRole('textbox', { name: 'Username' }).fill(OWNER.user)
        await submit.click()
        await expect(page.getByText('Sign in to your factory.')).toBeVisible()
        expect(logins).toEqual([])
        await page.locator('input[name="password"]').fill(OWNER.password)
        await submit.click()
        await expect(page.getByRole('navigation')).toBeVisible()
        expect(logins).toEqual(['POST'])
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
