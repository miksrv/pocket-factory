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
4. **Pipelines** — skills chaining sub-agents into repeatable flows; schedules with prefilters.

Concept, use cases and security model: `docs/SPEC.md` (§4.4 session lifecycle and §8 security are
the load-bearing parts). History of what shipped: `CHANGELOG.md` and git log.

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

Checks (all run in CI, `.github/workflows/ci.yml`; `yarn check` runs the first four locally):

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

For eyeballing the UI use `node scripts/screenshot.mjs <url> out.png` (DevTools protocol, no
browser deps); plain `chrome --headless=new --screenshot` also works except on the Chat page, whose
SSE stream keeps the load event from ever firing. Chrome's window is never narrower than 500px, so
that is the "phone" width.

After code changes, rebuild the container yourself (`docker compose up -d --build`): the owner tests
on :8080 against the container.

## Layout

- `supervisor/src/` — TypeScript, ESM (`"type": "module"`, NodeNext → import with `.js` suffix)
  - `index.ts` bootstrap (loads `.env`, wires everything); `config.ts` env parsing
  - `store/` SQLite via `node:sqlite` (no native build); migrations in `db.ts`
  - `tasks/service.ts` — **the session manager**: one queue for all channels, spawn `claude -p` per
    task, one running task per conversation, `MAX_CONCURRENT_SESSIONS` overall; emits `task` /
    `event` for Telegram delivery and SSE. Also: questions / permissions (`tasks.ask`), restart
    recovery, auto-continue after a limit, provider env, toolchain cleanup — see Decisions
  - `claude/runner.ts` spawns `claude -p` with stream-json on stdin and stdout, surfaces text /
    tool_use / tool_result, `llm` (one per model call), `agent` (sub-agent start / end from the
    CLI's `task_started` / `task_notification`), `limits` and the final `result`
  - `bot.ts` grammY bot (text, voice, photos / documents), `stt/groq.ts` Whisper,
    `telegram/format.ts` Markdown → Telegram HTML with plain-text fallback
  - `telegram/webNotify.ts` — a `web` task's reply unread after `TELEGRAM_WEB_NOTIFY_MIN` (default
    2), or its question still open, goes to Telegram; the chat's topic switches to that thread and
    the task is escalated (its next questions and reply go at once). Timers live in memory
  - `files/catalog.ts` agents / skills / projects / schedules as Markdown+frontmatter;
    `files/hosts.ts` shared SSH hosts; `files/knownHosts.ts`; `files/inbox.ts` attachments;
    `files/providers.ts`; `sessions/transcripts.ts` indexes Claude Code JSONL; `presets/`
  - `schedules/` — `spec.ts` (frontmatter), `cron.ts` (dependency-free five-field matcher with
    zones, `nextRun`, `startOfDay`), `prefilters.ts` (`command`, `github-prs`, `trac`), `service.ts`
    (the scheduler, 20 s tick)
  - `toolchains/` — `detect.ts` (a checkout's needs: go.mod, `.nvmrc`, engines, composer,
    `.python-version`, mise / tool-versions, compose services), `mise.ts`, `docker.ts` (the dind
    sidecar through `DOCKER_HOST`), `service.ts` (overview cached a minute; `health()` answers from
    the cache and refreshes in the background so a dead sidecar never stalls `/api/status`)
  - `gateway/` — the provider gateway (`/gateway/<name>`, outside `/api`), `translate.ts`
    Anthropic Messages ↔ OpenAI chat completions, streaming included; MCP pass-through;
    `factory.ts` the factory's own MCP server per task (`/factory/<task>/mcp`, tool `delegate`)
  - `git/changes.ts` — the Changes panel (start head recorded before the CLI starts, measured at
    the end of every attempt: branch, base, files / lines, uncommitted, `gh pr list --head`)
  - `claude/mcpLogin.ts` — `claude mcp login --no-browser` under a pseudo-terminal; `claude/models.ts`
  - `web/` Hono server: `auth.ts` sign-in, `routes/*` (`/api/*`), serves `web/dist`
