# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Pocket Factory is a **self-hosted layer over Claude Code for developers**: the **unmodified Claude
Code CLI** running in a Docker container on the owner's own server, driven from Telegram and a
small web control plane. The tagline is the product: *an agent becomes truly autonomous the moment
you close your laptop lid*. Four things it adds on top of the CLI, in this order of importance:

1. **Autonomy** — tasks arrive from Telegram (text, voice) or the browser, queue, run as `claude -p`
   sessions in the owner's real checkouts, continue across messages, survive restarts.
2. **Control over what agents do** — the Audit log (every model call, tool call, file edit,
   sub-agent, per agent and project), rendered transcripts, tokens and subscription windows.
3. **Management** — agents, skills and projects as Markdown files edited in the UI or by the agent;
   presets; live model and tool lists.
4. **Pipelines** — skills chaining sub-agents into repeatable flows; schedules and pollers next.

Full concept, decisions and roadmap: `docs/SPEC.md` (read it first; §4.4 session lifecycle and §8
security are the load-bearing parts).

Owner: Misha Topchilo. Single-owner tool; a fork uses the forker's own subscription and bot.

## Commands

```bash
yarn install                 # Yarn 4 workspaces (corepack)
yarn typecheck               # tsc --noEmit for all workspaces
yarn build                   # supervisor → supervisor/dist, web → web/dist
yarn dev                     # supervisor + API on :8080 on the host (reads .env itself, CLAUDE_CONFIG_DIR=data/claude)
TELEGRAM_BOT_TOKEN= yarn dev # web-only: use this while the container runs, or Telegram answers 409 to both pollers
yarn dev:web                 # Vite dev server on :5173 proxying /api → :8080
docker compose up -d --build # build image + (re)start the supervisor container
docker compose logs -f supervisor
docker compose run --rm supervisor claude -p "Reply with exactly: OK" --model haiku --max-turns 1   # auth smoke test
node scripts/release.mjs bump 1.2.0   # new version: package.json ×3 + a CHANGELOG.md section to fill in
node scripts/release.mjs tag          # after the merge, on a clean main in sync with origin: tag vX.Y.Z + GitHub release
```

Checks (2026-10-06, all run in CI, `.github/workflows/ci.yml`; `yarn check` runs the first four locally):

```bash
yarn format:check / yarn format   # Prettier (.prettierrc: 4 spaces, single quotes, no semis, no trailing commas, 120 cols)
yarn lint / yarn lint:fix         # ESLint 10 flat config (eslint.config.mjs): typescript-eslint type-checked, react-hooks, import sort
yarn typecheck                    # both workspaces + the root tsconfig (config files, e2e/)
yarn test / yarn test:coverage    # Vitest projects: supervisor (node) + web (jsdom, Testing Library); coverage thresholds are a ratchet
yarn build && yarn test:e2e       # Playwright against the built supervisor on :18099 with a fake `claude` (e2e/fixtures/bin/claude)
```

Unit tests sit next to the module (`foo.ts` → `foo.test.ts`); helpers in `supervisor/src/test/`
(`createTestApp()`: a full AppContext on a temp DATA_ROOT, requests through `app.request`) and
`web/src/test/` (`renderWithProviders`, `mockFetch`, a `<dialog>` stand-in for jsdom). A test that
pins a known bug is `it.fails(...)` with a comment: fixing the bug turns it red, then drop `.fails`.
The fake CLI answers "Echo: <prompt>", asks an AskUserQuestion for a prompt with "ask", fails for
"fail". CI also runs actionlint, shellcheck on `docker/`, the Docker build + a smoke run of the
image, dependency review and CodeQL; `CI passed` is the one check to require on `main`.
For eyeballing the UI use
`node scripts/screenshot.mjs <url> out.png` (DevTools protocol, no browser deps); plain
`chrome --headless=new --screenshot` also works except on the Chat page, whose SSE stream keeps
the load event from ever firing. Chrome's window is never narrower than 500px, so that is the
"phone" width.

## Layout

