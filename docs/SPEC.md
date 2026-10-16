# Pocket Factory — Requirements & Specification

> **Tagline:** *"An agent becomes truly autonomous the moment you close your laptop lid."*
>
> Status: living spec, updated 2026-10-15 for 1.4.0; history in git. Author: Misha Topchilo (with Claude).
> Implementation detail lives in `CLAUDE.md`; what shipped when is in `CHANGELOG.md`.

---

## 1. Vision & Concept

A **self-hosted layer over Claude Code for developers**: a containerized personal agent platform on the owner's server that works while the owner is away. It adds what the CLI alone lacks — autonomy (tasks queue and run without a terminal), control (an audit log per agent and project), management (agents, skills, projects as files with a UI) and pipelines (skills chaining sub-agents). Think `/rc` for Claude Code through Telegram, without a laptop: driving to a conference, the owner records a voice note about a hotfix, and the agent does the work and reports back.

A thin **supervisor** turns messages from Telegram (text, voice, files), the web chat and routines into `claude -p` sessions, which spawn **sub-agents** (developer, reviewer, email assistant, …) natively and report back through the channel the task came from. Sub-agents, skills, projects and routines are Markdown files edited in the UI or by the agent ("create an agent that triages my email"); everything lives in one data volume. Inspiration: Guild.ai's "Software Factory", but personal and self-hosted; `docs/LANDSCAPE.md` compares the neighbours.

### Core principles

1. **Zero idle cost.** Claude Code is spawned per task, not kept alive. When there is nothing to do, only the cheap deterministic supervisor (bot polling, scheduler, web UI) is awake.
2. **Claude Code is the agent; we are the supervisor.** The tool never modifies the CLI, never handles the owner's Claude credentials, and never re-implements what Claude Code already does (sub-agents, skills, sessions, memory, MCP, transcripts). The owner's subscription is the default backend; other model providers (self-hosted or cloud, since 1.3.0) are an option the same CLI reaches through the supervisor's gateway.
3. **Everything is a file.** Sub-agents, skills, projects, routines and global rules are Markdown files on a volume. The UI and the agent edit the same files; every edit the agent makes is a file event in the Audit log.
4. **Deterministic prefilter before LLM.** Polling, filtering and deduplication are plain code. Claude Code is invoked only when there is real work.
5. **Facts ≠ procedures ≠ roles.** Project facts in project files, workflows in skills, roles in sub-agent definitions, universal rules in `CLAUDE.md`. No duplication.
6. **Portable by design.** One Docker Compose stack + one `/data` volume = the entire system.
7. **Template for others.** No personal facts in the code: anyone can fork the repo, log in with **their own subscription**, add their own bot and projects. Strictly single-owner: the tool never offers Claude login in its UI, never stores or proxies anyone's Claude credentials, never intermediates Claude usage for a third party.

---

## 2. Goals & Non-Goals

### Goals

- Autonomous multi-step software tasks (feature → PR → review → fixes → report) without supervision, across many repositories, each with its own workflow and conventions.
- Telegram as the primary human channel (text, voice, files in; questions and reports out, only the essentials); a web UI for chat, observability and administration.
- Tasks from Telegram, the web and routines (an agent, its instructions, schedules and polls with deterministic prefilters).
- Human-in-the-loop inside the same run; corrections persisted by the agent into its own files.
- A one-shot run per task. In Telegram every message starts a new chat and a reply resumes the chat it answers (`/mode thread`: the next message resumes, `/new` starts fresh); in the web the next message in a thread resumes it; `/stop` cancels.

### Non-Goals

Multi-tenant or team use (single owner, whitelisted Telegram ids); enterprise RBAC / SSO / compliance; a general-purpose chat assistant; horizontal autoscaling (one more server = one more instance); re-implementing the agent loop, sub-agents, tracing or memory.

---

## 3. Use Cases

