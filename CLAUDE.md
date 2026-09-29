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
```

No test runner yet; smoke-test through the API (`curl localhost:8080/api/status`) or a scratch
tsx script against `TaskService`. Lint/prettier not configured yet — follow the portfolio repo's
style (4-space indent, single quotes, no trailing commas, 120 cols). For eyeballing the UI use
`node scripts/screenshot.mjs <url> out.png` (DevTools protocol, no browser deps); plain
`chrome --headless=new --screenshot` also works except on the Chat page, whose SSE stream keeps
the load event from ever firing. Chrome's window is never narrower than 500px, so that is the
"phone" width.

## Layout

- `supervisor/src/` — TypeScript, ESM (`"type": "module"`, NodeNext → import with `.js` suffix)
  - `index.ts` bootstrap (loads `.env`, wires everything); `config.ts` env parsing
  - `store/` SQLite via `node:sqlite` (no native build): `conversations`, `tasks`, `task_events`;
    migrations in `db.ts`
  - `tasks/service.ts` — **the session manager**: one queue for all channels, spawn `claude -p` per
    task, one running task per conversation, `MAX_CONCURRENT_SESSIONS` overall; emits `task` /
    `event` for Telegram delivery and SSE
  - `claude/runner.ts` spawns `claude -p --output-format stream-json`, surfaces text / tool_use /
    tool_result blocks and the final `result`
  - `bot.ts` grammY bot (text + voice), `stt/groq.ts` Whisper, `telegram/format.ts` Markdown → HTML
  - `files/catalog.ts` agents / skills / projects as Markdown+frontmatter; `sessions/transcripts.ts`
    indexes Claude Code JSONL; `presets/`
  - `web/routes/audit.ts` — the audit log: `task_events` carry `agent` (sub-agent type, null =
    orchestrator) and `parent_tool_use_id`; the runner emits `llm` (one per model call), `agent`
    (sub-agent started / completed, from the CLI's `task_started` / `task_notification` system
    events) and `limits` events besides text / tool calls. Project per task is detected from
    workspace names in tool-call inputs
  - `web/` Hono server: basic auth, `/api/*` routes, serves `web/dist`
- `web/src/` — Vite + React SPA, no UI framework, one `styles.css`; `lib/api.ts` typed client,
  `components/Editor.tsx` shared list+form for agents/skills/projects, pages per screen.
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
  is the one "unsaved edits" flag the editor sets and the sidebar checks
- `templates/claude/` — seeded into `data/claude/` on **every** container start with `cp -n`: new
  files appear, edited files are never overwritten. On the host, copy by hand the same way.
  Prose in agent / skill / project Markdown is not hard-wrapped (one line per paragraph or
  list item): the UI editor wraps it, and the previews render files with `breaks: false`.
  `node scripts/reflow-md.mjs <files>` unwraps a file that was written wrapped.
- `presets/<name>/` — `preset.json` + `agents/` `skills/` `projects/`; installed from the UI
- `docker/entrypoint.sh` — seeds `/data`, git identity + `safe.directory '*'`, the per-owner
  credential helper for github.com, links `/data/secrets/ssh` → `~/.ssh`
- Without `WEB_AUTH_PASSWORD` the API answers only to localhost `Host` names plus
  `WEB_ALLOWED_HOSTS` (DNS-rebinding guard); in both auth modes it refuses mutating requests with a
  foreign `Origin` (CSRF: browsers send basic-auth credentials cross-site too) and bodies over
  2 MB (`web/server.ts`). `CLAUDE_TASK_TIMEOUT_MIN` bounds a task's wall-clock time (0 = none); a
  stop sends SIGTERM to the CLI's process group and SIGKILL 10 s later. A conversation whose
  session cannot be resumed forgets the session id and the task runs once more from scratch. A
  task interrupted by a supervisor restart (deploy, crash, SIGTERM) stays `running` in the store,
  is re-queued at the next start (`tasks.restarts`, once) and resumes its session; the dispatcher
  rules tell the agent a repeated prompt means "continue". Only the owner's stop cancels
- The CLI's environment is `process.env` minus the supervisor's own secrets (`PRIVATE_ENV` in
  `tasks/service.ts`: bot token, allowed ids, web auth, Groq key); GitHub tokens and MCP `${VAR}`
  secrets stay because the agent needs them. The supervisor never calls the Claude API with the
  OAuth token, and there is no model list endpoint: the agent editor offers the CLI's aliases
  (`sonnet`, `opus`, `haiku`, `fable`, `inherit`), which the CLI resolves to the subscription's
  current model, so files follow releases by themselves (decided 2026-09-29: no API call with the
  token, no probe turns; a full id can still be typed into the file)
- `data/` — runtime state, gitignored, bind-mounted; `WORKSPACES_DIR` in `.env` points the container
  (and `yarn dev`) at the owner's existing repositories

## Decisions already made (don't re-open)

- Agent runtime = `claude` CLI subprocess, never the Agent SDK with a stored token (ToS, see SPEC §8).
- Auth = `claude setup-token` on a laptop → `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. Interactive `/login`
  inside the container is broken upstream (anthropics/claude-code#34917).
- Agent works inside the owner's real checkouts on a branch (no worktrees, no re-cloning). A
  conversation bound to a project (`conversations.project`, set via the Chat selector, Telegram
  `/new <p>` / `/project <p>`, or detected from the first task) spawns `claude -p` with
  cwd = the project's checkout, so the repository's `.mcp.json`, `.claude/agents`, `.claude/skills`
  and `CLAUDE.md` load on top of `data/claude`; a project-less conversation runs from the
  workspaces root. A session cannot follow a cwd change: `TaskService` compares the transcript's
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
  `CLAUDE_CONFIG_DIR`. Same command over SSH on a VPS. `/api/mcp` reports servers and variable status, never values; the init event's
  `mcp_servers` is kept in `meta` (`claude.mcp`). Sub-agents get data from the orchestrator, not
  MCP access (their `tools:` allowlists stay MCP-free), except role-owned tools.
- Token hygiene: `Explore` is overridden in `templates/claude/agents/Explore.md` with `model:
  haiku`; agents carry `maxTurns`, read-only ones `effort: medium`, `devops-engineer` also
  `omitClaudeMd`. The dispatcher suggests `/new` after a finished task.
- GitHub auth = fine-grained PATs, never mounted SSH keys. One per repository owner:
  `GH_TOKEN_<OWNER>` (login upper-cased, `-` → `_`), `GH_TOKEN` as the fallback. In the image
  `docker/gh` (a wrapper ahead of the real `gh` on PATH) and `docker/git-credential-owner`
  resolve the owner from the checkout's `origin` / the URL and call `docker/gh-token`.
- Default model `sonnet`; cheaper models only for mechanical sub-agents later.
- Agents, skills and projects live only in `data/` (gitignored); `templates/` and `presets/` are the
  install-time seed. There is no config git history any more: what an agent did, including edits
  to its own files or to a repository, is the Audit log (built live from stream-json, never from
  transcripts after the fact).
- No money in the UI or Telegram: the owner pays a subscription, so tasks report **tokens** (cache
  included) and their share of the **5-hour window**; screens show the 5-hour / weekly windows from
  the CLI's `rate_limit_event` (stream-json, `unifiedWindows`). `/api/oauth/usage` needs the
  `user:profile` scope that a setup-token lacks, so there is no polling — readings come with every
  task, plus an explicit probe (one Haiku turn: Overview → Refresh, Telegram `/usage refresh`).
  `cost_usd` stays in the DB for the record; `CLAUDE_MAX_BUDGET_USD` stays as a safety stop.
- Unknown `/commands` never reach the agent; replies are converted to Telegram HTML with plain-text
  fallback.
- Single language: TypeScript for supervisor, API and UI. No Python service (asked and answered:
  it would add a runtime and duplicate the types for nothing).
- Web UI is a Vite SPA served by the supervisor, not a separate Next.js service: one container, no SSR.
- UI theme: light, Guild.ai-like (paper background, dot grid, mono font, pastel pills, icon tiles).
  Tokens live in `web/src/styles.css`; no UI framework, keep it that way. Icons are `lucide-react`
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
- Project files carry `hosts:` (SSH targets, optional `key` = file name in `data/secrets/ssh`) for
  sub-agents; keys live in `data/secrets/ssh`, mounted read-only, and are never read by the API:
  `/api/hosts/keys` lists names, `/api/hosts/test` runs `ssh -o BatchMode=yes`. Passwords are not
  supported on purpose. Branches are `feature/…` / `fix/…` by task kind; `branch_prefix` is no
  longer a form field (an existing value still overrides). GitHub still goes through the PAT, never SSH.
- The owner decides when to commit — never commit unprompted. When asked to commit: no
  `Co-Authored-By` lines.

## Status (2026-09-29, review pass)

Phases 0–4 of the spec are implemented and the container runs with the web UI (see git log for
the history up to the evening of 2026-09-28). Since then, uncommitted at the time of writing:

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
  `devops` (devops-engineer with a read-only hook, devops-check), `pr-review`. The two full-stack
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
  skills and `CLAUDE.md` apply); `/new <p>`, `/project <p>`, Chat selector; MCP in three layers with
  Settings → MCP editor for `data/config/mcp.json`; project `mcp:` allowlist; `Explore` on haiku,
  `maxTurns` / `effort` on agents.
- Markdown prose in agents / skills is unwrapped (`scripts/reflow-md.mjs`); previews render files
  with `breaks: false`.

Not done / next:

1. Commit the batch above (the owner sets the commit budget).
2. First real feature-to-pr / fullstack-feature run on a real repository, end to end from
   Telegram: branch → developer → reviewer → checks → PR link.
3. ClickUp MCP login for `TenantManagement` (`docker compose run --rm -it -w
   /data/workspaces/TenantManagement supervisor claude mcp login clickup --no-browser`),
   onboarding of the other three work repos.
4. Deferred to the next session (details in the assistant's memory): "Extra MCP servers" in the
   project form and "MCP servers of this role" in the agent form (same editor as Settings), then
   the `email-assistant` preset (Gmail MCP, drafts only).
5. Phase 5: schedules + prefilters (TRAC poller, GitHub review requests) — `source: cron` is
   already in the tasks table; UC-4 staging access (SPEC open question 8) must be settled first.
6. Phase 6: quota estimate, budgets / soft-stop, backups; web-side notifications to Telegram;
   README for forkers.
7. Nice-to-haves: `useBlocker` for browser back in the editor, one shared status poll, CodeMirror,
   audit log export.
8. From the landscape survey (`docs/LANDSCAPE.md`), in priority order: permission prompts /
   `AskUserQuestion` from Telegram and the web via `--permission-prompt-tool`; photos and files in
   (`data/inbox/<task>/`, `@path` in the prompt); auto-continue after a window reset; a diff panel
   with "Create PR" on the task page; "continue in chat" for an indexed laptop session; per-agent /
   project token budgets; audit export.
