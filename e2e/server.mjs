// Starts the built supervisor for the end-to-end tests (Playwright's `webServer`):
// a fresh data directory every run, the fake `claude` first on PATH, Telegram off,
// sign-in on. Run `yarn build` first.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = path.join(root, '.e2e', 'data')

fs.rmSync(path.join(root, '.e2e'), { recursive: true, force: true })
for (const dir of ['claude', 'config/projects', 'workspaces', 'db', 'secrets']) {
    fs.mkdirSync(path.join(dataRoot, dir), { recursive: true })
}
// What the image's entrypoint does on every start.
fs.cpSync(path.join(root, 'templates', 'claude'), path.join(dataRoot, 'claude'), { recursive: true })

const env = {
    ...process.env,
    PATH: `${path.join(root, 'e2e', 'fixtures', 'bin')}${path.delimiter}${process.env.PATH}`,
    DATA_ROOT: dataRoot,
    CLAUDE_CONFIG_DIR: path.join(dataRoot, 'claude'),
    WORKSPACES_ROOT: path.join(dataRoot, 'workspaces'),
    WEB_DIST: path.join(root, 'web', 'dist'),
    PRESETS_DIR: path.join(root, 'presets'),
    WEB_HOST: '127.0.0.1',
    WEB_PORT: process.env.E2E_PORT ?? '18099',
    WEB_AUTH_USER: 'owner',
    WEB_AUTH_PASSWORD: 'e2e-secret',
    WEB_ALLOWED_HOSTS: '',
    WEB_TRUST_PROXY: '',
    WEB_PUBLIC_URL: '',
    // Empty values win over a developer's .env (process.loadEnvFile never overrides).
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_ALLOWED_USER_IDS: '',
    GROQ_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_PERMISSION_MODE: 'bypassPermissions',
    TIMEZONE: 'UTC',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn'
}

const child = spawn(process.execPath, [path.join(root, 'supervisor', 'dist', 'index.js')], {
    cwd: root,
    env,
    stdio: 'inherit'
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