- **UC-1 — Feature from a voice note.** *"In my project, URLs in `/photos` must become SEO slugs."* Transcribed, queued, matched to the project, its workflow skill runs developer → reviewer → checks → `gh pr create`; Telegram gets the PR link.
- **UC-2 — ClickUp task.** *"In webshop take DEV-1234 and do it."* Read through the claude.ai connector; an ambiguity becomes an `AskUserQuestion` answered from Telegram or the web, and the same run continues; PR, comment on the task, status → Review.
- **UC-3 — GitHub review request.** A routine's `github-prs` poll looks without a public endpoint; a new PR or push runs `pr-review` with read-only tools.
- **UC-4 — Trac defect monitor.** A `trac` prefilter finds new or changed tickets (zero tokens otherwise); reproduce read-only over SSH or from code, fix, review, PR.
- **UC-5 / UC-6 / UC-7 — The factory edits itself.** "Create an agent that triages my inbox", `onboard-project` writing a project file after an interview, "remember: always update CHANGELOG" — the agent writes the files, the owner reviews them in the UI and the Audit log.
- **UC-8 — Ending a session.** Nothing to end: a run exits with its report; a reply (or the next message in a web thread) resumes it, a plain Telegram message starts fresh.
- **UC-9 — Bulk work off the subscription.** Keyword research or an SEO article runs on a self-hosted or cloud provider, so the windows stay for coding.

---

## 4. System Architecture

```
                     ┌──────────────────────── server · docker compose ────────────────────┐
 Telegram ◄─────────►│  supervisor (always on, no LLM)                    web              │
 (text/voice/files)  │  ┌──────────────────────────────────────────┐     ┌──────────────┐  │
 GitHub, Trac ──────►│  │ telegram bot (long polling) + STT        │     │ Vite/React   │  │
  (polled)           │  │ task queue · scheduler · prefilters      │◄────│ SPA: chat    │  │
                     │  │ session manager: spawn / resume / ask /  │     │ agents/skills│  │
                     │  │   answer / stop / restart recovery       │     │ projects     │  │
                     │  │ provider gateway (/gateway/<name>)       │     │ audit · tasks│  │
                     │  └───────────────┬──────────────────────────┘     │ settings     │  │
                     │                  │ stdio (stream-json both ways)  └──────────────┘  │
                     │                  ▼                                                  │
                     │  claude -p  (unmodified Claude Code CLI, 0..N)                      │
                     │    └─ sub-agents · skills · MCP · claude.ai connectors              │
                     │                                 │         docker:dind (optional)    │
                     │                                 ▼                                   │
                     │  /data: claude/ (CLAUDE_CONFIG_DIR) · config/ · workspaces ·       │
                     │         tools/ (mise) · inbox/ · db (SQLite) · secrets (read-only) │
                     └─────────────────────────────────────────────────────────────────────┘
```

### 4.1 Components

| Component | Responsibility | Tech |
|---|---|---|
| **supervisor** | Telegram bot (long polling, no public IP needed), voice → text, task queue + worker, scheduler + prefilters, **session manager** (§4.4), delivery of reports and questions, provider gateway, toolchain and Docker housekeeping, the HTTP API | TypeScript on Node 22, grammY, `node:sqlite`, a dependency-free cron matcher, `child_process` around `claude -p` |
| **claude** | The agent: dispatcher rules, sub-agents, skills, MCP, sessions, memory. Unmodified CLI, logged in by the owner inside the container; spawned per task | Claude Code CLI (pinned), `git`, `gh`, `mise` runtimes, PHP + composer, docker CLI |
| **web** | Chat and admin UI (§6), live output over SSE | Vite + React SPA built into the image and served by the supervisor; no UI framework |
| **db** | Conversations, tasks and their events, routine runs, seen items, web sessions, meta | SQLite on the volume (WAL) |
| **docker** (profile) | A `docker:dind` sidecar for the projects' test services (§8) | `COMPOSE_PROFILES=docker` |

### 4.2 The trigger → task model (central abstraction)

Every source converges into one queue. A **conversation** (Telegram topic, web thread, `schedule:<name>`) holds the session id, the bound project and an optional provider / model. A **task** is one run in it: source, prompt and attachments, status (`queued` → `running` → `done` / `failed` / `cancelled`), `ask`, `restarts`, `not_before` / `limit_waits`, the model / provider / agent it ran with, a git snapshot, tokens. Every stream-json event is a `task_events` row — the Audit log's source.

Rules:

- **Idle = free.** Claude Code is spawned only for queued tasks: at most `MAX_CONCURRENT_SESSIONS`, one running task per conversation, a provider's `concurrency` respected.
- **Workspace.** The owner's real checkout on a branch — no worktrees, no re-cloning; tasks on one repository are the owner's to sequence for now.
- **Questions** keep the task's slot with the timeout paused; a message typed while one is open is the answer (§4.4). Text sent while a task runs queues the next task; `/stop` cancels.
- **Limits.** A run refused for the subscription limit waits in the queue for the reset (at most three times within `CLAUDE_AUTO_CONTINUE_HOURS`), keeping its session.

### 4.3 Routines

A routine is work an agent does again and again: who does it (`agent:`), what to do (the body) and when (`triggers:`). It is a Markdown file, `data/config/routines/<name>.md`, not a table row: its body is the instruction for every run *and* the agent's memory between runs (deferred tickets, PRs skipped on purpose), which the agent edits itself. The store keeps only what a file cannot: `schedule_runs` (every firing and why it did or did not start a task) and `seen_items` (both named before the rename).

```yaml
---
agent: tracker-triager             # the run is this agent (its prompt, tools, model)
skill: tracker-defect-fix          # optional, given in the prompt
triggers:
  - schedule: "0 9 * * 1-5"        # every firing starts a run; five fields, read in TIMEZONE
  - poll: "*/15 9-18 * * 1-5"      # a prefilter runs first, without the model; new items start a run
    prefilter: { kind: trac, query: "status=new&component=billing" }   # command | github-prs | trac
enabled: true
project: billing                   # or hosts: [{ host, path, notes }]
model: inherit                     # pins a CLI alias; provider: for another backend
action: report                     # the mode the agent gets: report | fix | comment …
notify: telegram                   # or none
session: fresh                     # or continue
first_run: skip                    # a poll starts from now
---
Instructions for every run, in prose. ## Notes: what the agent decided last time.
```

- **Triggers.** A `schedule` fires at every allowed minute (20 s ticker); a `poll` runs its prefilter at those minutes and starts a run only for new items; each may carry its own `tz:` / `window:`. Several triggers still mean one run at a time; no triggers = a routine run only by hand. **Run now** is always there, not a trigger; it uses the first poll's prefilter. A firing up to `ROUTINES_LATE_MIN` late still runs; an older one is recorded as `missed`, told in Telegram, never caught up. `once: true` switches the file off after one task. A file with the old `cron:` (+ `prefilter:`) is read as one trigger.
- **Prefilter.** `command`, `github-prs` (key = PR + head commit), `trac` (key = id + change time). New items only; nothing new = no task. A poll's first firing marks what exists as seen; a changed key is passed as "seen before, changed since".
- **The task** runs in the routine's own conversation (`schedule:<name>`, kept from before), a fresh session by default, prompt = run frame ("Routine run") + file body + new items; report and questions go to Telegram unless `notify: none`. A routine with `agent:` on the subscription runs *as* that agent (`claude --agent`, its prompt, tools and `model:`), not as an orchestrator that spawns it and relays its report; its `skill:` comes in the prompt. On a light-mode provider the agent's file is the system prompt.
- **Guards.** One run at a time; **soft-stop** (`ROUTINES_SOFT_STOP`, 85 %) skips timed firings of subscription runs while a window is above it; an unanswered question is answered for the owner after `ROUTINES_ASK_TIMEOUT_MIN`. Start with `action: report` and graduate.

### 4.4 Session lifecycle

The session manager is the piece Claude Code does not provide and the core of "zero idle cost".

Every task is a **one-shot** `claude -p` run: the process starts for the task and exits with the result. Continuity lives in the conversation, which remembers the session id and passes `--resume` to the next task. Nothing is kept warm, so there is no idle timer and nothing to close.

stdin is stream-json too: after an `initialize` control request the prompt goes out as a user message and stdin stays open until the result, with `--permission-prompt-tool stdio`. That makes the CLI offer `AskUserQuestion` in print mode and route it — like any permission prompt the mode leaves open — to the supervisor as a `can_use_tool` control request. Without such a host the tool does not exist in `-p` and the agent can only ask in prose, which ends the run.