- `supervisor/src/` — TypeScript, ESM (`"type": "module"`, NodeNext → import with `.js` suffix)
  - `index.ts` bootstrap (loads `.env`, wires everything); `config.ts` env parsing
  - `store/` SQLite via `node:sqlite` (no native build): `conversations`, `tasks` (with `ask`, what a
    running task waits for), `task_events`; migrations in `db.ts`
  - `tasks/service.ts` — **the session manager**: one queue for all channels, spawn `claude -p` per
    task, one running task per conversation, `MAX_CONCURRENT_SESSIONS` overall; emits `task` /
    `event` for Telegram delivery and SSE
  - `claude/runner.ts` spawns `claude -p --output-format stream-json`, surfaces text / tool_use /
    tool_result blocks and the final `result`
  - `bot.ts` grammY bot (text + voice), `stt/groq.ts` Whisper, `telegram/format.ts` Markdown → HTML.
    **Topics** (2026-10-01): a chat talks to one conversation at a time (`telegram_chats`,
    migration v10): its own by default, or any conversation the owner switched to by replying
    to a message of the bot (a schedule's report, a question, an ack; `telegram_messages`
    remembers which conversation and task every sent message belongs to, 180 days). The
    switch sticks until the next reply elsewhere or `/new [project]`, which also resets it;
    `/status` names the current one. A Telegram task in a web conversation (a schedule's
    thread) reports back to the chat whose topic it is. A question from a task that is not
    the chat's topic says "reply to this message with your answer". **Web tasks in Telegram** (1.1.2):
    `telegram/webNotify.ts` `WebNotifier` times a `web` task's reply (unread after
    `TELEGRAM_WEB_NOTIFY_MIN`, default 2, by `read_at` vs `finished_at`) and its ask (same
    request still open); then the bot sends it to the chat whose topic the thread is, else the
    owner's, switches that chat's topic to the thread and marks the reply read. A task whose
    question went there is escalated: its next questions and its reply go at once. Timers live
    in memory, a restart forgets them
  - `files/catalog.ts` agents / skills / projects / schedules as Markdown+frontmatter; `files/hosts.ts` the
    shared SSH hosts (`data/config/hosts.yaml`, see below); `sessions/transcripts.ts`
    indexes Claude Code JSONL; `presets/`
  - `schedules/` — **Phase 5** (2026-09-30): `spec.ts` parses and validates a schedule file's
    frontmatter, `cron.ts` is a dependency-free five-field cron matcher with time zones, an
    active window (`days`, `hours`) and `nextRun`, `prefilters.ts` the deterministic pollers
    (`command`: bash, one item per output line or a JSON array; `github-prs`: `gh pr list`,
    key = PR + head sha; `trac`: `/query?format=csv` with `TRAC_USER` / `TRAC_PASSWORD` basic
    auth or `TRAC_COOKIE`, key = id + changetime), `service.ts` the scheduler (20 s tick, fires
    each allowed minute once, remembers the fired minute across a restart, one run at a time
    per schedule, soft-stop from the last `rate_limit` snapshot, prefilter → minus `seen_items`
    → task in the schedule's own conversation `web` / `schedule:<name>` with a fresh session,
    prompt = frame + file body + new items). Store: migration v9 (`schedule_runs`,
    `seen_items`, `tasks.schedule`). Routes `web/routes/schedules.ts` (`/api/schedules/status`,
    `/:name/status|runs|run|preview|enabled|seen`, mounted before the file routes so
    `status` is not a file name); the file itself goes through the generic
    `/api/schedules/:name`. The bot delivers a `cron` task's report and questions to the
    owner's chat (first allowed id) unless `notify: none`, tells about a failed prefilter once
    per distinct error, and has `/schedules` and `/run <name>`. **Review pass 2026-10-01**
    (committed 2026-10-01): the ticker sweeps every minute since its last look (`schedules:last_tick`
    in `meta`, so a restart knows too): a firing the factory slept through runs late within
    `SCHEDULES_LATE_MIN` (default 5), an older one is a run row with status `missed` (one row
    per sweep, told in Telegram, never caught up: the owner's call, a laptop host). The
    first-run seeding is remembered in `meta` (`schedule:<name>:seeded`), so "Forget seen
    items" really hands everything over next time. An item whose key changed since an earlier
    handover (`id@changetime`, `pr@sha`) is marked `seen_before` (prompt: "seen before,
    changed since", maybe by the agent's own comment or push; Preview badges it `changed`).
    `once: true` switches the file off after queueing its task. A `cron` task's ask is answered
    for the owner after `SCHEDULES_ASK_TIMEOUT_MIN` (default 120; permission → deny, question
    → "no answer, decide by the instructions"), and a firing skipped because the previous run
    still waits is told once per task. `schedule_runs` carry the task's status (`task_status`,
    LEFT JOIN) and keep the last 1000 rows per schedule; `/:name/runs` returns only the
    firings that mattered (task, error, missed) unless `all=1`; the view has `last_task`
    besides `last_run`. Runs and seen items of a file that no longer exists are dropped at
    start. `/api/status` `stats.schedules` (`total`, `on`, `invalid`, `failing`, `missed`,
    `next`) feeds the Overview Health line and an amber count on the sidebar's Schedules item.
    The file routes refuse a save whose `updated_at` is older than the file (409, "changed
    on disk"): the editor sends the version it opened and offers "Reload from disk", since
    the agent edits a schedule's notes every run. The dispatcher rules
    (`templates/claude/CLAUDE.md`) tell the agent what a "Scheduled run" prompt is and that
    its memory is the file's body, never the frontmatter. The form asks for one cron field only
    (2026-09-30, owner's call): `GET /api/schedules/cron?expr=` reads it back in words with the next
    firing, the Editor's `validate` blocks Save on a bad one; the zone is `TIMEZONE` in `.env`
    (the owner's zone, renamed from `SCHEDULES_TZ` 2026-09-30; empty = UTC, the container's own;
    `.env.example` says America/Los_Angeles), which is also where "today" starts for the
    `done_today` / `failed_today` / `tokens_today` stats (`startOfDay` in `cron.ts`), `tz:` and `window:` in a
    file are honoured but not offered — weekdays and hours belong in the cron itself
  - `toolchains/` — **Toolchains** (1.2.0): `detect.ts` reads a checkout's needs (go.mod `toolchain` /
    `go`, `.nvmrc`, `package.json` engines, `composer.json`, `.python-version`, `mise.toml`,
    `.tool-versions`; root and `server/` `client/` …; compose files and their services), `mise.ts`
    wraps the `mise` CLI (`ls --installed/--current --json`, install, uninstall, prune), `docker.ts`
    the dind sidecar through `DOCKER_HOST` (`ps`, `system df`, stop, prune, and `snapshot` +
    `stopStartedSince` so `TaskService` stops what a task started unless another running task's
    project owns it, by the compose `working_dir` label), `service.ts` `Toolchains` caches the
    overview a minute. Routes `web/routes/toolchains.ts` (`GET /api/toolchains`,
    `/projects/:slug`, `POST /install`, `DELETE /tools/:tool/:version`, `POST /prune`,
    `/docker/stop`, `/docker/prune`); `/api/status` carries `toolchains` and `mcp` summaries for
    the Overview Health lines. Web: `components/Toolchains.tsx` (Settings → Toolchains, the
    project form's Toolchain block). Image: `tools` stage in the Dockerfile (build-essential, sury
    PHP, docker CLI + compose, mise with `/etc/mise/config.toml`: `yes`, idiomatic version files,
    `trusted_config_paths`, `node = "<image major>"` installed by the entrypoint so the shim always
    resolves; `MISE_DATA_DIR` etc. on the `data/tools` volume, shims first on PATH, the supervisor
    started by absolute path). dind: compose profile `docker` (`COMPOSE_PROFILES=docker` in
    `.env`), TLS certs through the `docker-certs` volume, workspaces mounted at the same path,
    `DOCKER_MEMORY` (8g). On macOS Docker Desktop dind's `/var/lib/docker` must be a named volume
    (the local `docker-compose.override.yml`, untracked), on Linux the bind mount is fine
  - `web/routes/audit.ts` — the audit log: `task_events` carry `agent` (sub-agent type, null =
    orchestrator) and `parent_tool_use_id`; the runner emits `llm` (one per model call), `agent`
    (sub-agent started / completed, from the CLI's `task_started` / `task_notification` system
    events) and `limits` events besides text / tool calls. A task's project is its conversation's
    at run time; a project-less task gets it detected from workspace names in tool-call inputs
  - `web/` Hono server: sign-in (`web/auth.ts`, below), `/api/*` routes, serves `web/dist`
- `web/src/` — Vite + React SPA, no UI framework, one `styles.css`; `lib/api.ts` typed client,
  `components/Editor.tsx` shared list+form for agents/skills/projects/schedules (an `aside`
  slot renders live state above the form: `pages/Schedules.tsx` puts the schedule's state, Run
  now, Preview prefilter, Switch on / off, Forget seen items and the run history there), pages
  per screen.
  `components/ui.tsx` is the shared vocabulary and the only place markup for it lives: `Button`
  (every button and button-styled link, `variant` / `size` / `to`), `Stat`, `Tabs`,
  `FilterSelect`, `Intro` (empty pane with one action), `Markdown`, `StopButton`, `Empty`,
  `ErrorBox`, `PageHead`; `LoadMore` / `LoadEarlier` in `components/LoadMore.tsx`. Pages compose
  these, never repeat their markup. Modal windows are
  `components/Modal.tsx`: `Modal` on a native `<dialog>` (top layer, focus trap, Escape, focus
  return), `ConfirmDialog` on it, and `ConfirmProvider` / `useConfirm()` (mounted in `App`) so a
  handler asks with one `await confirm({ title, action, danger, onConfirm })`; every destructive
  button (Delete, Reinstall, leaving unsaved edits via `lib/unsaved.ts` `useLeaveGuard`) goes
  through it, never `window.confirm`. A destructive question focuses Cancel, fills the action
  red, keeps the window open with the action busy while `onConfirm` runs and shows its error
  inline; on a phone it is a bottom sheet. Every list is keyset-paged (`lib/usePaged.ts` +
  `LoadMore` sentinel) with a `(timestamp, id)` cursor sent as `before` + `before_id`, so equal
  timestamps neither skip nor repeat rows; the audit log pages by event id and the server says
  `has_more`. Polling refreshes only the first page and drops rows that left it. `lib/unsaved.ts`
  is the one "unsaved edits" flag the editor sets and the sidebar checks. **Unread replies**
  (2026-09-30): `conversations.read_at` (migration v7) and a computed `unread` on every
  conversation row (a `done` / `failed` task finished after `read_at`); `/api/status` `stats`
  carries `chat_unread` / `chat_active`. The sidebar's Chat item shows a green count while
  something is unread (blue count while a task runs), the tab title gets `(N)`, the Chat list
  draws a green stripe + dot. **Tab signals** (2026-10-01): the favicon carries the same badge as
  the Chat item (`lib/favicon.ts`, canvas over the PNG icon: a count on green / amber, a blue dot while running;
  visible on a pinned tab where the title is not), and a bell in the sidebar foot opts into
  desktop notifications (`lib/notify.ts`, Web Notifications API, permission asked on the
  click, choice in `localStorage` `pf.notify`; one notification per rise of the unread / waiting
  count, only while the tab is hidden, `tag` so they replace instead of stacking; the notification
  is titled with the thread it is about and a click focuses the tab and opens that thread,
  `/api/status` `stats.chat_unread_latest` / `chat_needs_reply_latest` name it (2026-10-01); the API exists only on https or localhost, so the bell is disabled
  elsewhere). No blinking title: background tabs throttle timers and it reads as an alarm.
  External links in rendered Markdown open in a new tab (`rel="noopener noreferrer"`, set in a
  DOMPurify hook since `target` is not in its default attribute list); links into the factory
  stay in this tab. The open thread posts `/read` when it loads, when a reply lands
  and when the tab becomes visible again (a reply that arrives in a hidden tab stays unread);
  the bot marks a conversation read once its reply is delivered to Telegram, so a failed
  delivery keeps it lit. **Questions and permissions** (2026-09-30): the runner speaks
  stream-json on stdin too (`--input-format stream-json --permission-prompt-tool stdio`, an
  SDK-style `initialize` control request, then the prompt as a user message, stdin open until
  the result). That makes the CLI offer `AskUserQuestion` to the model in `-p` and route it,
  like any permission prompt the mode does not settle, to the supervisor as a `can_use_tool`
  control request; `TaskService` stores it as `tasks.ask` (migration v8, JSON: kind
  `question` / `permission`, request id, tool, input, answers so far), emits `ask` / `answer`
  events for the audit log and answers with a `control_response` (`updatedInput.answers`
  by question text, or allow / deny). The task stays `running` meanwhile, the wall-clock
  timeout is paused, and `needs_reply` on a conversation = a running task with an `ask`.
  Web: `components/Ask.tsx` renders the form inside the turn (radios / checkboxes plus an
  "Other" line, Allow / Deny for a permission) and on the task page; a message typed while
  a question is open is the answer (`TaskService.submit` routes it). Telegram: one message
  per question with inline buttons (`a|task|q|opt`), free text answers too, the message is
  settled with a reply once answered from any channel. Under `bypassPermissions` only
  `AskUserQuestion` arrives; in `acceptEdits` / `default` every unsettled tool does. A
  supervisor restart drops the pending ask with the CLI; the resumed session asks again.
  Without a host the tool does not exist in `-p` (verified 2026-09-30), so agents could only
  ask in prose. The Chat list draws an amber stripe + `?`, the composer placeholder changes.
  **A running conversation** (2026-10-05, from the owner's first real use): `conversations.active`
  (computed, a queued / running task) draws a blue stripe + pulsing dot in the Chat list, the same
  order as the sidebar badge (open thread > waiting > unread > running).
  **One badge per menu item**: the sidebar's Chat item shows unread (green) first, else
  waiting (amber), else active (blue), never two at once.
  **Drafts**: an unsent message is kept in `localStorage` per conversation
  (`lib/drafts.ts`, `pf.chat.draft.<id>`), restored with the caret at its end when the
  thread reopens, removed on send or delete.
  **Attachments** (1.1.0, 2026-10-06): `files/inbox.ts` `Inbox` saves the owner's files under
  `data/inbox/<conversation>/<stamp>-<rand>-<safe name>` (`TaskService.inbox`, pruned after 30
  days at start); `tasks.attachments` (migration v13) keeps `{ name, path, type, size }` and the
  runner gets `prompt + attachmentNote()` (absolute paths, "open with the Read tool") plus
  `--add-dir <inbox root>`, so the Read needs no prompt in any mode (verified with `default`:
  Haiku read a PNG and named its colour). Web: `POST /api/conversations/:id/attachments?name=`
  with the raw body (its own 20 MB body limit in `web/server.ts`), then `/messages` with
  `attachments: [names]`; `GET …/attachments/:name` serves PNG / JPEG / GIF / WebP inline and
  everything else (SVG, HTML) as a download under a sandbox CSP. `components/Attachments.tsx`:
  paperclip, paste, drop, chips with upload state; thumbnails under the bubble and on the task
  page. Telegram: photo / document / video; an album (`media_group_id`) is gathered for 1.5 s;
  with a caption it is a task at once, without one the files wait 30 min for the next text or
  voice of the chat (`/new` drops them); while a question is open they go with the answer.
  Deleting a conversation (`TaskService.deleteConversation`) removes its inbox directory; at
  start `Inbox.sweep` removes directories of deleted or unknown conversations (owner's rule
  2026-10-06: nothing on disk outlives its chat; any file the factory keeps for a chat belongs
  under its inbox directory). `TaskService.submit` runs `Inbox.adopt`, so a file saved for the
  chat's topic moves into the conversation a topic-switching reply lands in. **Changes panel** (1.1.0): `git/changes.ts`; a task of a bound
  conversation records `tasks.git.start_head` / `start_branch` at start (`snapshotSync`, before
  the CLI is registered, so the worker cannot overshoot `MAX_CONCURRENT_SESSIONS`), and every end
  of `attempt` measures first (`measure`: branch, base = merge-base with origin's default branch
  for a new branch, else the start; files / lines; uncommitted; `gh pr list --head`). Routes
  `/api/tasks/:id/changes`, `/changes/file?path=`, `POST /pr` (push + `gh pr create --fill`).
  `components/Changes.tsx` on the task page (`#changes`): report first, size + branch + Create
  PR, files by folder with generated ones folded (`isGenerated`: lock files, build output,
  minified, snapshots; migrations stay visible on purpose), one wrapped diff at a time. The chat
  links the size under a reply; the Telegram footer adds changes, PR and, with `WEB_PUBLIC_URL`,
  the panel's link
- **Brand** (2026-10-01): the logo is `docs/brand/logo.png` (ChatGPT's render, the only source; no
  hand-drawn SVG). `web/public/` holds the cuts made from it with Pillow (`favicon-32`, `icon-64` for
  the badge, `icon-192` for the sidebar and notifications, `icon-512`, `apple-touch-icon` on an opaque
  ink square since iOS paints transparent corners black, `icon-maskable-512` with the tile in the 80 %
  safe zone) and `manifest.webmanifest`, so the UI installs as a PWA from the phone's "Add to Home
  Screen"; `index.html` carries the icon, manifest, theme-color and apple-mobile-web-app tags
- `templates/claude/` — seeded into `data/claude/` on **every** container start with `cp -n`: new
  files appear, edited files are never overwritten. On the host, copy by hand the same way.
  Prose in agent / skill / project Markdown is not hard-wrapped (one line per paragraph or
  list item): the UI editor wraps it, and the previews render files with `breaks: false`.
  `node scripts/reflow-md.mjs <files>` unwraps a file that was written wrapped.
- `presets/<name>/` — `preset.json` + `agents/` `skills/` `projects/`; installed from the UI
- `docker/entrypoint.sh` — seeds `/data`, git identity + `safe.directory '*'`, the per-owner
  credential helper for github.com, links `/data/secrets/ssh` → `~/.ssh`
- **Web sign-in** (2026-10-01, replaces basic auth): with `WEB_AUTH_PASSWORD` set the SPA shows a
  sign-in page (`components/Auth.tsx`: `AuthProvider` asks `/api/auth/me` first, a 401 from any
  later call brings the page back) and the API wants a session cookie (`pf_session`, 32 random
  bytes, HttpOnly, SameSite=Strict, Secure behind an https proxy; the store keeps the SHA-256 in
  `web_sessions`, migration v12, sliding `WEB_SESSION_DAYS`; **idle timeout** (1.2.0): a session the
  owner has not used for `WEB_SESSION_IDLE_HOURS` (default 8, 0 = off) is deleted by the next request
  that finds it so, and only a request the SPA marks `x-factory-active: 1` (`lib/activity.ts`: a key,
  pointer, wheel or touch event or the tab becoming visible within 5 min) counts as use and slides the
  session; the status poll, the chat stream and image loads do not, so a tab left open overnight is
  signed out by morning). `web/auth.ts` `WebAuth`: constant-time
  compare of `WEB_AUTH_USER` / password, every attempt a `login_attempts` row and a log line,
  `WEB_LOGIN_MAX_FAILURES` (5) failures from one address within `WEB_LOGIN_LOCK_MIN` (10) lock
  that address for as long (429 + `Retry-After`; four times as many from anywhere lock everyone;
  attempts during a lock are recorded, not counted), a `notice` event the bot turns into a
  Telegram message (every sign-in, the first wrong password of a streak, a lock). The client
  address is the socket's unless `WEB_TRUST_PROXY=1` (then `X-Real-IP` / last `X-Forwarded-For`).
  `Authorization: Basic` still works for scripts (same credentials, same lockout, no session).
  Routes `web/routes/auth.ts`: `/api/auth/me|login|logout|logout-others|sessions|log`. The
  sidebar foot has Sign out next to the bell; Settings → Security shows the policy, the
  signed-in browsers (revoke one, "Sign out everywhere else") and the last 50 attempts.
  Without a password (open mode) there is no sign-in and the API answers only to localhost `Host`
  names plus `WEB_ALLOWED_HOSTS` (DNS-rebinding guard); in both modes it refuses mutating requests
  with a foreign `Origin` (CSRF), bodies over 2 MB, sends `Cache-Control: no-store` on `/api` and
  hono's secure headers (`X-Frame-Options: DENY`) on everything (`web/server.ts`). `CLAUDE_TASK_TIMEOUT_MIN` bounds a task's wall-clock time (0 = none); a
  stop sends SIGTERM to the CLI's process group and SIGKILL 10 s later. A conversation whose
  session cannot be resumed forgets the session id and the task runs once more from scratch. A
  task interrupted by a supervisor restart (deploy, crash, SIGTERM) stays `running` in the store,
  is re-queued at the next start (`tasks.restarts`, once) and resumes its session; the dispatcher
  rules tell the agent a repeated prompt means "continue". Only the owner's stop cancels.
  **Auto-continue** (1.1.0): a run refused for the subscription limit (`limitReset()` in
  `tasks/service.ts`: `rate_limit_event` `rejected` with `rateLimitType` / `resetsAt`, else the
  epoch in "usage limit reached|…", else an exhausted window's reset; the CLI's own words are
  "You've hit your limit" / "usage limit reached") goes back to `queued` with `not_before` =
  reset + 1 min and `limit_waits` + 1 (at most 3, only within `CLAUDE_AUTO_CONTINUE_HOURS`,
  default 6), keeping the session; `nextQueuedTasks` skips a conversation whose oldest queued task
  is not due, a 30 s interval ticks the worker. Telegram says when it continues once per wait;
  `/stop` cancels a queued task too; the web merge ranks a row by `limit_waits + restarts` first
  so the running → queued step is not dropped as stale. A wait also sets `pausedUntil`: the worker
  starts nothing new before the reset (each run would be refused in turn). Only the result path
  is covered: a CLI that exits without a result fails as before. Verified with a fake `claude` on PATH
- The CLI's environment is `process.env` minus the supervisor's own secrets (`PRIVATE_ENV` in
  `tasks/service.ts`: bot token, allowed ids, web auth, Groq key); GitHub tokens and MCP `${VAR}`
  secrets stay because the agent needs them. The supervisor never calls the Claude API with the
  OAuth token, and there is no model list endpoint: the agent editor offers the CLI's aliases
  (`sonnet`, `opus`, `haiku`, `fable`, `inherit`), which the CLI resolves to the subscription's
  current model, so files follow releases by themselves (decided 2026-09-29: no API call with the
  token, no probe turns; a full id can still be typed into the file)
- `data/` — runtime state, gitignored, bind-mounted; `WORKSPACES_DIR` in `.env` points the container
  (and `yarn dev`) at the owner's existing repositories

## Versioning and releases (2026-10-05)

`MAJOR.MINOR.PATCH`: the major almost never moves, a minor adds something the owner can see or
use, a patch fixes or polishes. The version lives in the root `package.json` (the workspaces are
kept in step), is read by `supervisor/src/version.ts`, shown in the sidebar foot
(`v1.0.0 · 2.1.290 (Claude Code)`, one line), in Telegram `/status`, in `/api/status`
`version` and in the start-up log. `CHANGELOG.md` (Keep a Changelog, newest first, `## [x.y.z] -
date` with `### Added` / `Changed` / `Fixed`) is written **with** the change, before the commit.
When the owner says "let's make a new version" (or the work is ready to commit): pick the next
version by the rules, `node scripts/release.mjs bump <x.y.z>`, fill the new section with what
changed since the previous one, and the commit carries both. The **tag and the release come only
after the PR is merged**: on `main`, `git pull`, `node scripts/release.mjs tag` (refuses a dirty
tree, a branch other than main, a main out of sync with origin, an existing tag or an empty
section) creates the annotated tag `vX.Y.Z`, pushes it and publishes the GitHub release with the
section as notes. Never tag a branch; never tag before the merge.
**One bump per PR** (owner's rule, 2026-10-05): once a branch carries the version bump, later commits on
it (review fixes, more changes) only extend that CHANGELOG section, never bump again.

## Decisions already made (don't re-open)

- Agent runtime = `claude` CLI subprocess, never the Agent SDK with a stored token (ToS, see SPEC §8).
- Auth (changed 2026-09-29) = a full claude.ai login **inside the container**:
  `docker compose run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN= supervisor claude auth login` prints a
  URL, the code is pasted back, and `data/claude/.credentials.json` gets `claudeAiOauth` with the
  `user:mcp_servers` / `user:profile` / `user:plugins` scopes. That brings the **claude.ai
  connectors** (Gmail, ClickUp, ferret with Trac, Drive, Calendar, Figma, …) and the synced
  plugins into every `-p` session, deferred behind ToolSearch (~200 tool names, schemas on
  demand). `CLAUDE_CODE_OAUTH_TOKEN` in `.env` must stay empty: a setup-token takes precedence
  and, by the docs, "can't fetch claude.ai connectors". The setup-token stays as the fallback
  for CI-like runs. (Earlier: interactive login was broken upstream, anthropics/claude-code#34917;
  the URL + code flow works in 2.1.283.)
- Agent works inside the owner's real checkouts on a branch (no worktrees, no re-cloning). A
  conversation bound to a project (`conversations.project`, set via the Chat selector, Telegram
  `/new <p>`, or detected from the first task; `/project <p>` was dropped 2026-10-05 as a confusing
  twin of `/new <p>`) spawns `claude -p` with
  cwd = the project's checkout, so the repository's `.mcp.json`, `.claude/agents`, `.claude/skills`
  and `CLAUDE.md` load on top of `data/claude`; a project-less conversation runs from the
  workspaces root. A task of a bound conversation carries that project from creation; detection
  from tool inputs runs only for a project-less task and binds only a project-less conversation
  (2026-10-05: a bound thread used to follow any mention of another checkout and lose its session). A session cannot follow a cwd change: `TaskService` compares the transcript's
  directory slug with the cwd and starts a fresh session when they differ.
- MCP in three layers: the repository's `.mcp.json` (loaded from the cwd; in `-p` mode project
  servers load without approval, and a project file's `mcp:` list turns the others off via
  `--settings disabledMcpjsonServers`, since an allowlist does not work in `-p`), the owner's
  `data/config/mcp.json` passed with `--mcp-config` to every session, and `mcpServers:` in an
  agent's frontmatter for role-owned tools only. Secrets only as `${VAR}` from `.env`. OAuth
  servers: log in once **inside the container**, from the checkout, with
  `docker compose run --rm -it -w /data/workspaces/<repo> supervisor claude mcp login <name> --no-browser`
  (prints the URL: open it on the laptop, paste the redirect URL back); the token lands in
  `data/claude/.credentials.json`, shared by every task, and the CLI refreshes it. Logging in
  from the laptop does not work on macOS: the CLI writes to the Keychain there, not to
  `CLAUDE_CONFIG_DIR`. Same command over SSH on a VPS. **The URL + paste flow in the
  container is the proven way to authorize anything OAuth**: ClickUp's MCP server
  (2026-09-28, `claude mcp login … --no-browser`) and the claude.ai account itself (2026-09-29,
  `claude auth login`) were both done this way; the ClickUp connector of the account now covers
  the same server without a `.mcp.json`. `/api/mcp` reports servers and variable status, never values; the init event's
  `mcp_servers` is kept in `meta` (`claude.mcp`). Sub-agents get data from the orchestrator, not
  MCP access (their `tools:` allowlists stay MCP-free), except role-owned tools. Role-owned
  servers (verified in the container 2026-09-29 with a stdio probe): `mcpServers:` in an agent
  file is a **list** — a bare name, or `- name: { type, command, args, env | url, headers }`
  inline; the server starts for that sub-agent only, its tool schemas never reach the
  orchestrator; the sub-agent's `tools:` may name `mcp__<server>__<tool>`; the call is still
  denied in `-p` unless settings allow `mcp__<server>`, so `TaskService.sessionSettings` adds an
  allow rule for every server declared in `data/claude/agents/*.md` (`Workspace.agentMcp`).
  Under `bypassPermissions` (the container) connector and project MCP calls go through without a
  rule; the rules matter for `acceptEdits` (`yarn dev`) and the default mode. `${VAR}` is
  **not** expanded in frontmatter (only in `.mcp.json` / `--mcp-config`); a stdio
  server inherits the CLI's environment instead, so secrets go into `.env` under the variable
  name the server expects and the frontmatter carries only literal paths and flags. The agent
  form does **not** edit `mcpServers:` (decided 2026-09-29: with the connectors in every
  session there is nothing for a role to declare); instead its tool picker lists the MCP
  servers the sessions have seen, grouped from the CLI's reported tool names
  (`/api/tools` → `mcp`, `mcp__<server>__<tool>`), with a whole-server box or single tools, so
  "a ClickUp agent" is a role with that server ticked and the email assistant is Gmail without
  send. `McpServersField` (`components/McpServers.tsx`) serves Settings → MCP only; a
  hand-written `mcpServers:` in a file still works and keeps its allow rule. **MCP registry**
  (`TaskService.mcpRegistry`, meta `claude.mcp.registry`): every server the CLI ever reported,
  keyed like its tools (`mcp__<key>__`), with `source` (connector / plugin / project:<slug> /
  factory) and the last `status`; fed by init events and by `POST /api/mcp/refresh`, which
  runs `claude mcp list` in the factory (~10 s) and is the only way to see servers that still
  need authentication. Settings → MCP shows this list (connected first) with a Refresh button;
  the editor for `data/config/mcp.json` is folded underneath; per-project lists are gone from
  Settings (the project form still reads the checkout's `.mcp.json` for its `mcp:` allowlist).
  `/api/status` reports `login`: `claude.ai (team, connectors)` or `token` or `none`.
  **Sign-in from the browser** (2026-09-30): every row that needs authentication has an
  Authorize button; `POST /api/mcp/login` runs `claude mcp login <name> --no-browser` in the
  factory (`claude/mcpLogin.ts`, `McpLogins`), from the project's checkout for a
  `project:<slug>` server, and the dialog (`components/McpLogin.tsx`) shows the link. Two
  modes, decided by the CLI: a **connector** URL leads to claude.ai and the command exits at
  once (the dialog ends with "Refresh statuses"); a project's OAuth server (`redirect` mode)
  keeps a callback server on a random localhost port inside the container and waits for the
  redirect URL, which the owner copies from the address bar of the page that could not load
  and pastes into the dialog (`POST /api/mcp/login/:id/complete`; the CLI's own rejection of a
  wrong URL comes back as the error, and the sign-in stays open). The CLI refuses that flow
  without a TTY ("stdin isn't a terminal"), so the command runs under a pseudo-terminal:
  util-linux `script -qfec` in the image (bookworm), a small `python3` pty loop on macOS for
  `yarn dev` (BSD `script` cannot take a pipe as stdin, and `pty.spawn` never returns after the
  child exits). Output is parsed with ANSI / OSC 8 escapes stripped. A completed redirect
  sign-in marks the server connected in the registry; an open one is cancelled on close, on
  shutdown and after 10 minutes. Plugins (stdio) and the owner's own `mcp.json` servers get no
  button: `claude mcp login` does not list them. On a macOS host the CLI reads no
  `.credentials.json` with an absolute `CLAUDE_CONFIG_DIR` (Keychain), so from `yarn dev`
  connectors answer "No MCP server named …": test sign-ins against the container.
  **Duplicates by URL** (2026-09-30): the registry keeps each server's `target` (the URL
  `claude mcp list` printed, so a Refresh is what fills it); `GET /api/mcp` marks a project or
  factory server whose URL equals a connector's with `duplicate_of` (the connector's key) and
  each project server with `connector` (its label). Settings folds such a server into the
  connector's row ("also `clickup` in project TenantManagement") and the project form badges it
  "via connector": the CLI itself drops the project entry when a connector has the same URL
  (verified: from the TenantManagement checkout `claude mcp list` omits BP JSKit MCP), sessions
  only ever reported the connector's tools, and the `.mcp.json` entry adds nothing.
- Token hygiene: `Explore` is overridden in `templates/claude/agents/Explore.md` with `model:
  haiku`; agents carry `maxTurns`, read-only ones `effort: medium`, `devops-engineer` also
  `omitClaudeMd`. The dispatcher suggests `/new` after a finished task. **Budget rules**
  (2026-10-01, from the audit log of the first `pr-review` runs: a sub-agent's cost is its
  turn count times its growing context, ~95 % of recorded tokens are cache reads, and the
  orchestrator re-read what the reviewer had cited): `pr-reviewer` has `maxTurns: 40`, every
  reviewer / triager / email sub-agent `omitClaudeMd: true` and a "Budget" section (group reads
  into one Bash call, read a region once, never build / test / worktree in the PR reviewer since
  the factory has no toolchains); the `pr-review` skill saves the diff to a file and passes the
  path, one reviewer per PR started together, posts the findings without reopening the files;
  the dispatcher rules say the same for every task (bulky input by path, a sub-agent's report
  is the result, sub-agents only for multi-step work). Reviewer `effort` stays default on
  purpose: the verification pass is where quality comes from.
- GitHub auth = fine-grained PATs, never mounted SSH keys. One per repository owner:
  `GH_TOKEN_<OWNER>` (login upper-cased, `-` → `_`), `GH_TOKEN` as the fallback. In the image
  `docker/gh` (a wrapper ahead of the real `gh` on PATH) and `docker/git-credential-owner`
  resolve the owner from the checkout's `origin` / the URL and call `docker/gh-token`.
- **The orchestrator's model is a run-time setting, not `.env`** (2026-10-01, owner's call:
  `CLAUDE_MODEL` removed from `.env` / `.env.example`): one CLI alias for the whole factory in
  `meta` (`claude.model`, `supervisor/src/claude/models.ts`: `sonnet` / `opus` / `haiku` /
  `fable`, default `sonnet`), set from Telegram `/model <alias>` or Settings → Claude Code →
  Model (`PUT /api/settings/model`), shown by `/status` and `/api/status` `claude.model`. It
  applies to the next task in every conversation (each task is its own `claude -p`, a resume
  with another model works); a running task keeps the one it started with. Sub-agents keep the
  `model:` of their files, `inherit` follows the orchestrator (the owner sets reviewers to it
  when running Fable). A schedule may pin `model:` in its frontmatter (form field after Agent,
  `inherit` = empty = the factory's current one; `tasks.model`, migration v11, records it on the
  queued task). The probe for limits stays on `haiku`. Cheaper models only for mechanical
  sub-agents.
- Agents, skills and projects live only in `data/` (gitignored); `templates/` and `presets/` are the
  install-time seed. There is no config git history any more: what an agent did, including edits
  to its own files or to a repository, is the Audit log (built live from stream-json, never from
  transcripts after the fact).
- No money in the UI or Telegram: the owner pays a subscription, so tasks report **tokens** (cache
  included) and their share of the **5-hour window**; screens show the 5-hour / weekly windows from
  the CLI's `rate_limit_event` (stream-json, `unifiedWindows`). `/api/oauth/usage` needs the
  `user:profile` scope that a setup-token lacks, so there is no polling — readings come with every
  task, plus an explicit probe (one Haiku turn: Overview → Refresh, Telegram `/usage refresh`).
  `cost_usd` stays in the DB for the record. `CLAUDE_MAX_BUDGET_USD` / `--max-budget-usd` are gone
  (2026-10-05): the CLI told the model its remaining dollars and the agent cut a review short
  "because $0.30 were left"; the dispatcher rules now say there is no money budget, the windows
  are the limit. The Telegram footer names the task's project and the windows with the task's
  share, not turns / tokens / seconds (those stay on the task page).
- Unknown `/commands` never reach the agent; replies are converted to Telegram HTML with plain-text
  fallback.
- Single language: TypeScript for supervisor, API and UI. No Python service (asked and answered:
  it would add a runtime and duplicate the types for nothing).
- Web UI is a Vite SPA served by the supervisor, not a separate Next.js service: one container, no SSR.
- UI theme: light, Guild.ai-like (paper background, dot grid, mono font, pastel pills, icon tiles).
  Tokens live in `web/src/styles.css`; no UI framework, keep it that way. **Dark theme** (1.2.0): the
  same tokens redefined under `:root[data-theme='dark']` (charcoal; `--ink` flips to pale and
  `--on-ink` / `--ink-hover` / `--on-red` / `--placeholder` / `--backdrop` go with it, so never write a
  literal `#fff` on an ink or red surface); `lib/theme.ts` keeps the choice in `localStorage`
  `pf.theme` (`light` / `dark`, absent = system) and sets `data-theme` on `<html>` plus the
  `theme-color` meta; an inline script in `index.html` does the same before the first paint. The
  sidebar foot's sun / moon flips light ↔ dark, Settings → Appearance offers System too. Icons are `lucide-react`
  (an icon set, not a framework) mapped once in `components/Icon.tsx`: the sidebar, `Tile` and
  card heads all draw the same icon for the same concept (chat = speech bubble, agents = bot,
  audit = clipboard, sessions = document, limits = gauge). A tile never changes size for its
  content; agents get a pixel mascot instead of an icon. The chat thread (`components/AssistantTurn.tsx`)
  renders one task as one exchange: a dark user bubble, then the agent's turn as a card with the
  orchestrator avatar, prose kept as prose and every run of tool calls / sub-agents folded into a
  "N steps" block (open while running). The view auto-follows only while scrolled to the bottom
  ("New messages" button otherwise); the composer grows with the draft, Enter sends. Code is
  highlighted with `highlight.js` (core build + the languages in `lib/highlight.ts`, theme in
  `styles.css` on the palette tokens): fenced blocks in Markdown via the `marked` renderer, and
  unfolded tool calls render an Edit as a diff, a Write as the file in its language, Bash as the
  command, the rest as JSON. Markdown / text files stay plain on purpose.
- Telegram is optional (`TELEGRAM_BOT_TOKEN` empty = web-only).
- **Hosts are shared** (2026-09-30, the way an IDE keeps SSH configurations once): `data/config/hosts.yaml`
  holds every connection (`name`, `ssh` target, optional `key` = file name in `data/secrets/ssh`) and
  nothing else; a project's `hosts:` entry is `- host: <name>` plus the project's own `path` and
  `notes` on that server (decided by the owner: path and notes are the project's, never the host's). Settings → Hosts lists them with the projects on each (add, edit, rename with the
  references following, test, delete with detach); the project form's "Add host…" offers the shared
  list or a new one, a shared host's card edits only the project's part and links to Settings, a host
  still written inline (the pre-2026-09-30 form) shows "Move to shared hosts" (a dialog with Test
  connection that keeps the path and notes with the project) or "Link to shared host X" when an identical target exists.
  Schedule files list hosts the same way (`hosts: [{ host, path?, notes? }]`, the form reuses the
  project's host cards; bare names still parse) and count as usage: Settings → Hosts shows them
  with a clock, a rename or a detach rewrites them too.
  `/api/hosts` (list with usage + inline ones), `PUT/DELETE /api/hosts/:name`, `/api/hosts/keys`
  lists key names, `/api/hosts/test` runs `ssh -o BatchMode=yes` for a target or a shared host by
  name. Keys are never read by the API. **Host keys** (2026-09-30): the factory's `known_hosts` is
  `data/config/known_hosts` (`files/knownHosts.ts`; `data/secrets` is mounted read-only, an old
  `data/secrets/ssh/known_hosts` is copied over once), the test passes it as `UserKnownHostsFile`
  and the image appends the same to `/etc/ssh/ssh_config` for the agents' own ssh. The test
  answers `host_key: unknown | changed` from ssh's stderr; `POST /api/hosts/keyscan` runs
  `ssh-keyscan` and returns the keys with SHA256 fingerprints, the UI shows them in a confirm
  dialog ("Trust host key…", red "Replace host key…" for a changed one) and `POST /api/hosts/trust`
  writes the confirmed lines (each must name that server; `replace` runs `ssh-keygen -R` first).
  Deleting a host, or saving it with another address, forgets the old server's key unless another
  shared or inline host still points at it. No shell on the factory box is needed to add a host. Passwords are not supported on purpose. Agents resolve
  `host:` from hosts.yaml (dispatcher rules, `onboard-project`, `devops-check`, `devops-engineer`). Branches are `feature/…` / `fix/…` by task kind; `branch_prefix` is no
  longer a form field (an existing value still overrides). GitHub still goes through the PAT, never SSH.
- **Schedules are files, not rows** (2026-09-30, Phase 5): `data/config/schedules/<name>.md`,
  because the body is both the instruction for every run and the agent's memory between runs
  (deferred tickets, PRs skipped on purpose), which the agent edits itself and the Audit log
  shows as a file event. The store keeps only runs and seen items. A firing without a
  prefilter always starts a task; with one, only new items do (zero tokens on an empty poll).
  A poller's first cron firing marks what exists as seen (`first_run: skip`; `command`
  prefilters default to `process`); Run now always hands over. A waiting or running run
  blocks the next firing; cron firings yield to the owner's windows (`SCHEDULES_SOFT_STOP`,
  default 85 %), manual ones do not. Missed minutes while the supervisor was down are not
  caught up. Mail has no deterministic prefilter yet (the Gmail connector lives in the
  session): a mail schedule is a prompt-type one at a coarse cadence; an IMAP prefilter is
  the follow-up. Trac access is HTTP from the supervisor (`TRAC_URL`, credentials in `.env`),
  the agent still reads full tickets through ferret. Host work in a schedule stays under the
  read-only rule unless the file's instructions allow specific commands; start every schedule
  with `action: report` and graduate it.
