import fs from 'node:fs'
import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/** The supervisor's port from the root `.env` (`WEB_PORT`), so the dev proxy follows the owner's container. */
function supervisorPort(): number {
    try {
        const env = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8')
        const m = /^WEB_PORT=(\d+)\s*$/m.exec(env)
        if (m) return Number(m[1])
    } catch {
        // no .env: the default below
    }
    return 8080
}

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: { '/api': { target: `http://localhost:${supervisorPort()}`, changeOrigin: true } }
    },
    build: { outDir: 'dist', emptyOutDir: true },
    test: {
        name: 'web',
        environment: 'jsdom',
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['src/test/setup.ts'],
        restoreMocks: true,
        unstubGlobals: true
    }
})