- `web/src/` — Vite + React SPA, no UI framework, one `styles.css`; `lib/api.ts` typed client.
  - `components/ui.tsx` is the shared vocabulary and the only place its markup lives: `Button`
    (every button and button-styled link, `variant` / `size` / `to`), `Stat`, `Tabs`,
    `FilterSelect`, `Intro`, `Markdown`, `StopButton`, `Empty`, `ErrorBox`, `PageHead`;
    `LoadMore` / `LoadEarlier` in `components/LoadMore.tsx`. Pages compose these, never repeat
    their markup.
  - `components/Modal.tsx`: `Modal` on a native `<dialog>`, `ConfirmDialog`, `useConfirm()`. Every
    destructive button (Delete, Reinstall, leaving unsaved edits via `lib/unsaved.ts`
    `useLeaveGuard`) goes through `await confirm({ title, action, danger, onConfirm })`, never
    `window.confirm`. A destructive question focuses Cancel, keeps the window open while
    `onConfirm` runs and shows its error inline; on a phone it is a bottom sheet.
  - `components/Editor.tsx` shared list+form for agents / skills / projects / schedules (an
    `aside` slot shows live state above the form).
  - Lists are keyset-paged (`lib/usePaged.ts` + `LoadMore`) with a `(timestamp, id)` cursor sent
    as `before` + `before_id`; the audit log pages by event id and the server says `has_more`.
    Polling refreshes only the first page.
  - `components/AssistantTurn.tsx`: one task = a dark user bubble + the agent's turn card, tool
    runs folded into "N steps". The thread auto-follows only at the bottom. Code highlighted with
    `highlight.js` (`lib/highlight.ts`); an Edit renders as a diff, Write as the file, Bash as the
    command. Markdown / text files stay plain on purpose.
  - Other parts: `Ask.tsx` (questions / permissions), `Attachments.tsx`, `Changes.tsx`,
    `Toolchains.tsx`, `Providers.tsx` + `ModelPicker`, `McpLogin.tsx`, `Auth.tsx`; `lib/drafts.ts`
    (unsent text per conversation), `lib/favicon.ts` (badge on the favicon), `lib/notify.ts`
    (desktop notifications, https / localhost only), `lib/theme.ts`, `lib/activity.ts`.
- `templates/claude/` — seeded into `data/claude/` on **every** container start with `cp -n`: new
  files appear, edited files are never overwritten. On the host, copy by hand the same way.
  Prose in agent / skill / project Markdown is not hard-wrapped (one line per paragraph or list
  item): the UI editor wraps it, previews render with `breaks: false`.
  `node scripts/reflow-md.mjs <files>` unwraps a file that was written wrapped.
- `presets/<name>/` — `preset.json` + `agents/` `skills/` `projects/`, installed from the UI.
  Installed files are one flat namespace: files shared by presets (`fullstack-feature`,
  `web-developer`) must stay byte-identical across them.