- The owner decides when to commit — never commit unprompted. When asked to commit: no
  `Co-Authored-By` lines.

## Status (2026-09-29, review pass)

Phases 0–4 of the spec are implemented and the container runs with the web UI (see git log for
the history up to the evening of 2026-09-28). Since then (all committed by 2026-10-01):

- Review pass 2026-09-29 (three reviewers + landscape survey, `docs/LANDSCAPE.md`): orphaned /
  interrupted tasks re-queued once and resumed (migration v6 `restarts`); Origin check in both auth
  modes + body limit; supervisor secrets stripped from the CLI env; `/api/models` (a Claude API call with the
  OAuth token) removed, the editor offers aliases; Telegram chunking kept code fences inverted from the third chunk
  on (fixed) and fences with info strings were prose (fixed); `/api/mcp` blanks URL query values
  and secret-looking args; invalid YAML frontmatter is reported (`frontmatter_error`) and the UI
  save refuses (409) instead of wiping it; preset skills install their helper files; NaN guards in
  `usage` / SSE `after`; body type validation → 400; `LOG_LEVEL` / `MAX_CONCURRENT_SESSIONS`
  validated; fetch timeouts on Telegram download and Groq; compose `mem_limit` / `pids_limit`;
  entrypoint no longer hides a failed template seed. Web: page remount per path fixed, `Button to`
  forwards `onClick` (unsaved guard), Sessions "load earlier" scrolls `.main`, MCP editor keeps
  drafts and sets the unsaved flag, poll merge compares `(ts, id)`, stale Audit summaries dropped,
  `/chat/new` StrictMode double-create, task page polls only while open.