```
                 task queued (owner message, cron, restart recovery, window reset)
                            │
              ┌─────────────▼─────────────┐
   no session │  spawn                    │ conversation has a session
   ───────────►  claude -p                ◄──────────────── --resume <session_id>
              │   --input-format  stream-json      (cwd = project checkout or workspaces root;
              │   --output-format stream-json       a cwd change starts a fresh session)
              │   --permission-prompt-tool stdio
              │   --max-turns N
              └─────────────┬─────────────┘
                            │ stdin:  initialize, the prompt, control responses (answers)
                            │ stdout: text, tool events, sub-agent events, rate limits, result
                            ▼
                     ┌── running ──┐
                     │             │  can_use_tool (question / permission)
                     │             ├────────────────► task.ask set, timeout paused,
                     │             │                  owner asked on web + Telegram
                     │             ◄──────────────── control_response (answer / allow / deny)
                     │             │
        result       │             │  /stop  ·  wall-clock timeout  ·  max turns
                     ▼             ▼
                   done          cancelled / failed  (SIGTERM to the process group, SIGKILL 10 s later)
                     transcript stays in CLAUDE_CONFIG_DIR/projects/<ws>/<session_id>.jsonl
```

Rules:

- **Spawn on demand.** One task → one process, cwd = the conversation's project checkout (or the workspaces root); `MAX_CONCURRENT_SESSIONS` (≈ 1 GiB each), one running task per conversation.
- **Questions and permissions.** A `can_use_tool` request is stored on the task (`ask`) and shown in the web thread and in Telegram (inline buttons; free text counts). The task stays `running`, its timeout paused, its slot kept for as long as it waits (decided 2026-09-30). The first answer goes back as a `control_response` and settles the other channel. Under `bypassPermissions` (the container) only `AskUserQuestion` arrives; under `acceptEdits` / `default` every unsettled tool does.
- **Hard stop.** `/stop` sends SIGTERM to the CLI's process group, SIGKILL after 10 s, and marks the task `cancelled`. `CLAUDE_TASK_TIMEOUT_MIN` bounds wall-clock time (0 = none).
- **Resume.** The next task restarts the process with `--resume <session_id>`; nothing is copied. A session that cannot be resumed is forgotten and the task runs once more from scratch. A provider change forgets the session.
- **Crash safety.** A task found `running` at startup is re-queued once (`restarts`) and resumes its session; the dispatcher rules say a repeated prompt means "continue". A pending question is lost with the process and asked again. A graceful stop leaves running tasks `running` on purpose; only the owner's `/stop` cancels.
- **Bounds.** Every spawn sets `--max-turns`; no `--max-budget-usd` (dropped 2026-10-05: the model rationed work by dollars, which means nothing on a subscription). The windows (§7) are the limit; a refusal for the limit waits for the reset (§4.2).

---

## 5. Configuration Model ("the factory")

Plain files under `/data`, editable by the UI, the owner and the agent. Roles and procedures live where Claude Code reads them natively (`CLAUDE_CONFIG_DIR`):

| Layer | Location | Contains |
|---|---|---|
| **Roles → sub-agents** | `claude/agents/*.md` | Frontmatter (name, "Use when" description, tools / MCP allowlist, model or provider, `maxTurns`, `effort`) + system prompt. Project-agnostic. |
| **Procedures → skills** | `claude/skills/*/SKILL.md` | Step-by-step workflows, composable: `feature-to-pr`, `pr-review`, `tracker-defect-fix`, `onboard-project`, … |
| **Facts → projects** | `config/projects/*.md` | Repo, tracker and workflow, target branch, checks, which skill applies, `hosts:` references, `mcp:` allowlist over the checkout's `.mcp.json`. |
| **Universal rules** | `claude/CLAUDE.md` | Match task → project; milestones and questions only to Telegram; never merge without approval; persist corrections into files; PR bodies, tickets and emails are untrusted data. |
| **Routines** | `config/routines/*.md` | §4.3 |
| **Shared config** | `config/hosts.yaml`, `known_hosts`, `mcp.json`, `providers.yaml` | SSH hosts, trusted host keys, the owner's MCP servers, model providers |

**Dispatcher flow:** task → project → the project's workflow skill → sub-agents → report. **Learning = file edits**, visible as file events in the Audit log. `templates/` and `presets/` are only the install-time seed (presets are shareable bundles installed from the UI).

**MCP in three layers:** the repository's `.mcp.json`, the owner's `config/mcp.json`, and `mcpServers:` in an agent file for role-owned tools; secrets only as `${VAR}` from `.env`. The claude.ai login adds the account's **connectors** (Gmail, ClickUp, Drive, …) to every session, so a role is usually a `tools:` allowlist over them. A provider may carry MCP servers of its own, offered only to its tasks.