- `docker/` — `entrypoint.sh` (seeds `/data`, git identity + `safe.directory '*'`, links
  `/data/secrets/ssh` → `~/.ssh`, installs the image's node through mise), `gh` wrapper,
  `git-credential-owner`, `gh-token`
- `docs/brand/logo.png` — the only logo source (no hand-drawn SVG); `web/public/` holds the cuts
  made from it with Pillow (`apple-touch-icon` on an opaque square, `icon-maskable-512` in the 80 %
  safe zone) and the PWA manifest
- `data/` — runtime state, gitignored, bind-mounted; `WORKSPACES_DIR` in `.env` points the container
  (and `yarn dev`) at the owner's existing repositories. `docker-compose.override.yml` is local and
  untracked (bot off, dind on a named volume for macOS): never commit it

## Versioning and releases

`MAJOR.MINOR.PATCH`: the major almost never moves, a minor adds something the owner can see or
use, a patch fixes or polishes. The version lives in the root `package.json` (the workspaces are
kept in step), is read by `supervisor/src/version.ts`, shown in the sidebar foot, in Telegram
`/status`, in `/api/status` `version` and in the start-up log. `CHANGELOG.md` (Keep a Changelog,
newest first, `## [x.y.z] - date` with `### Added` / `Changed` / `Fixed`) is written **with** the
change, before the commit.

When the owner says "let's make a new version" (or the work is ready to commit): pick the next
version, `node scripts/release.mjs bump <x.y.z>`, fill the new section, and the commit carries both.
**One bump per PR**: once a branch carries the bump, later commits only extend that section. The
**tag and the release come only after the PR is merged**: on `main`, `git pull`,
`node scripts/release.mjs tag` (refuses a dirty tree, another branch, a main out of sync, an
existing tag or an empty section). Never tag a branch; never tag before the merge.

Commits: the owner decides when to commit — never commit unprompted. No `Co-Authored-By` lines,
no "Generated with" in PR bodies. A commit subject starts with what changed, capitalised, never with
the branch or release (`Delegation in CLAUDE.md, the README and the providers plan`, not
`release 1.4.0: delegation in …`).

## Decisions already made (don't re-open)

### Runtime and auth

- Agent runtime = `claude` CLI subprocess, never the Agent SDK with a stored token (ToS, SPEC §8).
  The CLI is installed as published and never patched.
- Auth = a full claude.ai login **inside the container**:
  `docker compose run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN= supervisor claude auth login` prints a
  URL, the code is pasted back, `data/claude/.credentials.json` gets the `user:mcp_servers` /
  `user:profile` / `user:plugins` scopes. That brings the **claude.ai connectors** (Gmail, Drive,
  ClickUp, …) and synced plugins into every `-p` session, deferred behind
  ToolSearch. `CLAUDE_CODE_OAUTH_TOKEN` in `.env` must stay empty: a setup-token takes precedence
  and cannot fetch connectors; it stays only as a fallback for CI-like runs. On a macOS host the
  CLI uses the Keychain, not `CLAUDE_CONFIG_DIR`, so connectors and MCP sign-ins must be tested
  against the container, not `yarn dev`.
- The supervisor never calls the Claude API with the owner's credentials: no model list (the
  editor offers the CLI aliases `sonnet` / `opus` / `haiku` / `fable` / `inherit`, which follow
  releases by themselves; a full id can still be typed), no `/api/oauth/usage`.
- **The orchestrator's model is a run-time setting**, not `.env`: `meta` `claude.model`
  (`claude/models.ts`, default `sonnet`), set by Telegram `/model <alias>` or Settings → Claude
  Code → Model; applies to the next task everywhere. Sub-agents keep their files' `model:`
  (`inherit` follows the orchestrator). A schedule may pin `model:` (`tasks.model`). The limits
  probe stays on `haiku`.