- Code review pass: shared UI vocabulary in `components/ui.tsx`, keyset cursors `(ts, id)`,
  SSE stream buffering, stop → process group + SIGKILL, host/origin guard, `CLAUDE_TASK_TIMEOUT_MIN`,
  Telegram formatter / chunking fixes, list pages that fill the viewport, intro panes.
- GitHub tokens per repository owner (`GH_TOKEN_<OWNER>`, `docker/gh`, `docker/git-credential-owner`);
  the owner currently uses one classic `GH_TOKEN`, verified for push on personal and org repos.
- Voice works (Groq, `.oga` → `.ogg` upload name fix). Health on Overview is fully green.
- Presets (2026-09-29): `fullstack-ts-go` (go-developer, web-developer, go/typescript
  conventions), `fullstack-ts-php` (php-developer, php-conventions, the same web-developer),
  `devops` (devops-engineer with a read-only hook, devops-check), `pr-review`, `email-assistant`
  (agent on the **claude.ai Gmail connector**, `tools:` limited to eight read / draft tools, no
  send; skill `email-reply`; a second mailbox is an agent-owned server added in the agent form). The two full-stack
  presets share `fullstack-feature` and `web-developer` byte for byte: the skill picks the server
  developer from the checkout (`go.mod` → go-developer, `composer.json` → php-developer), so both
  can be installed and reinstalled in any order. Keep shared files identical across presets, since
  installed files are one flat namespace. `bug-tracker-fixer` was dropped from `presets/` (its
  `triager` / `tracker-defect-fix` stay installed in `data/`). `pr-review` and the core reviewer
  have a verification pass and severity levels; every agent / skill description has a "Use when"
  trigger.
