# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Pocket Factory is a **self-hosted layer over Claude Code for developers**: the **unmodified Claude
Code CLI** running in Docker Sandboxes (a microVM per project) on the owner's own server, driven
from Telegram and a small web control plane in a Docker container. The tagline is the product: *an agent becomes truly autonomous the moment
you close your laptop lid*. Four things it adds on top of the CLI, in this order of importance:

1. **Autonomy** — tasks arrive from Telegram (text, voice) or the browser, queue, run as `claude -p`
   sessions in the owner's real checkouts, continue across messages, survive restarts.
2. **Control over what agents do** — the Audit log (every model call, tool call, file edit,
   sub-agent, per agent and project), rendered transcripts, tokens and subscription windows.
3. **Management** — agents, skills and projects as Markdown files edited in the UI or by the agent
   (project files only in the UI: they are read-only in a sandbox);
   presets; live model and tool lists.
4. **Pipelines** — skills chaining sub-agents into repeatable flows; routines (an agent, its
   instructions, a pipeline of steps and schedules).

Concept, use cases and security model: `docs/SPEC.md` (§4.4 session lifecycle and §8 security are
the load-bearing parts). Deploying a release and the host's sandbox setup: `docs/DEPLOY.md`. History of what shipped: `CHANGELOG.md` and git log.

Owner: Misha Topchilo. Single-owner tool; a fork uses the forker's own subscription and bot.

## Commands

