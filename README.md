# Pocket Factory

> An agent becomes truly autonomous the moment you close your laptop lid.

Pocket Factory is a **self-hosted layer over [Claude Code](https://code.claude.com) for
developers**. Claude Code on its own is a session in your terminal: it works while the laptop is
open and you are watching. Pocket Factory runs the unmodified Claude Code CLI on a server of your
own, takes tasks from Telegram or the browser, and turns those sessions into something you can
leave alone and still trust:

- **Autonomy** — send a task from the road, by text or voice; the agent works in your repositories,
  opens the pull request and reports back. Sessions continue across messages; tasks queue and
  survive restarts; when the agent has a question or needs a permission, it asks you in Telegram or
  in the browser and carries on with your answer.
- **Control over what agents do** — an audit log of every model call, tool call, file edit and
  sub-agent, attributed to the agent and the project; rendered transcripts; token and
  subscription-window accounting instead of made-up dollar figures.
- **Management** — agents, skills, projects and schedules are Markdown files with frontmatter,
  edited in the UI or by the agent itself; presets bundle them for sharing; models and tools are
  picked from what your subscription and CLI actually offer.
- **Pipelines** — skills such as `feature-to-pr` and `pr-review` chain sub-agents (developer,
  reviewer, …) into repeatable task flows; **schedules** fire tasks on a cron (down to a minute)
  behind a deterministic prefilter (a shell command, a GitHub or Trac query), so an empty poll
  costs no tokens, and the schedule file's body is the agent's memory between runs.

Single-owner by design. You log in to Claude Code with **your own subscription**, create **your own**
Telegram bot, use **your own** GitHub token, point it at **your own** repositories. Nothing is shared,
proxied or stored by anyone else: the transcripts stay on your server. See
[docs/SPEC.md](docs/SPEC.md) for the concept and roadmap.

## How it compares

Think of it as **Routines on your own box, for Pro and Max**: your checkouts and their MCP servers,
a cron from one minute, zero tokens on an empty poll, every tool call in the audit log, transcripts
that never leave your server, and it works behind an `ANTHROPIC_BASE_URL` proxy.

| | Pocket Factory | Remote Control | Agent View | Projects (cloud threads) | Routines |
|---|---|---|---|---|---|
| Keeps working with the laptop off | yes, on your server | no, needs the live process | no, a local daemon | yes, in Anthropic's cloud | yes, in Anthropic's cloud |
| Works in your real checkout with its `.mcp.json`, `CLAUDE.md`, `.claude/` | yes | yes | yes | no, a fresh clone | no, a fresh clone |
| Telegram, with voice and photos | yes | no, the Claude app | no | no, the Claude app | no |
| Queue that survives restarts | yes | no | jobs on disk, local | cloud | cloud |
| Questions and permissions from the phone | yes, web and Telegram | yes | local peek panel | yes | no, runs unattended |
| Schedules | files, 1-minute cron, prefilter, zero tokens when idle | no | no | a Routines tab | from one hour, every run costs |
| Audit per model call, tool call and sub-agent | yes | no | no | no | a run transcript |
| Where the transcript lives | your server | Anthropic | your machine | Anthropic | Anthropic |
| Behind an `ANTHROPIC_BASE_URL` proxy | yes | no | yes | no | no |
| Plans | any claude.ai login | Pro / Max / Team / Enterprise | Pro / Max | Pro / Max beta | Pro / Max / Team / Enterprise |

What it does not do yet: a worktree per task, merging from the UI, several providers (Codex,
OpenCode). [docs/LANDSCAPE.md](docs/LANDSCAPE.md) compares the
open-source neighbours too (Paseo, Happy, claudecodeui, the Telegram bridges, OpenClaw, Hermes) and
lists what is taken from each.

## What it does today

- **Telegram** — text and voice (Whisper on Groq) → `claude -p` in your workspaces → the reply,
  plus the task's project and how full the 5-hour and weekly windows are. Replies continue the
  same Claude Code session; reply to any message of the bot to switch to that conversation (a
  schedule's report, a question); `/new [project]`, `/stop`, `/status`, `/usage`, `/model`,
  `/schedules`, `/run <name>`. Telegram is optional: leave the token empty for a web-only factory.
- **Photos and files** — send a screenshot, a log or a PDF with the task, from Telegram (with a
  caption, or first and then the text) or the web (paperclip, paste, drop). The agent gets the
  file's path and opens it with the Read tool, which shows images and PDFs to the model.
- **Changes** — every task in a project records what it changed in the checkout. The task page
  shows the agent's report, the size and the branch, a **Create PR** button, the files by folder
  and the diff of a tapped file, readable on a phone; Telegram reports carry the same summary.
  Deleting a conversation deletes its uploaded files from the disk.
- **Questions and permissions** — `AskUserQuestion` and permission prompts reach you inside the
  run: a form in the browser, a message with buttons in Telegram, free text in either; the task
  waits with its session open and continues with your answer. A scheduled run's question
  unanswered for a while is settled by the file's instructions.
- **Task queue** — every channel goes through one SQLite queue; one running task per conversation,
  a configurable number overall; tasks survive supervisor restarts (a task interrupted mid-run is
  re-queued once and resumes its session). A task stopped by the subscription limit waits for the
  window to reset and continues by itself (`CLAUDE_AUTO_CONTINUE_HOURS`).
- **Web UI** — Overview (queue, subscription windows, tokens, health), Tasks, Chat with Claude Code
  from the browser with live output (unread and waiting badges, desktop notifications, drafts),
  Sessions (rendered Claude Code transcripts), editors for **Agents**, **Skills**, **Projects**
  and **Schedules**, **Presets**, an **Audit log** (every model call, tool call and sub-agent, per
  agent and project), Settings (Claude Code model, MCP servers with browser-driven sign-in, SSH
  hosts with host-key trust, Security). Installs as a PWA from the phone.
- **Factory files** — sub-agents `developer` / `reviewer`, skills `feature-to-pr` /
  `onboard-project`, one Markdown file per project (repo, branches, checks, tracker, hosts, MCP
  allowlist), one per schedule (cron, prefilter, instructions and the agent's own notes). The UI,
  the owner and the agent edit the same files; what the agent changes shows up in the Audit log
  as file events.
- **Toolchains** — the image carries `mise`, PHP with composer and the docker CLI. The agents
  install the runtimes a checkout asks for (Go, Node, Python … from its own version files) into
  `data/tools` before the checks; with `COMPOSE_PROFILES=docker` in `.env` the factory runs its own
  Docker daemon (a dind sidecar, state in `data/docker`), so a project's compose file brings up its
  database or the whole application for the tests, and what a task started is stopped when it ends.
  Settings → Toolchains lists versions, sizes and containers; nothing is installed on the host.
- **Presets** — shareable bundles under `presets/`: `fullstack-ts-go`, `fullstack-ts-php`,
  `pr-review`, `devops` (read-only server checks over SSH), `email-assistant` (Gmail drafts
  through the claude.ai connector, nothing ever sent). A colleague installs one with a click
  into their own factory.
- **Security** — the bot answers only allow-listed user ids; the web UI has a sign-in with lockout,
  revocable browser sessions and Telegram notices; the CLI's environment carries none of the
  supervisor's secrets; hosts are reached over SSH keys only, read-only by rule, with host keys you
  trusted from the UI; GitHub through fine-grained PATs per repository owner; PR bodies, tickets and
  mail are treated as data, not instructions.

## Quick start

Requirements: Docker, a Claude subscription, a GitHub fine-grained PAT for the repositories the
factory may touch (one per repository owner, since such a token belongs to a single user or
organization: `GH_TOKEN_<OWNER>`, with `GH_TOKEN` as the fallback). For Telegram: a bot token from
[@BotFather](https://t.me/BotFather) and your Telegram user id (ask
[@userinfobot](https://t.me/userinfobot)).

```bash
git clone https://github.com/miksrv/pocket-factory.git
cd pocket-factory
cp .env.example .env          # TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, WORKSPACES_DIR, GH_TOKEN[_<OWNER>], WEB_AUTH_PASSWORD
docker compose up -d --build
docker compose run --rm -it supervisor claude auth login   # prints a URL: open it anywhere, paste the code back
docker compose logs -f supervisor
```

The login lands in `data/claude/.credentials.json`, the CLI refreshes it by itself, and the
connectors of your claude.ai account (Gmail, ClickUp, Google Drive, …) become available to the
agents. Keep `CLAUDE_CODE_OAUTH_TOKEN` in `.env` empty: a `claude setup-token` value there is the
fallback for CI-like runs (model calls work, connectors do not). The same command works over
`ssh -t` on a VPS.

Then:

1. Open the web UI: `http://<server>:8080` (bound to localhost by default — use an SSH tunnel or
   Tailscale, or set `WEB_BIND=0.0.0.0` together with `WEB_AUTH_PASSWORD` behind an https proxy).
2. **Projects → New**, or tell the bot *"connect project X"* and let the `onboard-project` skill
   write the file after inspecting the checkout.
3. Send the bot a task: *"In astronomy-portal change photo URLs from ids to SEO slugs"*.
4. **Schedules → New** for anything recurring: a nightly PR review, a tracker poll, an inbox
   summary. Start with `action: report` and graduate it once you trust the runs.

## Layout

```
data/                    runtime state — everything the factory owns, all bind-mounted, gitignored
├── claude/              Claude Code home: CLAUDE.md, agents/, skills/, transcripts, login and MCP credentials
├── config/              projects/*.md, schedules/*.md, hosts.yaml (shared SSH hosts), known_hosts, mcp.json
├── workspaces/          repositories (or WORKSPACES_DIR → a folder you already have)
├── inbox/               photos and files sent with messages, per conversation (kept 30 days)
├── secrets/ssh/         keys for project hosts, linked to ~/.ssh in the container (mounted read-only)
├── db/                  SQLite: conversations, tasks, task events, schedule runs, seen items, web sessions
└── logs/
supervisor/              Telegram bot, task queue / session manager, scheduler, HTTP API (TypeScript, Node 22)
web/                     admin UI (Vite + React), built into the image and served by the supervisor
templates/claude/        seeded into data/claude on every start (never overwrites your edits)
presets/                 shareable agent + skill bundles, installable from the UI
docs/SPEC.md             requirements & roadmap · docs/LANDSCAPE.md  the neighbours and what is taken from them
```

Moving to another host is `rsync data/` + `docker compose up`.

## How a task flows

```
Telegram / web / cron ──► tasks queue (SQLite) ──► claude -p --resume <session>  (cwd = the project's checkout)
                                                     │  reads  data/claude/CLAUDE.md          dispatcher rules
                                                     │  reads  data/config/projects/<p>.md    project facts
                                                     │  loads  skills/feature-to-pr           the procedure
                                                     │  spawns agents/developer, agents/reviewer
                                                     │  asks   you, when it must (question / permission) ──► Telegram / web
                                                     └─► git push · gh pr create · report back
```

A conversation bound to a project runs from that project's checkout, so the repository's own
`.mcp.json`, `.claude/agents`, `.claude/skills` and `CLAUDE.md` load on top of the factory's.

Sub-agents may reach the servers listed under `hosts:` in a project file over SSH with the keys in
`data/secrets/ssh/`; read-only inspection is allowed, changes need an explicit "yes" from you.
Keys only, no passwords, by design: generate a pair for the factory (`ssh-keygen -t ed25519 -f
data/secrets/ssh/id_ed25519 -C pocket-factory`), add the `.pub` to a dedicated user on each host,
`chmod 700 data/secrets`. The directory is mounted read-only; the UI lists the key names, never
their contents. Everything else happens in Settings → Hosts: "Test connection" checks the login,
and when the server is not known yet (or its key changed) "Trust host key" shows its fingerprints
and writes them to `data/config/known_hosts`, the file every ssh in the container consults. Inside
the container the CLI runs as uid 1000 (`node`): on a Linux server make the keys readable by that
uid and keep private keys at mode 0600, or ssh refuses them ("UNPROTECTED PRIVATE KEY FILE"); the
read-only mount means the entrypoint cannot fix this for you.

## MCP servers

Three layers, all optional, plus the connectors of your claude.ai account, which the container-side
login brings into every session. A repository's own `.mcp.json` applies when a conversation is
bound to that project (`/new <project>`, the selector in Chat, or the first task naming it). Your
own servers go into `data/config/mcp.json` (same format as `.mcp.json`, passed to every session);
secrets only as `${VAR}` with the value in `.env`:

```json
{ "mcpServers": { "trac": { "type": "http", "url": "https://trac.example.com/mcp", "headers": { "Authorization": "Bearer ${TRAC_MCP_TOKEN}" } } } }
```

Settings → MCP lists every server the sessions have seen (connectors, plugins, project and factory
servers) with its status; **Refresh** runs `claude mcp list` in the factory and is the way to see
servers that still need a sign-in, and **Authorize** runs `claude mcp login <name> --no-browser`
there and shows you the link (a connector is done on claude.ai; a project's OAuth server wants the
redirect URL pasted back). The console flow is the fallback:
`docker compose run --rm -it -w /data/workspaces/<repo> supervisor claude mcp login <name> --no-browser`.
Tokens land in `data/claude/.credentials.json` and the CLI refreshes them. Logging in from a macOS
laptop does not help: there the CLI keeps tokens in the Keychain, which the container cannot read.
A project file's `mcp:` list limits which of the repository's servers a session loads; an agent's
tool picker offers the servers' tools, so "a ClickUp agent" is a role with that server ticked.

## Voice

Set `GROQ_API_KEY` in `.env` (free tier is enough). Voice notes are transcribed with
`whisper-large-v3-turbo`, echoed back as text and queued like a typed message. `STT_LANGUAGE=ru`
(or any ISO code) improves accuracy for a single language.

## Sharing with colleagues

Fork the repository, add your team's agents and skills under `presets/`, commit. Every colleague
runs their own factory from the fork with their own Claude login, bot and token, and installs the
presets from the UI. See [presets/README.md](presets/README.md).

## Development without Docker

```bash
corepack enable
yarn install
cp .env.example .env          # the supervisor reads it itself
yarn dev                      # supervisor + API on :8080, uses the claude CLI from your PATH
yarn dev:web                  # Vite dev server on :5173, proxies /api to :8080
```

`CLAUDE_CONFIG_DIR` defaults to `data/claude`, so the host CLI uses the same agents, skills and
transcripts as the container. Keep `CLAUDE_PERMISSION_MODE=acceptEdits` outside the container.
Telegram allows one poller per bot token, so while the container is running start the host copy
web-only: `TELEGRAM_BOT_TOKEN= yarn dev`. On macOS the host CLI keeps its login in the Keychain,
so connectors and MCP sign-ins are tested against the container, not `yarn dev`.

## Versioning

`MAJOR.MINOR.PATCH` in the root `package.json`, shown in the sidebar foot next to the Claude Code
version and in `/status`. [CHANGELOG.md](CHANGELOG.md) is written with each change; a tag and a
GitHub release follow the merge (`node scripts/release.mjs`).

## License

MIT
