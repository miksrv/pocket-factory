import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 18099)
const baseURL = `http://127.0.0.1:${port}`
const ci = Boolean(process.env.CI)

// The UI against the real, built supervisor (`yarn build` first) with a fake
// `claude` on PATH: see e2e/server.mjs and e2e/fixtures/bin/claude.
export default defineConfig({
    testDir: 'e2e',
    // One supervisor and one SQLite file behind every test: run the files one after another.
    fullyParallel: false,
    workers: 1,
    forbidOnly: ci,
    retries: ci ? 2 : 0,
    timeout: 30_000,
    expect: { timeout: 10_000 },
    reporter: ci ? [['github'], ['html', { open: 'never' }], ['list']] : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
    },
    projects: [
        { name: 'setup', testMatch: /auth\.setup\.ts/ },
        {
            name: 'desktop',
            use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/owner.json' },
            dependencies: ['setup'],
            testIgnore: /auth\.setup\.ts/
        },
        {
            name: 'phone',
            use: { ...devices['Pixel 7'], storageState: 'playwright/.auth/owner.json' },
            dependencies: ['setup'],
            testMatch: /\.mobile\.spec\.ts/
        }
    ],
    webServer: {
        command: 'node e2e/server.mjs',
        url: `${baseURL}/api/auth/me`,
        // Never talk to some other server on the port: a dev instance has another password and data.
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe'
    }
})
