import { expect, test as base } from '@playwright/test'

/**
 * The project's `test`: every page is hermetic. Requests that leave the
 * factory (Google Fonts in index.html) are aborted, so a slow or offline
 * network can never hold the load event, and an uncaught page error fails
 * the test that caused it.
 */
export const test = base.extend<{ hermetic: void }>({
    hermetic: [
        async ({ context, baseURL }, use) => {
            const own = new URL(baseURL!).origin
            await context.route(
                (url) => url.origin !== own,
                (route) => route.abort()
            )
            await use()
        },
        { auto: true }
    ],
    page: async ({ page }, use) => {
        const errors: Error[] = []
        page.on('pageerror', (error) => errors.push(error))
        await use(page)
        expect(errors, 'uncaught errors in the page').toEqual([])
    }
})

export { expect }
