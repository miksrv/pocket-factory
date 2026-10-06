import { expect, test as setup } from './fixtures'
import { OWNER, signIn } from './helpers'

// Signs in once through the real form and keeps the session cookie for every other test.
setup('sign in as the owner', async ({ page }) => {
    await page.goto('/')
    await signIn(page, OWNER.user, OWNER.password)
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
    await page.context().storageState({ path: 'playwright/.auth/owner.json' })
})