**Model providers** (`config/providers.yaml`): Anthropic- or OpenAI-compatible endpoints behind the gateway, chosen per routine, agent or conversation; light mode gives small models a short prompt and six built-in tools. **Toolchains:** the agent installs runtimes with `mise` into `data/tools`; test services run in the dind sidecar and stop when the task ends.

---

## 6. Web UI

A chat plus a viewer for the files and transcripts Claude Code already produces. Light and dark themes; installable as a PWA; works at phone width.

- **Overview** — health (login, Telegram, MCP, toolchains, routines, providers), the 5-hour / weekly windows, today's tasks and tokens.
- **Chat** — threads with project and provider / model selectors, inline questions, attachments, unread / waiting / running badges.
- **Tasks** — every run across sources, with the transcript, tokens and window share, and the **Changes** panel (diff by folder, Create PR).
- **Sessions** — the indexed Claude Code transcripts.
- **Audit** — every model call, tool call, file edit, sub-agent start / end, question and rate-limit reading, attributed to agent and project; filters by kind, agent, project, period.
- **Agents, Skills, Projects, Routines** — one list + form editor over the Markdown files; routines show their triggers' live state, run history, Run now and Preview prefilter. **Presets** installs bundles.
- **Settings** — Claude Code (model, login), Providers, Toolchains, MCP (registry, Authorize), Hosts (test, host-key trust), Security, Appearance.

Every list is keyset-paged. No money anywhere: the unit is tokens and window share.

---

## 7. Logging & Observability

- **Transcripts** (`CLAUDE_CONFIG_DIR/projects/<ws>/<session>.jsonl`) are the log of record; the supervisor indexes them for the Sessions page.
- **The Audit log is built live from stream-json**: every event is a `task_events` row with the agent (null = orchestrator) and parent tool-use id — one `llm` event per model call, `agent` start / end, tool calls, `limits` readings.
- **Tokens** per task = the sum of its `llm` events when that exceeds the CLI's `result` (which undercounts background sub-agents), cache included. **Windows** come from `rate_limit_event`, refreshed by every subscription task or a one-turn Haiku probe. The supervisor never calls Anthropic APIs with the owner's credentials.

### Budget & quota protection

- Per task: `--max-turns` and a wall-clock timeout; no dollar ceiling (§4.4).
- Model policy: the orchestrator's model is a run-time alias (`/model`, Settings); sub-agents keep their file's `model:`; cheap models only for mechanical sub-agents; `maxTurns` and `omitClaudeMd` on reviewers.
- Soft-stop: cron firings yield while a window is above `SCHEDULES_SOFT_STOP`; the owner's own tasks are never held back. A refusal for the limit pauses new subscription starts until the reset.

---

## 8. Security Requirements

