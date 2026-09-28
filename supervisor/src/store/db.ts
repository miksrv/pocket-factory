import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createLogger } from '../logger.js'

const log = createLogger('db')

/**
 * Schema migrations, applied in order. Each entry runs once; the version is
 * tracked in `user_version` so upgrades are a matter of appending here.
 */
const MIGRATIONS: string[] = [
    `
    CREATE TABLE conversations (
        id          TEXT PRIMARY KEY,
        channel     TEXT NOT NULL,              -- telegram | web
        external_id TEXT,                       -- telegram chat id, null for web
        title       TEXT,
        session_id  TEXT,                       -- Claude Code session for --resume
        project     TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE INDEX conversations_channel ON conversations(channel, external_id);

    CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        source          TEXT NOT NULL,          -- telegram | web | cron | webhook
        prompt          TEXT NOT NULL,
        status          TEXT NOT NULL,          -- queued | running | done | failed | cancelled
        session_id      TEXT,
        result          TEXT,
        error           TEXT,
        num_turns       INTEGER NOT NULL DEFAULT 0,
        cost_usd        REAL    NOT NULL DEFAULT 0,
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        started_at      TEXT,
        finished_at     TEXT
    );
    CREATE INDEX tasks_conversation ON tasks(conversation_id, created_at);
    CREATE INDEX tasks_status ON tasks(status);

    CREATE TABLE task_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        ts      TEXT NOT NULL,
        type    TEXT NOT NULL,                  -- text | tool_use | tool_result | status | error
        payload TEXT NOT NULL                   -- JSON
    );
    CREATE INDEX task_events_task ON task_events(task_id, id);
    `
]

export function openDatabase(file: string): DatabaseSync {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')

    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    let version = row.user_version
    for (let i = version; i < MIGRATIONS.length; i++) {
        log.info(`applying migration ${i + 1}/${MIGRATIONS.length}`)
        db.exec('BEGIN')
        try {
            db.exec(MIGRATIONS[i])
            db.exec(`PRAGMA user_version = ${i + 1}`)
            db.exec('COMMIT')
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
        version = i + 1
    }
    log.info(`open ${file} (schema v${version})`)
    return db
}
