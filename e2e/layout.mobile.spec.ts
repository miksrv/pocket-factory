import { type Page } from '@playwright/test'

import { expect, test } from './fixtures'

const noHorizontalScroll = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test.describe('phone layout', () => {
    for (const path of ['/', '/chat', '/agents', '/settings']) {
        test(`${path} fits the screen width`, async ({ page }) => {
            await page.goto(path)
            await expect(page.getByRole('main')).toBeVisible()
            expect(await noHorizontalScroll(page)).toBe(true)
        })
    }
})
