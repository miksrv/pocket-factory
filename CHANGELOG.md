# Changelog

## 1.5.0

### Minor Changes

- Routines: Schedules are Routines — an agent, its instructions and a list of triggers: "on a schedule" (a cron) or "when something new appears" (a cron with a prefilter); several triggers, or none and Run now only; old `cron:` files still read
- Routines: the page is `/routines`, the files live in `data/config/routines/` (an old `schedules/` is moved once), Telegram says `/routines`, new tasks carry the source `routine`; run history, seen items and chat threads stay
- Routines: the form puts Agent, Skill, Instructions and Triggers first and folds project, model, mode, report, session, once and hosts under "More"; the status panel is three columns
- Routines: a routine's chat thread is a log — project, agent and model are shown as text, no messages or model changes there, a run never takes the thread's model
- Projects: the Tracker and Checks fields are gone; both are prose in the project notes, which the developer agent and the skills read
- Settings: the signed-in browsers and recent sign-ins tables scroll inside a fixed height
- `.env`: `ROUTINES_SOFT_STOP`, `ROUTINES_LATE_MIN`, `ROUTINES_ASK_TIMEOUT_MIN`; the `SCHEDULES_*` names still work
- Dev: `yarn dev:web` proxies `/api` to `WEB_PORT` from `.env`
- Fixed: hovering a hint under "Providers this project may delegate to" lit the first provider chip
- Fixed: a `WEB_PORT` other than 8080 left the container unreachable; the port inside the container is pinned to 8080

## 1.4.2

### Patch Changes

- Routines: the agent a schedule names always runs itself, also without `Edit` or when the project has an agent of the same name
- Routines: the schedule's skill comes in the run's prompt, so the agent needs no Read
- Presets: the `devops` preset is removed; installed files stay

## 1.4.1

### Patch Changes

- Routines: a schedule with an agent runs as that agent (`claude --agent`) instead of an orchestrator that spawns it; about a third of every run saved
- Audit log and Agents: a task's work counts under the agent it runs as — a schedule's agent or a delegated role

## 1.4.0

### Minor Changes

- Delegation: an agent file with `provider:` is a role a Claude orchestrator hands work to with the factory's `delegate` tool; the role runs as its own task on that provider while the orchestrator waits without spending tokens
- Delegation: a provider that does not answer, fails, or is not allowed for the project → the role runs on the orchestrator's model (`fallback:` alias, or `none` to report)
- Overview: a Providers card — whether each provider answers, its load and tokens, how much work left the subscription
- Projects: "Providers this project may delegate to" (`providers:` in the project file)
- Providers: own MCP servers through the gateway for that provider's tasks only; a CA certificate field; Test covers the MCP servers
- Docs: `docs/SELF_HOSTED_LLM.md`, the guide to a GPU box with Ollama, Caddy and a search MCP
- Telegram: a new chat per message; a reply to any message continues that chat; `/mode thread` brings back one session until `/new`
- Chat: titles by meaning from one Haiku call; `CHAT_TITLES=off` keeps the first line
- Tokens: figures everywhere leave out cache reads (they were ~95 % of the number)
- Gateway: a bearer per provider; upstream failures are reported with their reason
- Dependencies: Vite 8, marked 18, hono 4.13.13 (security fix), lucide-react 1.54
- Fixed: stopping the supervisor waits for each run to write its end before the database closes
- Fixed: Enter on the sign-in page signs in from either field; the provider dialog's rows no longer overlap

## 1.3.0

### Minor Changes

- Providers: Settings → Providers connects self-hosted models (Ollama, llama.cpp, vLLM) and cloud APIs (OpenRouter, Gemini, OpenAI, Groq); a schedule, an agent file or a chat picks one, and its tasks go through the factory's gateway, which holds the key
- Providers: light mode for small models — a short system prompt and six tools instead of Claude Code's full prompt
- API: `/api/providers`, `PUT /api/conversations/:id/model`, `providers` in `/api/status`; migration v15

## 1.2.1

### Patch Changes

- Telegram: a scheduled run skipped for the subscription limit is reported with the window and when runs resume

## 1.2.0

### Minor Changes

- Dark theme: the sun / moon in the sidebar foot or Settings → Appearance (System / Light / Dark)
- Toolchains: `mise`, PHP 8.2 and the docker CLI in the image; the agents install the runtimes a checkout asks for; an optional Docker sidecar for test services; Settings → Toolchains
- Security: the web signs you out after `WEB_SESSION_IDLE_HOURS` without activity (default 8)
- Durations read `1h 23m 10s`
- Fixed: a running task showed 0 turns and tokens until its result; they update every few seconds now

## 1.1.2

### Patch Changes

- Telegram: a web task's reply unread for `TELEGRAM_WEB_NOTIFY_MIN` minutes, or its open question, goes to Telegram, and the chat switches to that thread

## 1.1.1

### Patch Changes

- Sessions: background sub-agents are no longer killed after 10 minutes
- Sessions: no more empty reply after a task that left background sub-agents behind
- Chat: a reply whose sub-agents were stopped before finishing says so
- Dispatcher rules: a SendMessage sub-agent reports by notification; no background `sleep` timers

## 1.1.0

### Minor Changes

- Attachments: photos and files with a task from Telegram and the web, saved under `data/inbox/`; deleting a chat deletes its files
- Changes panel on the task page: branch, files and lines, uncommitted files, the pull request, Create PR; a size link in the chat and in the Telegram report
- Auto-continue: a task refused for the subscription limit waits for the reset and continues its session, up to three times within `CLAUDE_AUTO_CONTINUE_HOURS`
- Telegram: `/stop` cancels a queued task too
- Migrations v13 and v14; `Button` takes `href`
- README and `docs/LANDSCAPE.md` reflect October 2026

## 1.0.1

### Patch Changes

- Telegram: `/project` is gone, `/new [project]` is the one command; a shorter footer (project, windows with this task's share) and `/status`
- No dollar budget: `CLAUDE_MAX_BUDGET_USD` and `--max-budget-usd` are removed
- Fixed: a bound conversation no longer switches projects by itself
- Fixed: a reply that cut off a sub-agent says so

## 1.0.0

### Major Changes

- Autonomy: tasks from Telegram (text, voice) and the browser run as `claude -p` sessions in the owner's checkouts, continue across messages and survive restarts; questions and permissions are answered from either
- Control: the Audit log of every model call, tool call, file edit and sub-agent; tokens and subscription windows instead of dollars; rendered transcripts
- Management: agents, skills, projects and schedules as Markdown files edited in the UI or by the agent; presets; shared SSH hosts; MCP in three layers with claude.ai connectors
- Pipelines: skills chain sub-agents; schedules fire behind deterministic prefilters
- Web UI: a paper-and-mono theme without a framework — Chat, Tasks, Sessions, Audit log, Agents, Skills, Projects, Schedules, Presets, Settings; installs as a PWA
- Security: web sign-in with lockout and a sign-in log, CSRF and DNS-rebinding guards, fine-grained GitHub tokens
- Versioning: this changelog, the version in the sidebar foot and `/status`, `scripts/release.mjs`
