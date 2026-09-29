# Pocket Factory

> An agent becomes truly autonomous the moment you close your laptop lid.

Pocket Factory is a **self-hosted layer over [Claude Code](https://code.claude.com) for
developers**. Claude Code on its own is a session in your terminal: it works while the laptop is
open and you are watching. Pocket Factory runs the unmodified Claude Code CLI on a server of your
own, takes tasks from Telegram or the browser, and turns those sessions into something you can
leave alone and still trust:

- **Autonomy** — send a task from the road, by text or voice; the agent works in your repositories,
  opens the pull request and reports back. Sessions continue across messages; tasks queue and
  survive restarts.
- **Control over what agents do** — an audit log of every model call, tool call, file edit and
  sub-agent, attributed to the agent and the project; rendered transcripts; token and
  subscription-window accounting instead of made-up dollar figures.
- **Management** — agents, skills and projects are Markdown files with frontmatter, edited in the
  UI or by the agent itself; presets bundle them for sharing; models and tools are picked from what
  your subscription and CLI actually offer.
- **Pipelines** — skills such as `feature-to-pr` and `onboard-project` chain sub-agents (developer,
  reviewer, …) into repeatable task flows; schedules and tracker pollers are next.

Single-owner by design. You log in to Claude Code with **your own subscription**, create **your own**
Telegram bot, use **your own** GitHub token, point it at **your own** repositories. Nothing is shared,
proxied or stored by anyone else. See [docs/SPEC.md](docs/SPEC.md) for the concept and roadmap.

How this differs from Claude Code's own Remote Control and cloud sessions: those need a live
`claude` process (or Anthropic's VM) and keep the transcript with Anthropic; Pocket Factory keeps a
queue that survives restarts, an audit log of every tool call, and your agents, skills and MCP
servers as files on your server, and works in your real checkouts with their own `.mcp.json`,
`CLAUDE.md` and `.claude/` folders. What it does not do yet is answer permission prompts from the
phone and accept photos; see [docs/LANDSCAPE.md](docs/LANDSCAPE.md) for the comparison with
similar projects and the ideas taken from it.

## What it does today

- **Telegram** — text and voice (Whisper on Groq) → `claude -p` in your workspaces → reply with
  turns / tokens / share of the 5-hour window / time, plus how full the subscription windows are.
  Replies continue the same Claude Code session; `/new`, `/stop`, `/status`, `/usage`.
- **Task queue** — every channel goes through one SQLite queue; one running task per conversation,
  a configurable number overall; tasks survive supervisor restarts (a task interrupted mid-run is
  re-queued once and resumes its session).
- **Web UI** — Overview (queue, subscription limits, tokens, health), Tasks, Chat with Claude Code from the browser with
  live output, Sessions (rendered Claude Code transcripts), editors for **Agents**, **Skills** and
  **Projects**, **Presets**, an **Audit log** (every model call, tool call and sub-agent, per agent
  and project), Settings.
- **Factory files** — sub-agents `developer` / `reviewer`, skills `feature-to-pr` /
  `onboard-project`, one Markdown file per project (repo, branches, checks, tracker, hosts).
  The UI, the owner and the agent edit the same files; what the agent changes shows up in the
  Audit log as file events.
- **Presets** — shareable bundles under `presets/` (`bug-tracker-fixer`, `pr-review`) that a
  colleague installs with one click into their own factory.

## Quick start

Requirements: Docker, a Claude subscription, a Telegram bot token from
[@BotFather](https://t.me/BotFather), your Telegram user id (ask
[@userinfobot](https://t.me/userinfobot)), a GitHub fine-grained PAT for the repositories the
factory may touch (one per repository owner, since such a token belongs to a single user or
organization: `GH_TOKEN_<OWNER>`, with `GH_TOKEN` as the fallback).

```bash
git clone https://github.com/miksrv/pocket-factory.git
cd pocket-factory
cp .env.example .env          # TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, WORKSPACES_DIR, GH_TOKEN[_<OWNER>], WEB_AUTH_PASSWORD
claude setup-token            # on your laptop: prints a token — put it into .env as CLAUDE_CODE_OAUTH_TOKEN
docker compose up -d --build
docker compose logs -f supervisor
```

`claude setup-token` needs a browser, so run it on your laptop, not on the server. Interactive
`/login` inside the container is currently broken upstream
([anthropics/claude-code#34917](https://github.com/anthropics/claude-code/issues/34917)).

Then:

1. Open the web UI: `http://<server>:8080` (bound to localhost by default — use an SSH tunnel or
   Tailscale, or set `WEB_BIND=0.0.0.0` together with `WEB_AUTH_PASSWORD`).
2. **Projects → New**, or tell the bot *"connect project X"* and let the `onboard-project` skill
   write the file after inspecting the checkout.
3. Send the bot a task: *"In astronomy-portal change photo URLs from ids to SEO slugs"*.

## Layout

```
data/                    runtime state — everything the factory owns, all bind-mounted, gitignored
├── claude/              Claude Code home: CLAUDE.md, agents/, skills/, transcripts, MCP credentials
├── config/              projects/*.md (one per connected project), mcp.json (your own MCP servers)
├── workspaces/          repositories (or WORKSPACES_DIR → a folder you already have)
├── secrets/ssh/         keys for project hosts, linked to ~/.ssh in the container
├── db/                  SQLite: conversations, tasks, task events
└── logs/
supervisor/              Telegram bot, task queue / session manager, HTTP API (TypeScript, Node 22)
web/                     admin UI (Vite + React), built into the image and served by the supervisor
templates/claude/        seeded into data/claude on every start (never overwrites your edits)
presets/                 shareable agent + skill bundles, installable from the UI
docs/SPEC.md             requirements & roadmap
```

Moving to another host is `rsync data/` + `docker compose up`.

## How a task flows

```
Telegram / web ──► tasks queue (SQLite) ──► claude -p --resume <session>  (cwd = workspaces)
                                              │  reads  data/claude/CLAUDE.md          dispatcher rules
                                              │  reads  data/config/projects/<p>.md    project facts
                                              │  loads  skills/feature-to-pr           the procedure
                                              │  spawns agents/developer, agents/reviewer
                                              └─► git push · gh pr create · report back
```

Sub-agents may reach the servers listed under `hosts:` in a project file over SSH with the keys in
`data/secrets/ssh/`; read-only inspection is allowed, changes need an explicit "yes" from you.
Keys only, no passwords, by design: generate a pair for the factory (`ssh-keygen -t ed25519 -f
data/secrets/ssh/id_ed25519 -C pocket-factory`), add the `.pub` to a dedicated user on each host,
`ssh-keyscan <host> >> data/secrets/ssh/known_hosts`, `chmod 700 data/secrets`. The directory is
mounted read-only; the project form lists the key names, never their contents, and has a "Test
connection" button. Inside the container the CLI runs as uid 1000 (`node`): on a Linux server make
the keys readable by that uid and keep private keys at mode 0600, or ssh refuses them
("UNPROTECTED PRIVATE KEY FILE"); the read-only mount means the entrypoint cannot fix this for you.

## MCP servers

Three layers, all optional. A repository's own `.mcp.json` applies when a conversation is bound
to that project (`/new <project>`, `/project <project>`, the selector in Chat, or the first task
naming it): tasks then run from the checkout, and its agents, skills and `CLAUDE.md` apply too.
Your own servers go into `data/config/mcp.json` (same format as `.mcp.json`, passed to every
session); secrets only as `${VAR}` with the value in `.env`:

```json
{ "mcpServers": { "trac": { "type": "http", "url": "https://trac.example.com/mcp", "headers": { "Authorization": "Bearer ${TRAC_MCP_TOKEN}" } } } }
```

OAuth servers are logged in once inside the container, from the repository's checkout:
`docker compose run --rm -it -w /data/workspaces/<repo> supervisor claude mcp login <name> --no-browser`
prints the authorization URL; open it in any browser and paste the redirect URL back. The token
is stored in `data/claude/.credentials.json` and refreshed by the CLI. This works the same over
SSH on a server (no port forwarding needed). Logging in from a macOS laptop does not help: there
the CLI keeps tokens in the Keychain, which the container cannot read. Settings → MCP
shows every server and whether its variables are set. A project file's `mcp:` list limits which
of the repository's servers a session loads.

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
transcripts as the container; the OAuth token in `.env` logs it in. Keep
`CLAUDE_PERMISSION_MODE=acceptEdits` outside the container. Telegram allows one poller per bot
token, so while the container is running start the host copy web-only: `TELEGRAM_BOT_TOKEN= yarn dev`.

## License

MIT
