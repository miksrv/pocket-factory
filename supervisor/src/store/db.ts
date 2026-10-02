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
    `,
    // v7: when the owner last looked at a conversation in the web UI. A web
    // task that finished later is "unread" (Chat list, sidebar badge). Existing
    // rows count as read: nothing lights up on the upgrade.
    `
    ALTER TABLE conversations ADD COLUMN read_at TEXT;
    UPDATE conversations SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
    `,
    // v8: what a running task waits for from the owner — an AskUserQuestion
    // call or a permission request the CLI routed to the supervisor (JSON,
    // see `Ask`); null while nothing is pending.
    `
    ALTER TABLE tasks ADD COLUMN ask TEXT;
    `,
    // v9: schedules (Phase 5). A schedule is a Markdown file in
    // data/config/schedules; the store keeps what a file cannot: each firing
    // (skipped, empty, queued, error) and the prefilter items already handed
    // to the agent, so an empty poll costs no tokens and a ticket is not
    // brought up twice. A task remembers the schedule that queued it.
    `
    ALTER TABLE tasks ADD COLUMN schedule TEXT;
    CREATE INDEX tasks_schedule ON tasks(schedule, created_at);

    CREATE TABLE schedule_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule    TEXT NOT NULL,
        fired_at    TEXT NOT NULL,
        trigger     TEXT NOT NULL,                -- cron | manual
        status      TEXT NOT NULL,                -- queued | empty | skipped | error
        note        TEXT,                         -- why skipped, the error, or what was found
        items       INTEGER NOT NULL DEFAULT 0,   -- new prefilter items handed to the task
        task_id     TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0    -- the prefilter's time
    );
    CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule, id);

    CREATE TABLE seen_items (
        schedule   TEXT NOT NULL,
        key        TEXT NOT NULL,                 -- the prefilter's key (ticket id + change time, PR + head sha, …)
        title      TEXT,
        first_seen TEXT NOT NULL,
        task_id    TEXT,                          -- the task that got the item; null when the first run seeded it
        PRIMARY KEY (schedule, key)
    );
    `,
    // v10: Telegram topics. A Telegram chat talks to one conversation at a
    // time (its topic): its own by default, or any conversation the owner
    // switched to by replying to a message of the bot — a schedule's report,
    // a question. The bot remembers which conversation (and task) each
    // message it sent belongs to, so a reply can be resolved.
    `
    CREATE TABLE telegram_chats (
        chat_id         INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        updated_at      TEXT NOT NULL
    );
    CREATE TABLE telegram_messages (
        chat_id         INTEGER NOT NULL,
        message_id      INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        task_id         TEXT,
        sent_at         TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX telegram_messages_sent ON telegram_messages(sent_at);
    `,
    // v11: the model a task was queued with (a schedule's `model:`); null =
    // the factory's current model, kept in `meta` (`claude.model`) since the
    // owner picks it from Telegram or Settings, not from .env.
    `ALTER TABLE tasks ADD COLUMN model TEXT`,
    // v12: the web UI's own sign-in. A session row per browser (the cookie
    // holds a random token, the row its SHA-256), and every sign-in attempt,
    // which is what the lockout counts and Settings → Security shows.
    `
    CREATE TABLE web_sessions (
        id           TEXT PRIMARY KEY,           -- sha256 of the cookie token
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        ip           TEXT,
        user_agent   TEXT
    );
    CREATE INDEX web_sessions_expires ON web_sessions(expires_at);

    CREATE TABLE login_attempts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        ip         TEXT NOT NULL,
        username   TEXT,
        result     TEXT NOT NULL,                -- ok | failed | locked
        user_agent TEXT
    );
    CREATE INDEX login_attempts_ts ON login_attempts(ts);
    CREATE INDEX login_attempts_ip ON login_attempts(ip, ts);
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
