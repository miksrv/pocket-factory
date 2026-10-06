import { defineConfig } from 'vitest/config'

// One runner for both workspaces: `yarn test` at the root runs every project,
// `yarn workspace <name> test` runs one.
export default defineConfig({
    test: {
        projects: ['supervisor', 'web'],
        coverage: {
            provider: 'v8',
            include: ['supervisor/src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
            exclude: ['**/*.test.{ts,tsx}', '**/test/**', 'supervisor/src/index.ts', 'web/src/main.tsx'],
            reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
            // A ratchet, not a goal: a bit under today's numbers (pages and the bot are covered by
            // the Playwright suite instead). Raise them as tests are added, never lower them.
            thresholds: { lines: 35, statements: 35, functions: 30, branches: 27 }
        }
    }
})
