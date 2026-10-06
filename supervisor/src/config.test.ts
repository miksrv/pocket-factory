import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from './config.js'

const VARS = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ALLOWED_USER_IDS',
    'DATA_ROOT',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_MAX_TURNS',
    'CLAUDE_PERMISSION_MODE',
    'CLAUDE_TASK_TIMEOUT_MIN',
    'CLAUDE_AUTO_CONTINUE_HOURS',
    'WORKSPACES_ROOT',
    'WORKSPACES_DIR',
    'GROQ_API_KEY',
    'STT_MODEL',
    'STT_LANGUAGE',
    'WEB_HOST',
    'WEB_PORT',
    'WEB_AUTH_USER',
    'WEB_AUTH_PASSWORD',
    'WEB_ALLOWED_HOSTS',
    'WEB_SESSION_DAYS',
    'WEB_LOGIN_MAX_FAILURES',
    'WEB_LOGIN_LOCK_MIN',
    'WEB_TRUST_PROXY',
    'WEB_PUBLIC_URL',
    'WEB_DIST',
    'PRESETS_DIR',
    'MAX_CONCURRENT_SESSIONS',
    'LOG_LEVEL',
    'TIMEZONE',
    'SCHEDULES_SOFT_STOP',
    'SCHEDULES_LATE_MIN',
    'SCHEDULES_ASK_TIMEOUT_MIN'
]

