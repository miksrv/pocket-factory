# Changelog

## 1.7.0

### Minor Changes

- Sandboxes: every project's agent runs in its own Docker Sandbox (a microVM with sudo and its own Docker, kept between tasks); chats without a project in `pf-factory`
- Sandboxes: Settings → Sandboxes shows the daemon, the Docker and Claude logins, each sandbox with Stop and Reset
- Sandboxes: a project's sandbox reaches only what its file names (`network:`, its SSH hosts, its routines' Trac); a blocked host comes to Telegram and the project page with Allow / Deny
- Preview: the agent shows a running app at `/preview/<project>/` behind the factory's sign-in (`preview` tool), with Open / Stop in Telegram and on the project page
- Routines: a step's script runs in its project's sandbox, with the tools the agent installed there
- Toolchains: removed (mise, PHP and Docker in the image, the dind sidecar, Settings → Toolchains); the agent installs what a checkout needs in its sandbox
- Projects: a Network section and the sandbox card above the form
- Overview: tokens by day for 7 / 30 / 90 days, each subscription model and each provider apart
- Providers: the API key (and an MCP server's) is a secret with the access "model providers only", picked or added in the form; no `.env`
- Providers: keys still in `.env` move into Secrets at start, once
- Routines: the Trac login is no longer in `.env.example`; it is set in Secrets

## 1.6.1

### Patch Changes

- Skills and routines: the new file's path field under ＋ File takes the full width
- UI: contrast up to WCAG AA in both themes (dim text, placeholders, pills, field edges), a visible focus ring on fields, no animation under reduced motion, text at least 11px
- UI: shadows and the danger hover come from theme tokens, so the dark theme keeps its edges
- UI: icons instead of glyphs everywhere (✓ ✗ ⚠ ▸ ↗ ☰ ＋), the same icon for the same thing
- Forms: shorter hints and labels, buttons beside a field at its height, host cards and the provider window in full rows and sections
- Code: a step's command, the MCP JSON and a certificate are edited in the code editor
- Settings: signing out one browser asks first
- DESIGN.md: an Accessibility section and rules for tokens, icons, inline errors and empty lines

## 1.6.0

### Minor Changes

- Telegram: topics are gone; the chat is flat again, `/mode fresh` / `thread` as in 1.4.0
- Telegram: buttons sit inside the messages (rich messages): `/routines` lists every routine with its own Run / Off / Details, a routine's card, `/status`, `/model`, `/mode`, `/usage`, `/help` and the agent's questions
- Telegram: a reply carries Open, PR, Run again and Routine inside it; a client that refuses a rich message gets the same as HTML with a keyboard
- Telegram: a tap on Run is acknowledged at once and the outcome shows in the message; a run that found nothing new offers "Run with all N"
- Telegram: `/new` alone picks the project on buttons (fresh mode); `/status` lists everything running and opens the main views
- Telegram: the live draft shows the step count and the tool only, never the agent's prose; it ends while a question waits and before the reply
- Routines: a routine is a pipeline — `steps:` run in order (scripts, GitHub pull requests, Trac tickets, a command that lists items) and the agent is the last step; prefilters and `poll:` triggers are gone (old files still read)
- Routines: a source that finds nothing means no agent and no tokens; a routine without an agent runs its scripts and reports their output; a failing step stops the run with its last lines
- Routines: Preview runs every step but the agent; Run now on sources that found nothing new can hand every item over again ("Run with all")
- Routines: a routine is a folder — `ROUTINE.md` plus its scripts (`scripts/`) and data (`data/`), `ROUTINE_DIR` for the steps; a flat file moves in on its next save
- Routines: the pipeline is a graph of cards top to bottom, as in GitHub Actions — each step with how it went last time, what it is for and what it misses; a click opens the step in a window (a script step with its script in a code editor, what it reads, Run step to run it alone)
- Routines: ＋ Script creates `scripts/<name>.sh` with a header to fill; the Files section edits every file of the folder (code editor, CSV as a table, upload, download, rename)
- Routines: a run opens into its steps (ok / failed, time, the head of the output), like a CI job; the Routines page shows every pipeline at once
- Settings: Secrets and variables, as in GitHub — a secret is written once and never shown, a variable stays visible; scoped to all or to chosen routines and projects; set from a step card with Set
- Security: secret values are masked as •••• in task prompts, results, events, run logs and Telegram; every change of a secret is told in Telegram
- Skills: the files next to SKILL.md (scripts, references) are listed, edited in a code editor and added under the procedure
- Skills: Secrets and variables on a skill's page — what its scripts read, which routines running it get each name, Set / Allow; the routine's agent step shows the same
- Routines: the form is shorter — one schedule field, step cards with a number and kind, one-line hints, the model in the Agent step (orchestrator only), hosts and session only for a file that has them
- Routines: no Mode field — what a run may do is written in its instructions; an old file's `action:` moves there on start
- UI: long forms are split into sections with headings (pipeline, schedule, hosts, toolchain, MCP, tools, the Markdown body)
- UI: windows have a header (tile, title, one line, close) and a body across the whole width
- Projects: the form keeps repository, workflow, MCP, toolchain and hosts; display name, default branch and PR base are gone (git and the task decide), checkout and delegation under More
- Settings: the Claude Code card shows only CLI, login and model; a provider's MCP tools are one badge with a count, named in its tooltip
- Presets: `engineering` — eight skills from mattpocock/skills (tdd, code-review, diagnosing-bugs, pr, research, codebase-design, writing-for-agents, retro)
- Tasks and Overview: a routine's run is listed by the routine's name
- Agents: MCP servers that still need authentication are folded away in the form
- Agents: tools read as names (Delegate to a role, ClickUp · create task), the identifier the file holds in the tooltip; the factory's own tools have their own line
- Docs: `docs/plans/database.md` (SQLite stays, and why), `docs/plans/ui-review.md` (what to simplify next)
- Dependencies: Playwright 1.64, ESLint 10.13, Vitest 5.0.5, React 19.3.1, lucide-react 1.58, Prettier 3.9.10
- Fixed: a supervisor started while the previous one was still closing the database died with "database is locked"
- Fixed: `scripts/screenshot.mjs` left a signed-in session behind on every run
- Routines: the web panel offers "Run with all N" too, after a Run now that found nothing new
- Fixed: a new-only routine whose first timed run found nothing marked the first real item as "existing" and skipped it
- Fixed: changing only the schedule of a 1.5.0 poll routine in the form dropped its prefilter
- Routines: a GitHub pull-requests step watches several repositories, one per line, as `owner/name` or the address from the browser
- Routines: Run step in a step's window runs the step as it stands there, before Save
- Fixed: a GitHub step given the repository's address broke the routine and left Run step disabled
- UI: a button beside a field is the field's height
- Fixed: switching a routine on or off made the open form's next Save fail as "changed on disk"
- Fixed: a 1.5.0 file with a schedule next to a poll is refused with a hint to split it, instead of the poll silently gating the schedule
- Fixed: a script step that left a process in the background was reported as timed out; Cyrillic in step output could break at a chunk boundary
- Fixed: a JSON source listing the same key twice handed the item over twice; a failed step's run now records how long it took
- Fixed: Telegram Run / `/run` held up the whole bot until the routine's steps were done
- Fixed: Telegram voice notes over ~4 minutes were transcribed but never became a task (the echo was too long)
- Fixed: Telegram long replies with a footer could lose the last part; a reply that arrived in part is remembered, so replying to it continues the chat
- Fixed: Telegram sent a message twice when the rich form failed after delivery (timeout, 5xx); only a refusal falls back to HTML
- Fixed: Telegram `/model` failed for a provider name too long for a button
- Routines: a Trac step takes the address of a custom query as one field, pasted from the browser; `TRAC_URL` is gone, only the login is shared
- Fixed: a routine step's line of variables disappeared at the first edit of the step
- Fixed: the Set button of a missing variable was unreadable on hover; the scope lists in the variable window lost their odd indent
- Fixed: the routines overview sat further from the card's edges than an open routine

## 1.5.0

### Minor Changes

- Routines: Schedules are Routines — an agent, its instructions and a list of triggers: "on a schedule" (a cron) or "when something new appears" (a cron with a prefilter); several triggers, or none and Run now only; old `cron:` files still read
- Routines: the page is `/routines`, the files live in `data/config/routines/` (an old `schedules/` is moved once), Telegram says `/routines`, new tasks carry the source `routine`; run history, seen items and chat threads stay
- Routines: the form puts Agent, Skill, Instructions and Triggers first and folds project, model, mode, report, session, once and hosts under "More"; the status panel is three columns
- Routines: a routine's chat thread is a log — project, agent and model are shown as text, no messages or model changes there, a run never takes the thread's model
- Telegram: `/routines` is a menu on buttons — a tap opens the routine's card with Run now, Switch on / off, Preview, last runs and a link to the web; `/run` alone opens the same menu; a routine's report and notices carry Run again and Routine buttons
- Telegram: your message carries the task's state as a reaction (👀 seen, 👨‍💻 working, 🤔 asking, 😴 waiting for the window, 👍 done, 💔 failed, 🫡 stopped) and the reply quotes it; the "Working…" message is gone
- Telegram: while a task runs a draft under the chat shows its steps, the tool under way and the agent's last words, with a Stop button that stops the task
- Telegram: replies are rich messages rendered by Telegram from the agent's Markdown — headings, tables, lists, code with a language, quotes, up to 30k characters in one message; project, changes and windows go in a footer; a reply that opened a pull request gets a 🎉 effect and a PR button; Open leads to the task page
- Telegram: `/model`, `/mode`, `/status` and `/usage` answer with buttons (the aliases and providers, the two modes, Stop, Refresh); Allow is green and Deny red; a settled question shows the answer on its button; a question without options asks the client for a reply
- Telegram: the command menu, the bot's description and `/help` are refreshed; a voice note shows "typing" while it is transcribed
- Telegram: topics — with topics on for the bot in BotFather every chat is a topic of the private chat: `/new` picks the project on buttons (No project first) and opens a topic named after it (a second live one of the same project adds the chat's title), a message in General opens one too, a routine reports in `⏱ name`, a web chat that reached Telegram gets its own; a topic you make yourself becomes a chat (in the project of its name), deleting one drops its chat, deleting the chat in the web drops the topic; the Haiku title renames a topic named after the chat
- Projects: the Tracker and Checks fields are gone; both are prose in the project notes, which the developer agent and the skills read
- Settings: the signed-in browsers and recent sign-ins tables scroll inside a fixed height
- `.env`: `ROUTINES_SOFT_STOP`, `ROUTINES_LATE_MIN`, `ROUTINES_ASK_TIMEOUT_MIN`; the `SCHEDULES_*` names still work
- Dev: `yarn dev:web` proxies `/api` to `WEB_PORT` from `.env`
- Providers: `max_output` (8000 tokens per call unless set) and `context` (the model's real window) per provider, so a looping small model fails in a minute and a long role compacts before the box's window is full
- Providers: Settings → Providers lists each MCP server's tools under their full `mcp__<server>__<tool>` names; a server name another layer already uses is refused; the README explains the naming rule
- Delegation: a role that ran on the subscription because of a setting (the project allows no provider) is said so in the chat card, the Telegram footer and a hint on the project form; the footer names every delegated role and where it ran
- Fixed: a delegated role ignored its file's `maxTurns:`
- Fixed: a deleted or renamed agent stayed on the Agents page and the Overview as a Claude Code built-in for a week; built-ins are now the sub-agents the CLI reports
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
