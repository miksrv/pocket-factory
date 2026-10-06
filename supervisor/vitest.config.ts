import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        name: 'supervisor',
        environment: 'node',
        include: ['src/**/*.test.ts'],
        setupFiles: ['src/test/setup.ts'],
        // Tests touch real temp directories and SQLite files: keep each file in its own process.
        pool: 'forks',
        restoreMocks: true,
        unstubEnvs: true
    }
})