describe('loadConfig', () => {
    beforeEach(() => {
        // Whatever the developer's shell or .env set must not leak into the defaults.
        for (const name of VARS) vi.stubEnv(name, '')
    })

    it('has defaults for everything', () => {
        const config = loadConfig()
        const data = path.resolve(process.cwd(), 'data')
        expect(config).toEqual({
            telegram: { botToken: undefined, allowedUserIds: new Set() },
            claude: {
                configDir: path.join(data, 'claude'),
                maxTurns: 50,
                permissionMode: 'acceptEdits',
                taskTimeoutMs: 0,
                autoContinueMs: 6 * 3_600_000
            },
            paths: {
                dataRoot: data,
                workspacesRoot: path.join(data, 'workspaces'),
                configRoot: path.join(data, 'config'),
                dbFile: path.join(data, 'db', 'factory.sqlite')
            },
            stt: { groqApiKey: undefined, model: 'whisper-large-v3-turbo', language: undefined },
            web: {
                host: '0.0.0.0',
                port: 8080,
                authUser: 'factory',
                authPassword: undefined,
                allowedHosts: new Set(),
                sessionDays: 30,
                loginMaxFailures: 5,
                loginLockMinutes: 10,
                trustProxy: false,
                publicUrl: null,
                distDir: path.resolve(process.cwd(), 'web', 'dist')
            },
            presetsDir: path.resolve(process.cwd(), 'presets'),
            maxConcurrentSessions: 2,
            logLevel: 'info',
            timezone: 'UTC',
            schedules: { softStop: 0.85, lateMinutes: 5, askTimeoutMs: 120 * 60_000 }
        })
    })

    it('reads the values it is given', () => {
        vi.stubEnv('TELEGRAM_BOT_TOKEN', ' 123:abc ')
        vi.stubEnv('TELEGRAM_ALLOWED_USER_IDS', '42, 7,x,-3,1.5')
        vi.stubEnv('DATA_ROOT', '/srv/data')
        vi.stubEnv('WORKSPACES_DIR', '/home/me/ws')
        vi.stubEnv('CLAUDE_TASK_TIMEOUT_MIN', '30')
        vi.stubEnv('CLAUDE_AUTO_CONTINUE_HOURS', '-2')
        vi.stubEnv('WEB_ALLOWED_HOSTS', 'Factory.LAN, ,box')
        vi.stubEnv('WEB_TRUST_PROXY', 'Yes')
        vi.stubEnv('WEB_PUBLIC_URL', 'https://factory.example.com//')
        vi.stubEnv('WEB_SESSION_DAYS', '0')
        vi.stubEnv('WEB_LOGIN_MAX_FAILURES', '2.9')
        vi.stubEnv('MAX_CONCURRENT_SESSIONS', '0')
        vi.stubEnv('LOG_LEVEL', 'debug')
        vi.stubEnv('TIMEZONE', 'America/Los_Angeles')
        vi.stubEnv('SCHEDULES_LATE_MIN', '-1')
        const config = loadConfig()
        expect(config.telegram).toEqual({ botToken: '123:abc', allowedUserIds: new Set([42, 7]) })
        expect(config.paths).toEqual({
            dataRoot: '/srv/data',
            workspacesRoot: '/home/me/ws',
            configRoot: '/srv/data/config',
            dbFile: '/srv/data/db/factory.sqlite'
        })
        expect(config.claude.configDir).toBe('/srv/data/claude')
        expect(config.claude.taskTimeoutMs).toBe(30 * 60_000)
        expect(config.claude.autoContinueMs).toBe(0)
        expect(config.web.allowedHosts).toEqual(new Set(['factory.lan', 'box']))
        expect(config.web.trustProxy).toBe(true)
        expect(config.web.publicUrl).toBe('https://factory.example.com')
        expect(config.web.sessionDays).toBe(1)
        expect(config.web.loginMaxFailures).toBe(2)
        expect(config.maxConcurrentSessions).toBe(1)
        expect(config.logLevel).toBe('debug')
        expect(config.timezone).toBe('America/Los_Angeles')
        expect(config.schedules.lateMinutes).toBe(0)
    })

    it('prefers WORKSPACES_ROOT over WORKSPACES_DIR', () => {
        vi.stubEnv('WORKSPACES_ROOT', '/data/workspaces')
        vi.stubEnv('WORKSPACES_DIR', '/home/me/ws')
        expect(loadConfig().paths.workspacesRoot).toBe('/data/workspaces')
    })

    it.each(['1', 'true', 'on', 'YES'])('reads WEB_TRUST_PROXY=%s as on', (value) => {
        vi.stubEnv('WEB_TRUST_PROXY', value)
        expect(loadConfig().web.trustProxy).toBe(true)
    })

    it.each(['0', 'false', 'off', 'maybe'])('reads WEB_TRUST_PROXY=%s as off', (value) => {
        vi.stubEnv('WEB_TRUST_PROXY', value)
        expect(loadConfig().web.trustProxy).toBe(false)
    })

    it('wants allowed ids with a bot token', () => {
        vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:abc')
        expect(() => loadConfig()).toThrow('TELEGRAM_ALLOWED_USER_IDS must contain at least one numeric')
        vi.stubEnv('TELEGRAM_ALLOWED_USER_IDS', 'abc,0')
        expect(() => loadConfig()).toThrow('TELEGRAM_ALLOWED_USER_IDS')
    })

    it.each([
        ['LOG_LEVEL', 'verbose', 'LOG_LEVEL must be debug, info, warn or error, got "verbose"'],
        ['LOG_LEVEL', 'INFO', 'LOG_LEVEL must be'],
        ['TIMEZONE', 'Mars/Base', 'TIMEZONE must be an IANA time zone name'],
        ['WEB_PORT', 'eighty', 'WEB_PORT must be a number, got "eighty"'],
        ['CLAUDE_MAX_TURNS', '12abc', 'CLAUDE_MAX_TURNS must be a number'],
        ['MAX_CONCURRENT_SESSIONS', 'Infinity', 'MAX_CONCURRENT_SESSIONS must be a number'],
        ['SCHEDULES_SOFT_STOP', '150', 'SCHEDULES_SOFT_STOP must be between 0 and 1 (or 0 and 100), got "150"'],
        ['SCHEDULES_SOFT_STOP', '-0.5', 'SCHEDULES_SOFT_STOP must be between']
    ])('refuses %s=%s', (name, value, message) => {
        vi.stubEnv(name, value)
        expect(() => loadConfig()).toThrow(message)
    })

    it.each([
        ['0', 0],
        ['0.5', 0.5],
        ['1', 1],
        ['85', 0.85],
        ['100', 1]
    ])('reads SCHEDULES_SOFT_STOP=%s as %d', (value, share) => {
        vi.stubEnv('SCHEDULES_SOFT_STOP', value)
        expect(loadConfig().schedules.softStop).toBeCloseTo(share)
    })
})
