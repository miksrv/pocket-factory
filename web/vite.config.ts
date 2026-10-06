import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } }
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
