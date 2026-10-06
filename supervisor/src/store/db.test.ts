import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from './db.js'

describe('openDatabase', () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-db-'))
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('creates the file and applies every migration', () => {
        const db = openDatabase(path.join(dir, 'nested', 'factory.sqlite'))
        const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(user_version).toBeGreaterThan(0)
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string
        }>
        expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['conversations', 'tasks', 'task_events']))
        db.close()
    })

    it('is idempotent: reopening keeps the schema version', () => {
        const file = path.join(dir, 'factory.sqlite')
        const first = openDatabase(file)
        const { user_version: v1 } = first.prepare('PRAGMA user_version').get() as { user_version: number }
        first.close()
        const second = openDatabase(file)
        const { user_version: v2 } = second.prepare('PRAGMA user_version').get() as { user_version: number }
        second.close()
        expect(v2).toBe(v1)
    })
})