- The CLI's environment is `process.env` minus the supervisor's own secrets (`PRIVATE_ENV` in
  `tasks/service.ts`: bot token, allowed ids, web auth, Groq key; `agentEnv` also strips every
  provider's `token` variable); GitHub tokens and MCP `${VAR}` secrets stay because the agent needs them.
- Single language: TypeScript for supervisor, API and UI; no Python service. The web UI is a
  Vite SPA served by the supervisor (one container, no SSR).

### Sessions and tasks

- Every task is a one-shot `claude -p`; the conversation keeps the session id and the next task
  resumes it. A session that cannot be resumed is forgotten and the task runs once more fresh. A
  session cannot follow a cwd change: when the transcript's directory slug differs from the cwd,
  a fresh session starts.
- The agent works in the owner's real checkouts on a branch (no worktrees, no re-cloning). A
  conversation bound to a project (Chat selector, Telegram `/new <p>`, or detected from the first
  task) runs with cwd = the checkout, so the repository's `.mcp.json`, `.claude/agents`, skills
  and `CLAUDE.md` load on top of `data/claude`; a project-less one runs from the workspaces root.
  Detection from tool inputs runs only for a project-less task, binds only a project-less
  conversation, reads `owner/name` as the repository and prefers a name with a project file.
- **Questions and permissions** go over stream-json on stdin (`--input-format stream-json
  --permission-prompt-tool stdio`, an SDK-style `initialize`): without such a host
  `AskUserQuestion` does not exist in `-p`. A `can_use_tool` request becomes `tasks.ask`; the
  task stays `running`, the wall-clock timeout pauses, the slot is held for as long as it waits
  (owner's decision). Answered from the web (`Ask.tsx`; a message typed while a question is open
  is the answer) or Telegram (inline buttons `a|task|q|opt`, free text too). Under
  `bypassPermissions` (the container) only `AskUserQuestion` arrives; in `acceptEdits` / `default`
  every unsettled tool does. A supervisor restart drops the pending ask; the resumed session asks
  again.
- **Restarts**: a task left `running` by a supervisor restart is re-queued once (`tasks.restarts`)
  and resumes its session; the dispatcher rules say a repeated prompt means "continue". Only the
  owner's stop cancels. A stop sends SIGTERM to the CLI's process group, SIGKILL 10 s later.
  `CLAUDE_TASK_TIMEOUT_MIN` bounds wall-clock time (0 = none).
- **Auto-continue**: a run refused for the subscription limit (`limitReset()`) goes back to
  `queued` with `not_before` = reset + 1 min, at most 3 times within `CLAUDE_AUTO_CONTINUE_HOURS`
  (default 6), keeping the session; `pausedUntil` stops the worker starting new subscription
  tasks before the reset. Only the result path is covered: a CLI that exits without a result fails.
- **Attachments**: files live under `data/inbox/<conversation>/` (pruned after 30 days; a deleted
  conversation's directory goes with it, `Inbox.sweep` removes orphans at start: nothing on disk
  outlives its chat, owner's rule). The prompt gets the absolute paths plus `--add-dir <inbox
  root>`, so Read needs no permission. Telegram albums are gathered for 1.5 s; files without a
  caption wait 30 min for the next text. Inline serving only for PNG / JPEG / GIF / WebP, the rest
  as a download under a sandbox CSP.
- **Toolchains**: mise in the image with `MISE_DATA_DIR` on `data/tools` (create it before the
  first `up` on Linux, or it is root-owned), PHP from sury, docker CLI + compose. The agent
  installs what a checkout needs itself. Test services run in a `docker:dind` sidecar (compose
  profile `docker`, `COMPOSE_PROFILES=docker`, TLS, `DOCKER_MEMORY` 8g, workspaces mounted at the
  same path), never the host's socket; `TaskService` stops what a task started unless another
  running task's project owns it. Under `yarn dev` only the factory's own mise is listed or pruned.
  The Claude CLI is a native binary, so the shims never change the node it runs on.

### Model providers (1.3.0+)

- `data/config/providers.yaml`: endpoints besides the subscription. `kind: anthropic` speaks
  `/v1/messages` (Ollama, vLLM, OpenRouter), `kind: openai` speaks chat completions (OpenAI,
  Gemini, Groq) through `gateway/translate.ts`. Each has `token` (the name of the `.env` variable
  with its key; never a factory secret), `models`, `default`, `small`, `concurrency`, `light`,
  `mcp:` and an optional CA (`data/config/certs/<provider>.pem`, added to the CA store at once).
- A task's provider comes from its schedule, the agent it runs as (`provider:` +
  `provider_model:`; `model:` stays a CLI alias so the agent still works as a sub-agent), or the
  conversation (Chat selector, `/model provider:model`; a change forgets the session).
- The CLI is pointed at `/gateway/<name>` with a per-provider bearer (`gatewayToken(name)`, HMAC of
  a per-start secret) and no Claude credentials; the gateway adds the real key, so keys never
  reach an agent. A provider's `mcp:` servers are offered only to its tasks, through the gateway;
  a subscription task never connects to the box.
- **Light mode** (default): `--system-prompt` = the agent's body or `data/claude/light-system.md`,
  six built-in tools, `--disable-slash-commands`, `--strict-mcp-config`; a schedule on such a
  provider embodies its `agent:` instead of delegating. Provider tasks have no window share;
  `pausedUntil`, auto-continue and soft-stop apply to subscription tasks only.
- **Delegation** (1.4.0): an agent file with `provider:` is a role a subscription orchestrator
  hands work to with `mcp__factory__delegate` (`TaskService.delegate`); `Agent(<role>)` is denied
  in every subscription session so the role never runs on Claude. The role is a child task
  (`parent_id`, source and hidden conversation `delegate`) in `data/inbox/<parent chat>/delegate/
  <child>/`; it borrows the waiting parent's slot, dies with the parent, and a repeated call with
  the same agent + prompt (a resumed parent) joins it. A provider that does not answer, fails
  mid-run, or is not in the project file's `providers:` list → the role runs on the subscription
  with the orchestrator's model (`fallback:` alias, or `none` to report instead). Owner's rule:
  a dead box must never break the task.
- No money for providers yet (owner's open call). A project delegates only to providers its file
  lists, so code that must not leave for a given box never does; `docs/SELF_HOSTED_LLM.md` is the
  forker's guide to such a box.

### MCP

- Three layers: the repository's `.mcp.json` (loaded from the cwd without approval in `-p`; a
  project file's `mcp:` list turns the others off via `--settings disabledMcpjsonServers`, since
  an allowlist does not work in `-p`), the owner's `data/config/mcp.json` passed with
  `--mcp-config` to every session, and `mcpServers:` in an agent's frontmatter for role-owned
  tools. Secrets only as `${VAR}` from `.env`; `${VAR}` is **not** expanded in frontmatter (a stdio
  server inherits the CLI's environment instead).
- Role-owned servers: `mcpServers:` in an agent file is a **list** (a bare name or
  `- name: { type, command, … }`); the server starts for that sub-agent only. The call is still
  denied in `-p` unless settings allow `mcp__<server>`, so `TaskService.sessionSettings` adds an
  allow rule for every server declared in `data/claude/agents/*.md`. The agent form does not edit
  `mcpServers:`; its tool picker lists the servers sessions have seen, so "a ClickUp agent" is a
  role with that server ticked. Sub-agents otherwise get data from the orchestrator, not MCP.
- The **registry** (`meta` `claude.mcp.registry`): every server the CLI ever reported, with
  `source` (connector / plugin / project:<slug> / factory / provider:<name>), last status and
  `target` URL; fed by init events and `POST /api/mcp/refresh` (`claude mcp list`, ~10 s, the only
  way to see servers that need authentication). A project / factory server with a connector's URL
  is folded into the connector (the CLI drops it anyway).
- OAuth sign-in: Settings → MCP → Authorize runs `claude mcp login <name> --no-browser` in the
  factory under a pty (`script -qfec` in the image, a python pty loop on macOS); connector URLs
  finish on claude.ai, a project's server waits for the redirect URL pasted back. Console fallback:
  `docker compose run --rm -it -w /data/workspaces/<repo> supervisor claude mcp login <name> --no-browser`.
  The URL + paste flow in the container is the proven way to authorize anything OAuth.
  Plugins and the owner's own `mcp.json` servers get no button (`claude mcp login` does not list them).

### Telegram

- Optional (`TELEGRAM_BOT_TOKEN` empty = web-only). Unknown `/commands` never reach the agent.
- **A new chat per message** (`/mode fresh`, the default since 1.4.0, `meta` `telegram.mode`):
  a message without a reply starts a new conversation, because the owner's skills are
  self-contained and an old session only costs tokens. A reply to any remembered message (the
  bot's or the owner's own; `telegram_messages`, 180 days) continues that conversation; a reply
  whose conversation is gone starts a new one with the replied text quoted. The chat's **topic**
  (`telegram_chats`) is the last conversation touched: an open question there takes a plain
  message as its answer, a topic with no task yet (after `/new`) takes the next message, `/stop`
  and `/status` act on it (`/stop` as a reply: that chat). `/new <project>` and `/model
  <provider>:<model>` set the chat's defaults for new chats (`meta` `telegram.chat.<id>`).
  `/mode thread` is the old behaviour: one conversation until `/new`, a reply switches and sticks.
  A question from a task that is not the topic says "reply to this message".
- **Chat titles**: a new web / Telegram chat on the subscription is named by one Haiku call
  (`TaskService.nameConversation`: `--system-prompt`, `--tools ""`, `--strict-mcp-config`,
  `--no-session-persistence`, ~1k tokens), one at a time; the first line stays as the title until
  then, on failure, or when the owner renamed it. `CHAT_TITLES=off` turns it off; tests and e2e
  run with it off.
- The footer names the task's project and the windows with the task's share, not turns / tokens
  (those stay on the task page). The bot marks a conversation read only once delivery succeeded.

### Schedules

- **Files, not rows**: `data/config/schedules/<name>.md`, because the body is both the instruction
  for every run and the agent's memory between runs, which the agent edits itself. The store keeps
  only `schedule_runs` (last 1000 per schedule) and `seen_items`.
- A firing without a prefilter always starts a task; with one, only new items do (zero tokens on
  an empty poll). A poller's first cron firing marks what exists as seen (`first_run: skip`; the
  seeding mark lives in `meta`, so "Forget seen items" really hands everything over). An item
  whose key changed (`id@changetime`, `pr@sha`) is handed over as "seen before, changed since".
  Run now always hands over.
- A schedule with `agent:` on the subscription runs **as** that agent (`claude --agent <name>`,
  1.4.1): its prompt, tools, `maxTurns:` and `model:` (a schedule's `model:` pins it; none or
  `inherit` there leaves it to the agent file, whose `inherit` follows the orchestrator), no
  orchestrator that only spawns it and relays the report (~30 % of a run, measured on geometki).
  Still spawned the old way: an agent with neither `Edit` nor `Write` (it could not keep the notes)
  and one the project's checkout shadows in `.claude/agents`. The run's events count as the agent's
  in the Audit log (`COALESCE(e.agent, t.agent)`, which also puts a delegated role's work under the
  role). The factory's CLAUDE.md still loads under `--agent` (`omitClaudeMd` is for sub-agents
  only).
- One run at a time per schedule; cron firings yield to the windows (`SCHEDULES_SOFT_STOP`,
  default 85 %), manual ones do not. Missed minutes: within `SCHEDULES_LATE_MIN` (5) run late,
  older ones are recorded as `missed` and told in Telegram, **never caught up** (owner's call).
  `once: true` switches the file off after queueing. A `cron` task's question is answered for the
  owner after `SCHEDULES_ASK_TIMEOUT_MIN` (120): permission → deny, question → "decide by the
  instructions".
- The form asks for one cron field (read back in words by `GET /api/schedules/cron`); the zone is
  `TIMEZONE` in `.env` (empty = UTC), which is also where "today" starts for the stats. `tz:` /
  `window:` in a file are honoured but not offered. The file routes refuse a save older than the
  file (409 "changed on disk") since the agent edits schedules every run.
- Mail has no deterministic prefilter yet (Gmail lives in the session as a connector): a mail
  schedule is a prompt-type one at a coarse cadence. Trac is polled over HTTP from the supervisor
  (`TRAC_URL`, `TRAC_USER` / `TRAC_PASSWORD` or `TRAC_COOKIE`). Start every schedule with
  `action: report` and graduate it.

### Hosts, GitHub, security

- **Hosts are shared** (like an IDE's SSH configurations): `data/config/hosts.yaml` holds each
  connection (`name`, `ssh`, optional `key` = file name in `data/secrets/ssh`); a project or
  schedule refers to `- host: <name>` and adds its own `path` and `notes` (those are the project's,
  never the host's). Host keys live in `data/config/known_hosts` (`data/secrets` is read-only) and
  are trusted from the UI after keyscan + fingerprint confirmation. Keys are never read by the
  API; passwords are not supported. Host work is read-only by rule. Branches are `feature/…` /
  `fix/…` by task kind.
- GitHub auth = fine-grained PATs, never mounted SSH keys: `GH_TOKEN_<OWNER>` per repository owner
  (login upper-cased, `-` → `_`), `GH_TOKEN` as the fallback; `docker/gh` and
  `docker/git-credential-owner` resolve the owner from `origin`.
- **Web sign-in** with `WEB_AUTH_PASSWORD`: session cookie `pf_session` (hash in `web_sessions`,
  sliding `WEB_SESSION_DAYS`), idle timeout `WEB_SESSION_IDLE_HOURS` (8) where only requests the
  SPA marks `x-factory-active: 1` count as use (so a tab left open overnight is signed out),
  lockout after `WEB_LOGIN_MAX_FAILURES` within `WEB_LOGIN_LOCK_MIN` per address (four times as
  many from anywhere lock everyone), every attempt logged and told in Telegram. The client address
  is the socket's unless `WEB_TRUST_PROXY=1`. Basic auth still works for scripts. Without a
  password the API answers only to localhost `Host` names plus `WEB_ALLOWED_HOSTS`; both modes
  refuse a foreign `Origin` on mutating requests, bodies over 2 MB (attachments: 20 MB), and send
  `no-store` + secure headers.

### Product rules

- **No money in the UI or Telegram**: tasks report tokens (cache included) and their share of the
  5-hour window; windows come from the CLI's `rate_limit_event`, refreshed by every task plus an
  explicit Haiku probe. No `--max-budget-usd`: the CLI told the model its remaining dollars and
  the agent cut work short. `cost_usd` stays in the DB for the record. A task's tokens are the sum
  of its `llm` events when that exceeds the CLI's `result` (which undercounts background
  sub-agents); output tokens are still under-recorded.
- **Token hygiene**: `Explore` is overridden with `model: haiku`; agents carry `maxTurns`,
  read-only ones `effort: medium`; reviewers / triagers / email agents `omitClaudeMd: true` and a
  Budget section (a sub-agent's cost is turns × growing context, ~95 % cache reads); bulky input
  goes by path; a sub-agent's report is the result. Reviewer `effort` stays default on purpose.
- Agents, skills and projects live only in `data/` (gitignored); `templates/` and `presets/` are
  the install-time seed. What an agent did, including edits to its own files, is the Audit log
  (built live from stream-json, never from transcripts after the fact).
- **UI**: light, Guild.ai-like (paper background, dot grid, mono font, pastel pills, icon tiles)
  plus a dark theme on the same tokens (`:root[data-theme='dark']`; never write a literal `#fff`
  on an ink or red surface). No UI framework. Icons are `lucide-react`, mapped once in
  `components/Icon.tsx` (the same icon for the same concept everywhere); a tile never changes size;
  agents get a pixel mascot. **One badge per sidebar item**: Chat shows unread (green) > waiting
  (amber) > running (blue), never two. No blinking title. External links in rendered Markdown open
  in a new tab, links into the factory stay.

## Next

1. Schedules: an IMAP prefilter; whether the Trac prefilter needs `/login` is unverified.
2. From `docs/LANDSCAPE.md`: worktree per project for parallel tasks, "Always allow" rules,
   `POST /api/tasks/fire`, "continue in chat" for a laptop session, Merge from the UI, files back
   to the chat, budgets per agent / project, audit export.
3. Providers: tokens moved off the subscription on the Overview, the delegation line in Telegram,
   the 1.3.0 review follow-ups (`docs/plans/providers.md`).
4. Toolchains: a weekly prune schedule, `data/docker` size in Health, toolchains in `/status`.
5. Hardening: backups of `data/`, README for forkers, `useBlocker` for browser back, one shared
   status poll, CodeMirror.