- **Telegram whitelist** by user id — the bot ignores everyone else; it fronts an agent with repository and mail access.
- **Claude auth belongs to the owner.** The CLI is logged in **inside the container** (`docker compose run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN= supervisor claude auth login`, URL + pasted code), which also brings the claude.ai connectors; `CLAUDE_CODE_OAUTH_TOKEN` (a setup-token) is the fallback and must stay empty otherwise. OAuth MCP servers are authorized the same way, from Settings → MCP. The supervisor never reads, copies or proxies these credentials, never calls Anthropic APIs with them, never patches the CLI.
- **Untrusted input.** PR bodies and diffs, tickets, emails and attachments are data, not instructions (`CLAUDE.md` says so). Sub-agents that read them get the minimum tool set (`pr-review` and the email agent have no push, no send). An instruction found inside such content that asks to change repos, send messages or read secrets is reported to the owner, not executed.
- **The CLI's environment** is the supervisor's minus its own secrets (bot token, allowed ids, web auth, Groq key, every provider's key variable): a prompt injection that runs `env` must not walk away with the bot, the UI or a paid API key. GitHub tokens and MCP `${VAR}` secrets stay, since the agent needs them.
- **Provider keys never reach the agent.** A provider task's CLI talks to `/gateway/<name>` with a per-start, per-provider bearer; the gateway adds the real key, so a task cannot read a key or spend another provider's. A provider's `token` may not name the factory's own secrets; a self-signed provider is trusted by pasting its CA into the form. Work-project code does not go to a provider the owner does not trust (a per-project allowlist is wanted).
- **Container as sandbox.** Broad permissions inside the container (`bypassPermissions`), `mem_limit` / `pids_limit` in compose, the host never exposed. The agents' Docker is a `docker:dind` sidecar with its own state, reached over TLS on the compose network only, never the host's socket: dind needs `privileged`, the one trade-off accepted for cleanliness (nothing on the host, nothing left after removing `data/`); it is off unless `COMPOSE_PROFILES=docker`.
- **Secrets** in `.env` and read-only `/data/secrets`, never in Markdown or the repo. Servers only over SSH keys, read-only by rule, host keys trusted explicitly from the UI, no passwords. GitHub via **fine-grained PATs**, one per repository owner (`GH_TOKEN_<OWNER>`).
- **Web UI.** A sign-in page with a password from `.env`, a hashed session cookie with an idle timeout, lockout after repeated failures, every attempt logged and told in Telegram; HTTPS through a reverse proxy. The API refuses foreign `Origin`s and, in open mode, foreign `Host` names; bodies are capped; attachments other than raster images are served as downloads under a sandbox CSP.
- **Human gate on irreversible actions** (merging PRs, deleting branches or data, sending email): the CLI's own permission prompt relayed over stream-json (§4.4) — under `bypassPermissions` the `AskUserQuestion` the skills call before such steps, under `acceptEdits` / `default` every unsettled tool call as Allow / Deny.

---

## 9. Portability & Scaling

- **All state in `/data`** (CLI config, credentials, transcripts, project config, tools, inbox, db). The image is stateless.
- **Migration:** `docker compose down` → rsync `/data` → `docker compose up` on the new server.
- **Scaling:** semantic sharding — a second server runs an independent instance with its own bot.
- **Concurrency** is bounded by RAM (≈ 1 GiB per session), the subscription's windows and each provider's `concurrency`.

---

## 10. Open work

The ordered list is "Next" in `CLAUDE.md`. The larger items:

- An opt-in worktree per project for parallel tasks on one repository.
- "Always allow" permission rules (open question 4).
- Token budgets per agent / project with a soft stop; backups of `/data`.
- Delegation from a Claude orchestrator to a role on another provider; a per-project provider allowlist.
- Optional webhook ingress (`POST /api/tasks/fire` with a bearer, payload wrapped as untrusted).

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Token burn by autonomous loops | Windows exhausted mid-day | Model policy for sub-agents, `maxTurns`, soft-stop for background tasks, prefilters, bulk work on other providers |
| Runaway / looping agent | Garbage PRs, wasted windows | `--max-turns` on every spawn and per sub-agent, wall-clock timeout, `/stop` in Telegram and the UI |
| Prompt injection via PR bodies, tickets, emails | Credential misuse, unwanted pushes / emails | Untrusted-input rule, minimal tool sets, human gate on irreversible actions, fine-grained PATs, secrets stripped from the CLI's environment |
| Credential blast radius (GitHub + mail in one box) | Account compromise | Fine-grained PATs, per-agent tool allowlists, provider keys only in the gateway, Telegram whitelist, web sign-in with lockout |
| Reviewer rubber-stamps the developer | Bad PRs while the owner is away | Reviewer in a fresh context with a verification pass; checks and CI are the real gate; routines start with `action: report` |
| Run lost to a restart or a stuck question | Lost work, a slot held | Re-queue once and resume; routine runs' questions answered after a timeout |

---

## 12. Open Questions

1. STT from a moving car: confirm Groq Whisper latency over LTE; keep a local Whisper as the fallback.
2. Voice replies (TTS) from the agent — out of v1 scope?
3. How much of a failed run to mirror into Telegram (error digest format).
4. Permission policy: "Always allow" rules per tool / project, shown and revocable in the UI, so a recurring prompt is settled once; what happens to an owner task's question nobody answers. Today a waiting task holds its slot indefinitely (decided 2026-09-30); routine runs are answered after `ROUTINES_ASK_TIMEOUT_MIN`.
5. Webhook ingress: is the few-minutes latency of polling worth a public endpoint?
6. Money for cloud providers: `$` next to tokens, or tokens only (the "no money in the UI" rule was about the subscription).