```bash
yarn install                 # Yarn 4 workspaces (corepack)
yarn typecheck               # tsc --noEmit for all workspaces
yarn build                   # supervisor → supervisor/dist, web → web/dist
yarn dev                     # supervisor + API on WEB_PORT (:8080 by default) on the host (reads .env itself, CLAUDE_CONFIG_DIR=data/claude)
TELEGRAM_BOT_TOKEN= yarn dev # web-only: use this while the container runs, or Telegram answers 409 to both pollers
yarn dev:web                 # Vite dev server on :5173 proxying /api → WEB_PORT from .env
docker compose up -d --build # build image + (re)start the supervisor container
docker compose logs -f supervisor
sbx exec pf-factory claude -p "Reply with exactly: OK" --model haiku --max-turns 1   # auth smoke test (on the host)
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
against the container on `WEB_PORT` from `.env` (:8000 on the owner's laptop; :8080 is taken there).

## Layout

- `supervisor/src/` — TypeScript, ESM (`"type": "module"`, NodeNext → import with `.js` suffix)
  - `index.ts` bootstrap (loads `.env`, wires everything); `config.ts` env parsing
  - `store/` SQLite via `node:sqlite` (no native build); migrations in `db.ts`
  - `tasks/service.ts` — **the session manager**: one queue for all channels, spawn `claude -p` per
    task, one running task per conversation, `MAX_CONCURRENT_SESSIONS` overall; emits `task` /
    `event` for Telegram delivery and SSE. Also: questions / permissions (`tasks.ask`), restart
    recovery, auto-continue after a limit, provider env, the factory MCP's `preview` — see Decisions
  - `claude/runner.ts` starts `claude -p` through an executor with stream-json on stdin and stdout, surfaces text /
    tool_use / tool_result, `llm` (one per model call), `agent` (sub-agent start / end from the
    CLI's `task_started` / `task_notification`), `limits` and the final `result`
  - `bot.ts` grammY bot (text, voice, photos / documents), `stt/groq.ts` Whisper,
    `telegram/view.ts` the bot's messages as views (text / buttons / footer blocks → a rich
    message with `<tg-button-row>`, else HTML + inline keyboard), `telegram/routinesMenu.ts` the
    routines list and cards, `telegram/draft.ts` the live draft under a running task,
    `telegram/send.ts` the agent's reply (rich Markdown, chunked HTML fallback),
    `telegram/format.ts` Markdown → Telegram HTML with plain-text fallback
  - `telegram/webNotify.ts` — a `web` task's reply unread after `TELEGRAM_WEB_NOTIFY_MIN` (default
    2), or its question still open, goes to Telegram; the chat's topic switches to that thread and
    the task is escalated (its next questions and reply go at once). Timers live in memory
  - `files/catalog.ts` agents / skills / projects / routines as Markdown+frontmatter (a skill and a
    routine are folders: their other files through `folderFiles` / `writeFolderFile`);
    `files/hosts.ts` shared SSH hosts; `files/knownHosts.ts`; `files/inbox.ts` attachments;
    `files/providers.ts`; `sessions/transcripts.ts` indexes Claude Code JSONL; `presets/`
  - `routines/` — `spec.ts` (frontmatter: `triggers:`, `steps:`), `cron.ts` (dependency-free five-field
    matcher with zones, `nextRun`, `startOfDay`), `steps.ts` (the pipeline: scripts and sources in
    their process groups, a result per step, `runOneStep`), `scripts.ts` (the file a step runs and
    its header: description, `secrets:` / `vars:`), `sources.ts` (`github-prs`, `trac`,
    `parseItems`), `service.ts` (the scheduler, 20 s tick)
  - `secrets/vault.ts` — Settings → Secrets and variables: `data/vault/secrets.json` (0600),
    scoped values into `agentEnv(scope)`, `redact()` masks secrets in what the store keeps
  - `sandbox/` — `sbx.ts` (typed wrapper over the sbx CLI, injectable runner), `executor.ts`
    (`LocalExecutor` spawns here, `SbxExecutor` runs `sbx exec` with env by name and a `PF_RUN`
    mark per run; `collect`), `manager.ts` (`SandboxManager`: `pf-<slug>` per project made and set up
    on first use, network rules, approvals, idle stop, Reset, `status()` from a cache refreshed in
    the background so a dead daemon never stalls `/api/status`), `network.ts` (what a project's
    sandbox may reach), `previews.ts` (one preview per project, its key, publishing, TTL)
  - `gateway/` — the provider gateway (`/gateway/<name>`, outside `/api`), `translate.ts`
    Anthropic Messages ↔ OpenAI chat completions, streaming included; MCP pass-through;
    `factory.ts` the factory's own MCP server per task (`/factory/<task>/mcp`, tool `delegate`)
  - `sharing/` — `zip.ts` (a dependency-free ZIP writer / reader: no links, no paths that climb out,
    size limits), `bundle.ts` (the preset layout as a bundle: read a ZIP / a folder / one Markdown
    file, install the picked items, export with masked secrets); `/api/share/export` and
    `/api/share/import` in `web/routes/sharing.ts`; presets install through the same code
  - `git/changes.ts` — the Changes panel (start head recorded before the CLI starts, measured at
    the end of every attempt: branch, base, files / lines, uncommitted, `gh pr list --head`)
  - `claude/mcpLogin.ts` — `claude mcp login --no-browser` under a pseudo-terminal; `claude/models.ts`
  - `web/` Hono server: `auth.ts` sign-in, `routes/*` (`/api/*`), `preview.ts` (`/preview/<project>/…`
    proxy and its WebSocket upgrades), serves `web/dist`
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
  - `components/Editor.tsx` shared list+form for agents / skills / projects / routines (an
    `aside` slot shows live state above the form, `overview` the page before one is picked).
  - `components/CodeEditor.tsx` — CodeMirror 6 (`lib/codemirror.ts`, a lazy chunk; a textarea under
    jsdom); `components/Files.tsx` a folder's files (a list; a file opens in a window: editor, CSV table, upload) for skills and
    routines; `components/Pipeline.tsx` a routine's pipeline as a graph of step cards (GitHub
    Actions style), a step edited in a window on a draft (Apply puts it into the form); `components/Secrets.tsx` the
    Secrets and variables section, `SecretDialog` and the `NeedsLine` of a step card.
  - Lists are keyset-paged (`lib/usePaged.ts` + `LoadMore`) with a `(timestamp, id)` cursor sent
    as `before` + `before_id`; the audit log pages by event id and the server says `has_more`.
    Polling refreshes only the first page.
  - `components/AssistantTurn.tsx`: one task = a dark user bubble + the agent's turn card, tool
    runs folded into "N steps". The thread auto-follows only at the bottom. Code highlighted with
    `highlight.js` (`lib/highlight.ts`); an Edit renders as a diff, Write as the file, Bash as the
    command. Markdown / text files stay plain on purpose.
  - Other parts: `Ask.tsx` (questions / permissions), `Attachments.tsx`, `Changes.tsx`,
    `Sandboxes.tsx` (Settings → Sandboxes, a project's sandbox card), `Providers.tsx` + `ModelPicker`, `McpLogin.tsx`, `Auth.tsx`; `lib/drafts.ts`
    (unsent text per conversation), `lib/favicon.ts` (badge on the favicon), `lib/notify.ts`
    (desktop notifications, https / localhost only), `lib/theme.ts`, `lib/activity.ts`.
- `templates/claude/` — seeded into `data/claude/` on **every** container start with `cp -n`: new
  files appear, edited files are never overwritten. On the host, copy by hand the same way.
  Prose in agent / skill / project Markdown is not hard-wrapped (one line per paragraph or list
  item): the UI editor wraps it, previews render with `breaks: false`.
  `node scripts/reflow-md.mjs <files>` unwraps a file that was written wrapped.
- `presets/<name>/` — `preset.json` + `agents/` `skills/` `routines/` `projects/` (the bundle layout an
  export writes), installed from the UI.
  Installed files are one flat namespace: files shared by presets (`fullstack-feature`,
  `web-developer`) must stay byte-identical across them.
- `docker/` — `entrypoint.sh` (seeds the data directory, git identity + `safe.directory '*'`, links
  `secrets/ssh` → `~/.ssh`, checks the sbx client), `gh` wrapper, `git-credential-owner`,
  `gh-token` (also copied into every sandbox's `~/.local/bin`)
- `docs/brand/logo.png` — the only logo source (no hand-drawn SVG); `web/public/` holds the cuts
  made from it with Pillow (`apple-touch-icon` on an opaque square, `icon-maskable-512` in the 80 %
  safe zone) and the PWA manifest
- `data/` — runtime state, gitignored, bind-mounted at its host path (`DATA_DIR`); `WORKSPACES_DIR`
  in `.env` points the container, the sandboxes (and `yarn dev`) at the owner's existing
  repositories. `docker-compose.override.yml` is local and untracked (bot off): never commit it

## Versioning and releases

`MAJOR.MINOR.PATCH`: the major almost never moves, a minor adds something the owner can see or
use, a patch fixes or polishes. The version lives in the root `package.json` (the workspaces are
kept in step), is read by `supervisor/src/version.ts`, shown in the sidebar foot, in Telegram
`/status`, in `/api/status` `version` and in the start-up log. `CHANGELOG.md` is written **with**
the change, before the commit: newest first, `## x.y.z` with one `### Major | Minor | Patch
Changes` list (the part of the version that moved), **one line per change**, very short, in the
shape `Area: what changed for the owner` (`Routines: …`, `Telegram: …`, `Fixed: …`); no dates (the
tags carry them), no paragraphs, no implementation detail.

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
  The CLI is the one in Docker's agent image inside each sandbox, never patched; the supervisor's
  image has no CLI (`SANDBOX=local` is for `yarn dev`, unit tests and e2e only, owner 2026-10-19).
- Auth = the claude.ai login **of the sandboxes**: `/login` once in any sandbox on the host
  (`ssh -t <server> sbx run pf-factory`, press `c` to copy the long URL) is stored by sbx as the
  global `anthropic` secret; its proxy swaps the tokens of whatever `.credentials.json` the CLI
  reads for the real login, so the **claude.ai connectors** and plugins reach every `-p` session and
  no VM holds the token. The manager writes a placeholder `.credentials.json` into `data/claude`
  when it has none (the CLI wants the file). `CLAUDE_CODE_OAUTH_TOKEN` in `.env` must stay empty.
  The Docker account (`sbx login`) is a second login on the host; Settings → Sandboxes shows both.
- The supervisor never calls the Claude API with the owner's credentials: no model list (the
  editor offers the CLI aliases `sonnet` / `opus` / `haiku` / `fable` / `inherit`, which follow
  releases by themselves; a full id can still be typed), no `/api/oauth/usage`.
- **The orchestrator's model is a run-time setting**, not `.env`: `meta` `claude.model`
  (`claude/models.ts`, default `sonnet`), set by Telegram `/model <alias>` or Settings → Claude
  Code → Model; applies to the next task everywhere. Sub-agents keep their files' `model:`
  (`inherit` follows the orchestrator). A routine may pin `model:` (`tasks.model`). The limits
  probe stays on `haiku`.
- The CLI's environment is `process.env` minus the supervisor's own secrets (`PRIVATE_ENV` in
  `tasks/service.ts`: bot token, allowed ids, web auth, Groq key; `agentEnv` also strips every
  provider's `token` variable); GitHub tokens and MCP `${VAR}` secrets stay because the agent needs them.
  The vault's values in a run's scope are added on top (`agentEnv(scope)`: its routine, its project).
- Single language: TypeScript for supervisor, API and UI; no Python service. The web UI is a
  Vite SPA served by the supervisor (one container, no SSR).

### Sessions and tasks

- Every task is a one-shot `claude -p`; the conversation keeps the session id and the next task
  resumes it. A session the CLI cannot find ("No conversation found") is forgotten and the task runs once more fresh; any other early failure keeps it. A
  session cannot follow a cwd change: when the transcript's directory slug differs from the cwd,
  a fresh session starts.
- **Sandboxes** (1.7.0; host setup, the upgrade and how sbx behaves: `docs/DEPLOY.md`): one persistent
  Docker Sandbox per project (`pf-<slug>`; `pf-factory` for project-less chats, titles, the limits
  probe, `claude mcp list`), made on first use with the checkout (or the workspaces root),
  `data/claude`, `data/config` (ro, with `data/config/routines` rw inside: the supervisor trusts
  project paths / networks, provider URLs and CAs from it; an older sandbox with it rw is made again),
  `data/inbox` and `data/secrets/ssh` (ro) mounted **at their host paths** (the container mounts them at the same paths, `DATA_DIR`, so cwd, attachments and
  transcripts mean the same everywhere; `/data/<x>` links inside point at them for the files that
  name the old paths). `CLAUDE_CONFIG_DIR` = the host path of `data/claude`. Setup once per
  sandbox: the gh / git wrappers into `~/.local/bin`, git identity and credential helper, `~/.ssh`,
  the factory's known_hosts. Every run is `sbx exec` with the env passed **by name** (`-e NAME`,
  values in the client's env, never argv) minus the host's own names, and `PF_RUN=<id>`: killing
  `sbx exec` does not reach the VM, so a stop signals the run's processes by that mark, and the
  first use of a running sandbox after a restart kills every `claude` with a `PF_RUN` left (their
  dev servers stay: an open preview may need them). The manager starts a stopped sandbox itself
  and refuses a cwd it does not mount (a moved checkout: Reset). A sandbox that will not start
  (`LaunchError`) re-queues the task a minute later, three times, keeping its session. A project
  named `factory` gets `pf-factory-project`; names that slug alike (`my_app` / `my-app`) get a hash
  suffix, all but the one that is its own slug. A checkout outside the workspaces is refused, and
  `SANDBOX=sbx` refuses to start without `WEB_AUTH_PASSWORD`. Vault names that stay on the host are refused. Idle `SANDBOX_IDLE_MIN` → stopped;
  removed only by the owner's Reset. Routine scripts run in the routine's project sandbox;
  `github-prs` / `trac` sources and the Changes panel's git / gh stay on the supervisor.
- **Network per sandbox**: sbx's `balanced` policy plus the factory's own rules, tracked by id in
  `meta` `sandbox.rules.<name>` (the owner's rules never touched): the supervisor's port
  (`localhost:<port>`, how the proxy names `host.docker.internal`), a project file's `network:`,
  its SSH hosts, its routines' Trac sites. A blocked request (`sbx policy approval ls`, polled
  every 5 s while a run goes on) reaches Telegram (`w|a|<id>` / `w|d|<id>`), the project page and
  a badge beside Settings; Allow adds the host to the project file. Dismissed without asking: the
  CLI's telemetry (`*.datadoghq.com`; runs also get `DISABLE_TELEMETRY`) and sbx's `cidr` twin of
  every TCP connection to an IP, which shows even when the `ip:port` rule let it through and which
  an Allow never settles (a refused connection raises its `ip:port` request too).
- **Preview** (one per project, owner 2026-10-19): the factory MCP's `preview({port,
  strip_prefix})` publishes the port on `PREVIEW_BIND` (the docker bridge) from `PREVIEW_PORTS`;
  `/preview/<project>/` needs the sign-in and redirects to `/preview/<project>/<key>/`, under which
  the proxy needs no cookie (a page under `CSP: sandbox` without `allow-same-origin` sends none
  with its module scripts and fetches): the random per-project key is the access, a Reset rotates
  it. Responses get open CORS and `cross-origin` CORP, `Host: localhost:<port>` goes upstream, the
  `pf_session` cookie never does. `$PREVIEW_BASE` is in every run of a project. Telegram gets Open /
  Stop (`pv|stop|<project>`); `PREVIEW_TTL_HOURS` ends one.
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
  `bypassPermissions` (the sandboxes) only `AskUserQuestion` arrives; in `acceptEdits` / `default`
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

### Model providers (1.3.0+)

- `data/config/providers.yaml`: endpoints besides the subscription. `kind: anthropic` speaks
  `/v1/messages` (Ollama, vLLM, OpenRouter), `kind: openai` speaks chat completions (OpenAI,
  Gemini, Groq) through `gateway/translate.ts`. Each has `token` (the name of its key; never a
  factory secret), `models`, `default`, `small`, `concurrency`, `light`, `mcp:` and an optional CA
  (`data/config/certs/<provider>.pem`, added to the CA store at once).
- **`.env` vs Secrets** (owner, 1.7.0): `.env` and `.env.example` hold only the factory's own
  secrets (bot token and allowed ids, web sign-in, Groq), the GitHub tokens (the supervisor's
  Changes panel and `github-prs` read them too, until they go through the sbx proxy) and settings.
  Everything a provider, a routine or an agent needs (provider keys, the Trac login, a script's
  tokens) is a dynamic secret or variable of the vault, set from the UI; never add such a name to
  `.env.example`.
- **Provider keys live in the vault only** (1.7.0, owner's call: no `.env` per provider): a secret
  with the access "model providers only" (`provider: true`), picked in the provider form beside
  New secret (the same `SecretDialog`). Only the gateway and the form's test read it; never in
  `envFor` / `reaches`, whatever the scope; masked like any secret; a name stays a provider key or
  a run's entry for life, and a provider may not name a run's secret. `.env` is not read for keys:
  `migrateEnvKeys` moves a provider's key from `.env` into the vault once at start (DEPLOY.md).
- A task's provider comes from its routine, the agent it runs as (`provider:` +
  `provider_model:`; `model:` stays a CLI alias so the agent still works as a sub-agent), or the
  conversation (Chat selector, `/model provider:model`; a change forgets the session).
- The CLI is pointed at `/gateway/<name>` (from a sandbox through `SANDBOX_FACTORY_URL`) with a per-provider bearer (`gatewayToken(name)`, HMAC of
  a per-start secret) and no Claude credentials; the gateway adds the real key, so keys never
  reach an agent. A provider's `mcp:` servers are offered only to its tasks, through the gateway;
  a subscription task never connects to the box.
- **Light mode** (default): `--system-prompt` = the agent's body or `data/claude/light-system.md`,
  six built-in tools, `--disable-slash-commands`, `--strict-mcp-config`; a routine on such a
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
  tools. Secrets only as `${VAR}` from the run's environment (a vault secret in scope; `.env` only for the factory's own names); `${VAR}` is **not** expanded in frontmatter (a stdio
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
  finish on claude.ai, a project's server waits for the redirect URL pasted back. It runs in the sandbox that uses the server (`sbx exec -it` under the pty); console fallback on the
  host: `sbx exec -it -w <checkout> pf-<project> claude mcp login <name> --no-browser`.
  The URL + paste flow is the proven way to authorize anything OAuth.
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
- **No forum topics** (owner's call, 1.6.0: the clients handle a bot's private-chat topics badly):
  the chat is flat, nothing sends `message_thread_id`.
- **Buttons inside messages** (1.6.0): every message of the bot with buttons is a *view*
  (`telegram/view.ts`: text / buttons / footer blocks) sent as a rich message (`sendRichMessage`
  with `html`, `<tg-button-row>`, Bot API 10.3) and edited in place with `editMessageText` +
  `rich_message`; when Telegram refuses the rich form the same view goes as classic HTML with an
  inline keyboard. The agent's reply is rich *Markdown* with the footer and the button rows
  appended as HTML. Telegram never edits a message sent with `force_reply`, so only a question
  without options asks for a reply; a stale tap gets a toast saying the answer it already has. Callback data: `a|task|q|opt` answers, `p|task|allow|deny`, `r|action|key[|l]`
  routines (`|l` = tapped in the list, redraw the list), `c|task` continues a failed chat whose
  session is kept (the turn limit), `n|project` new chat, `m|alias`,
  `md|mode`, `s|stop|task[|l|c]` (stay on the list / card), `u|refresh`, `v|<view>` menu. A
  routine button is acknowledged *before* the routine fires (a slow step outlives Telegram's
  callback window). The live draft (`telegram/draft.ts`) shows steps and the tool, never prose,
  and `end()` resolves after its last request, so the reply never lands under a ghost draft.
- **Chat titles**: a new web / Telegram chat on the subscription is named by one Haiku call
  (`TaskService.nameConversation`: `--system-prompt`, `--tools ""`, `--strict-mcp-config`,
  `--no-session-persistence`, ~1k tokens), one at a time; the first line stays as the title until
  then, on failure, or when the owner renamed it. `CHAT_TITLES=off` turns it off; tests and e2e
  run with it off.
- The footer names the task's project and the windows with the task's share, not turns / tokens
  (those stay on the task page). The bot marks a conversation read only once delivery succeeded.

### Routines

- A **routine** = a pipeline (`steps:`) and when it runs (`triggers:`); the body is the instruction
  for the agent step and the agent's own notes. **Files, not rows**: a folder
  `data/config/routines/<name>/` with `ROUTINE.md` (frontmatter + body), `scripts/` and `data/`
  (owner, 1.6.0: everything a routine runs is visible and editable in its page; a flat `<name>.md`
  still reads and moves into its folder on the next save or file write), because the body is both the instruction for every run and the agent's memory between runs, which
  the agent edits itself. The store keeps only `schedule_runs` (last 1000 per routine) and
  `seen_items`; their table and column names, the conversation key `schedule:<name>` and the meta
  keys predate the rename on purpose (history and threads stay). The task source is `routine`
  (`cron` in rows before 1.5.0). On start `config/schedules/` is moved to `config/routines/` once
  (`migrateSchedulesDir`); a name present in both stays put and is logged.
- **Prefilters are gone (1.6.0, owner's call)**: everything a run does before the agent is a step of
  the pipeline. `steps:` is a list of `- run: <bash>` (optional `name:`, `cwd:` relative to the
  checkout, `timeout_s:` 300, `items: true` makes it a source, `new_only:`), `- github-prs: {repo,
  filter, mine, drafts, new_only}`, `- trac: {url, query, on_change, max, new_only}` and, last and
  at most once, `- agent: <name | orchestrator>` with `skill:`. `routines/steps.ts` runs the
  pipeline (`bash -c` in its own process group, in the sandbox marked as one run; SIGTERM then SIGKILL on timeout; env = the agent's
  plus `ROUTINE`, `ROUTINE_FILE`, `ROUTINE_DIR`, `PROJECT`, `PROJECT_DIR`, `SKILL_DIR`, and the vault's
  values in its scope); `routines/sources.ts` has
  the built-in sources and `parseItems`. A script's stdout (16k cap) lands in the prompt under
  "Step outputs"; a source's items under "New since the last run" after dedup. A failing step is an
  `error` run with its last lines, no task, unless it says `continue_on_error: true` (Continue if it
  fails on its card, like GitHub Actions): then it is marked failed, its error goes to the agent as its
  output and the run goes on. `enabled: false` on a step (Step on, unticked) passes it by in a run;
  Run on its card still tries it. A run's row is written when its steps start (`running`, the steps so
  far with the current one marked, a `progress` event, no Telegram notice) and its end updates the same
  row; the routine's thread is made then too, so the page and the thread show the steps before the task. Every source empty → `empty`, no agent. No agent step →
  the run is `done` and its note is the steps' output (told in Telegram). A step's scripts belong in
  the routine's folder (`"${ROUTINE_DIR}/scripts/x.sh"`); a skill keeps only the tools its agent
  calls. A script says what it is in the comment under the shebang and names what it reads
  (`# secrets: A B`, `# vars: C`): the step card shows both, with Set for what is missing. Each
  run keeps every step's result (`schedule_runs.steps`: ok, ms, 2 KB of output, masked).
  `POST /api/routines/<name>/preview` runs every step but the agent, `…/steps/<i>/run` one step
  alone (nothing recorded).
- `triggers:` is a list of `- schedule: <cron>`, each with an optional `tz:` / `window:` over the
  file's. Several still mean one run at a time; an empty list is a routine that runs only by
  **Run now** (always available, never a trigger). The 1.5.0 shape still reads: `cron:` is one
  schedule, `- poll:` a schedule whose `prefilter:` becomes the first step (a source with
  `new_only`), `agent:` / `skill:` on top the agent step; the form writes `steps:` on the next
  save. A new-only source's first timed firing marks what exists as seen (`first_run: skip`; the
  seeding mark lives in `meta`, so "Forget seen items" really hands everything over). An item whose
  key changed (`id@changetime`, `pr@sha`) is handed over as "seen before, changed since". Run now
  always hands over; "Run with all" (`fire(…, { everything: true })`) hands the seen items over
  again.
- A routine whose agent step names an agent on the subscription runs **as** that agent (`claude
  --agent <name>`, 1.4.1; always since 1.4.2, owner's rule: the agent picked is what runs, never an
  orchestrator in between): its prompt, tools, `maxTurns:` and `model:` (the routine's `model:`
  pins it; none or `inherit` there leaves it to the agent file, whose `inherit` follows the
  orchestrator). The step's `skill:` (one of `data/claude/skills`) is given in the prompt, so the
  agent needs no Read. The frame ("Routine run") is the same for every agent: one without `Edit`
  simply keeps no notes (owner: flexible, give it the tool if it should). The run's events count
  as the agent's in the Audit log (`COALESCE(e.agent, t.agent)`, which also puts a delegated role's
  work under the role). The factory's CLAUDE.md still loads under `--agent` (`omitClaudeMd` is for
  sub-agents only).
- One run at a time per routine; timed firings yield to the windows (`ROUTINES_SOFT_STOP`,
  default 85 %), manual ones and scripts-only routines do not. Missed minutes: within
  `ROUTINES_LATE_MIN` (5) run late, older ones are recorded as `missed` and told in Telegram,
  **never caught up** (owner's call). `once: true` switches the file off after one run. A routine
  task's question is answered for the owner after `ROUTINES_ASK_TIMEOUT_MIN` (120): permission →
  deny, question → "decide by the instructions". The `SCHEDULES_*` names of an older `.env` are
  still read.
- The form, top to bottom: Pipeline (step cards: Script / GitHub pull requests / Trac tickets /
  Agent, the agent last), Instructions (the body), Schedule (one cron field, read back in words by
  `GET /api/routines/cron`, empty = Run now only; further `triggers:` in a file are kept and named,
  not edited: owner has no use for several; Run once as one checkbox under it), First run / Max items when a source is new-only, then
  below a line the rest, not folded (project, report to; hosts and `session:
  continue` only when the file has them: a project's hosts come with the project, a fresh session
  is the rule). Model / provider sit in the Agent step card, only for the orchestrator or when the
  file pins one (a named agent brings its own). Sections follow `DESIGN.md`. The
  zone is `TIMEZONE` in `.env` (empty = UTC), which is also where "today" starts for the stats.
  `tz:` / `window:` are honoured but not offered. The file routes refuse a save older than the file
  (409 "changed on disk") since the agent edits routines every run. `/api/routines/*` and
  `/routines` only: no aliases or redirects for the old paths (single owner, no outside scripts).
- **A routine's chat thread is a log** (owner's rule): project, provider and model are the routine
  file's, so the thread's head shows them as text with a link to the routine, the API refuses to
  change them or to take a message there (409) unless a run's question is open, and a run never
  reads the conversation's model. Telegram still continues the thread by a reply to a run's
  notice (that is how its questions are answered).
- Mail has no deterministic source yet (Gmail lives in the session as a connector): a mail
  routine is a schedule at a coarse cadence. Trac is polled over HTTP from the supervisor: the
  step holds the custom query's address as the browser has it (`url:`; no `TRAC_URL`, owner's
  call), the login is shared by every Trac step (`TRAC_USER` / `TRAC_PASSWORD` or `TRAC_COOKIE`, in Secrets,
  never in `.env`). Start every routine in its
  instructions with "look and report, change nothing" and graduate it.
- **No mode field** (1.6.0, owner's call): `action:` was only a line in the prompt and looked like a
  safety switch it never was, so what a run may do is written in its instructions. On start
  `migrateRoutineActions` moves an old file's `action:` into the first line of its body, once. A
  real read-only run would be deny rules in the session, not a field.

### Sharing (1.7.0)

- **One format for presets and sharing**: a ZIP in the preset layout (`sharing/bundle.ts`). Export:
  an agent, a skill or a routine from its page (a routine with its agent step's agent and skill by
  default, its `data/` only when asked: it may be personal), several on the Presets page. Import
  (Presets, Agents, Skills, Routines): such a ZIP, a repository download, a `.skill` file, or one
  Markdown file as a skill (or an agent); a preview lists each item (new / replaces yours, files,
  what its scripts declare and whether the vault has it) and installs only what is ticked.
- Owner's rules: **secrets and variables never travel** (the vault is not exported; a secret's value
  found in an exported file is masked); **a routine arrives switched off** (also from a preset);
  a routine whose agent, skill or project is missing is imported anyway, the form shows the default
  and the preview says so. Projects are never exported (paths, hosts, notes are the owner's).
- An agent and a skill go by their own `name:`; a replaced item keeps the files the bundle does not
  bring (a routine's data). Import bodies get the upload limit (20 MB); the ZIP reader refuses links,
  `..`, absolute paths, encryption, ZIP64 and more than 2000 entries / 8 MB a file / 64 MB in all.

### Hosts, GitHub, security

- **Hosts are shared** (like an IDE's SSH configurations): `data/config/hosts.yaml` holds each
  connection (`name`, `ssh`, optional `key` = file name in `data/secrets/ssh`); a project or
  routine refers to `- host: <name>` and adds its own `path` and `notes` (those are the project's,
  never the host's). Host keys live in `data/config/known_hosts` (`data/secrets` is read-only) and
  are trusted from the UI after keyscan + fingerprint confirmation. Keys are never read by the
  API; passwords are not supported. Host work is read-only by rule. Branches are `feature/…` /
  `fix/…` by task kind.
- **Secrets and variables** (1.6.0, owner's call: "as in GitHub"): set in Settings or from a step
  card, `data/vault/secrets.json` (0600, its own mount, outside `config/`). A secret is written and
  never read back by the API; a variable shows its value; a name keeps its kind for life. Scope:
  all, or chosen routines / projects (a chat outside them never gets it). A name in the vault wins
  over `.env`; the factory's own names, run variables and shell start-up names (`LD_PRELOAD`,
  `BASH_ENV`, `NODE_OPTIONS`, `CLAUDE_*` …) are refused. Secret values (6+ chars) are masked as
  `••••` in task prompts, results, events, run notes and step logs (the store's redactor) and in
  Run step output; every change is told in Telegram. Sessions get a deny rule on the vault's
  directory for Read / Edit; an agent with Bash in scope can still print a value it was given
  (scope is the protection). No encryption at rest (the key would sit beside it). An agent reads
  nothing itself: its skill's scripts do (`# secrets:` / `# vars:` in their headers), so a skill's
  page lists those names per routine running it (`GET /api/secrets/skills/<name>`) and the
  routine's agent step shows them as its needs.
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
- **UI**: the rules are in `DESIGN.md` (look, components, forms, badges, motion). No UI
  framework; agents get a pixel mascot.

## Next

1. Routines: trigger `api` (a per-routine token, `POST /api/routines/<name>/fire`, an optional
   payload handed over as an untrusted item; covers `POST /api/tasks/fire` too); an IMAP source;
   steps after the agent (publish what it wrote); renaming a routine's folder; a step's output as
   a live log while it runs; whether the Trac source needs `/login` is unverified.
2. From `docs/LANDSCAPE.md`: worktree per project for parallel tasks, "Always allow" rules,
   "continue in chat" for a laptop session, Merge from the UI, files back
   to the chat, budgets per agent / project, audit export.
3. Providers: the follow-ups in `docs/plans/providers.md`.
4. Sandboxes: the open checks of `docs/DEPLOY.md` (OAuth refresh over days, a reboot with the user
   unit), GitHub tokens and SSH keys through the sbx proxy instead of the env.
5. Hardening: backups of `data/` (`docs/plans/database.md`), `useBlocker` for browser back, one
   shared status poll.
6. From the 2026-10-19 review: the chat thread re-renders whole on every keystroke and event
   (memo + a separate composer); the task page refetches all events every 3 s; `beforeunload` in
   the file and MCP editors; page tests for Chat, Agents, Audit, Settings, Projects and the bot.
   UI simplifications waiting for the owner's call: `docs/plans/ui-review.md`.
