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
    `,
    // v2: the subscription is metered in tokens and rolling windows, not money.
    `
    ALTER TABLE tasks ADD COLUMN cache_read_tokens     INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN window_5h_delta       REAL;   -- share of the 5-hour window this task consumed (0..1), null if unknown

    -- Rate-limit status as reported by the CLI after API calls (one row per change).
    CREATE TABLE rate_limits (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                  TEXT NOT NULL,
        task_id             TEXT,                   -- null for a manual probe
        status              TEXT NOT NULL,          -- allowed | allowed_warning | rejected
        five_hour_used      REAL,                   -- 0..1
        five_hour_resets_at TEXT,
        seven_day_used      REAL,                   -- 0..1
        seven_day_resets_at TEXT
    );
    CREATE INDEX rate_limits_ts ON rate_limits(ts);
    `,
    // v3: audit log — events know which agent produced them and tasks know
    // their project.
    `
    ALTER TABLE task_events ADD COLUMN agent TEXT;               -- sub-agent type, null = orchestrator
    ALTER TABLE task_events ADD COLUMN parent_tool_use_id TEXT;  -- Agent tool call that spawned the sub-agent
    ALTER TABLE tasks ADD COLUMN project TEXT;                   -- workspace the task worked in
    CREATE INDEX task_events_ts ON task_events(ts);
    CREATE INDEX task_events_type ON task_events(type, ts);
    `,
    // v4: conversations can be removed from the Chat list. Their tasks, events
    // and transcripts stay: the audit log is the record.
    `
    ALTER TABLE conversations ADD COLUMN deleted_at TEXT;
    `,
    // v5: small facts the CLI tells us at runtime (its tool list, …).
    `
    CREATE TABLE meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,               -- JSON
        updated_at TEXT NOT NULL
    );
    `,
    // v6: a task interrupted by a supervisor restart goes back to the queue and
    // resumes its session; the counter bounds how often (a task that keeps
    // crashing the supervisor must not loop).
    `
    ALTER TABLE tasks ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0;
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