- Projects: form reworked (no branch prefix, workflow select, collapsed tracker, host cards with
  key selection and "Test connection"); `TenantManagement` onboarded from Telegram.
- Conversations bound to a project run from its checkout (repository `.mcp.json`, `.claude/agents`,
  skills and `CLAUDE.md` apply); `/new <p>`, Chat selector; MCP in three layers with
  Settings → MCP editor for `data/config/mcp.json`; project `mcp:` allowlist; `Explore` on haiku,
  `maxTurns` / `effort` on agents.
- Markdown prose in agents / skills is unwrapped (`scripts/reflow-md.mjs`); previews render files
  with `breaks: false`.

Not done / next:

1. Commit the batch above (the owner sets the commit budget).
2. ~~First real feature-to-pr / fullstack-feature run on a real repository, end to end from
   Telegram~~ — passed on mikserver (owner, 2026-10-06). Gap found: the container has no project
   toolchains (Go, swag, golangci-lint, PHP, composer, phpunit), so checks cannot run there.
3. Onboarding of the other three work repos (MCP sign-ins now go through Settings → MCP →
   Authorize; the console flow stays as the fallback).
4. Email assistant: preset on the claude.ai Gmail connector, installed; the owner blanks
   `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, recreates the container and runs the first draft from
   Telegram. Connectors also close the Trac gap (ferret) and give UserManagement ClickUp without
   a `.mcp.json`. A project form section for extra MCP servers was dropped: projects inherit
   their checkout's `.mcp.json`, roles own theirs in the agent form.
5. ~~Phase 5: schedules + prefilters~~ — implemented 2026-09-30: schedule files,
   scheduler, `command` / `github-prs` / `trac` prefilters, soft-stop, Schedules page, Telegram
   `/schedules` `/run`. Verified on the host through the API (create, validate, preview, toggle,
   run now → task queued → run row + task linked); `inbox-morning` ran twice from Run now in the
   container (2026-09-30 / 10-01). Review pass 2026-10-01 (see `schedules/` above): missed
   firings, seeding mark, changed items, `once`, ask timeout, task status in the history,
   Overview / sidebar, save conflicts, Telegram topics. Same day, after the owner's first
   `pr-review` runs: a task's tokens are the sum of its `llm` events when that exceeds the CLI's
   `result` (which counts the orchestrator only, and only its last turn when sub-agents ran in
   the background: 95k recorded vs 3.6M real), duration is wall-clock; `detectProject` reads
   `owner/name` as the repository and prefers a name with a project file (`--repo
   ServicePattern/UserManagement` used to bind the chat to the `ServicePattern` folder).
   Still needed: Trac credentials in `.env`
   (`TRAC_URL`, `TRAC_USER` / `TRAC_PASSWORD` or `TRAC_COOKIE`; whether the server wants the
   `/login` path is unverified), the owner's answers on PR scope (review requests only vs every
   open PR) and mail cadence; an IMAP prefilter for mail.
6. Phase 6: quota estimate, budgets / soft-stop, backups; web-side notifications to Telegram;
   README for forkers.
7. ~~**Toolchains in the factory**~~ — done 2026-10-09 (release 1.2.0, see `toolchains/` above and
   the decisions in `docs/plans/toolchains.md`): mise + `data/tools`, PHP 8.2 from sury, the dind
   sidecar behind `COMPOSE_PROFILES=docker`; the agent installs what a checkout needs itself, a
   task's services are stopped when it ends. Not done: a weekly prune schedule, a `data/docker`
   size in Health (the supervisor does not see that directory), toolchains in the Telegram `/status`.
8. Nice-to-haves: `useBlocker` for browser back in the editor, one shared status poll, CodeMirror,
   audit log export.
9. Release 1.1 from the October survey: ~~photos and files in~~ and ~~auto-continue after a window
   reset~~ and ~~the Changes panel~~ done 2026-10-06 (branch `feature/attachments-and-auto-continue`,
   not committed); next: Merge from the UI, files back to the chat. From the landscape survey (`docs/LANDSCAPE.md`), in priority order: ~~permission prompts /
   `AskUserQuestion` from Telegram and the web~~ (done 2026-09-30 over stream-json, see above;
   "Always allow" rules and a deny-on-timeout policy still open); photos and files in
   (`data/inbox/<task>/`, `@path` in the prompt); auto-continue after a window reset; a diff panel
   with "Create PR" on the task page; "continue in chat" for an indexed laptop session; per-agent /
   project token budgets; audit export.
