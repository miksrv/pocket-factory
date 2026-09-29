# Pocket Factory — Requirements & Specification

> **Tagline:** *"An agent becomes truly autonomous the moment you close your laptop lid."*
>
> Status: Draft v1.3 · Date: 2026-09-28 · Author: Misha Topchilo (with Claude)
>
> **v1.3 changes:** the concept is stated as a self-hosted layer over Claude Code for developers with four pillars — autonomy, control over what agents do, management of agents / skills / projects, pipelines. Money is gone from the product (tokens and subscription windows instead); the config git history is replaced by the Audit log built live from stream-json; every list pages dynamically; agents are a card roster with live activity; models and tools come from the subscription and the CLI.
>
> **v1.2 changes:** decisions recorded from the implementation: the agent works in the owner's real checkouts on a branch (no per-task worktrees); the web UI is a Vite/React SPA served by the supervisor (no Next.js service); sessions are one-shot `claude -p` runs resumed by id, so idle timeout is a no-op; config history is two git repositories on the volume; project files carry `hosts:` for SSH access; presets are shareable bundles. Phases 0–4 implemented.
>
> **v1.1 changes:** the agent runtime is the owner's own, unmodified **Claude Code CLI** (subscription login), supervised by a thin always-on process — not a custom Agent SDK application holding a token. Added the session lifecycle model (spawn on demand, tear down on idle / explicit finish, resume from disk). Dropped Langfuse and the custom events table in favour of Claude Code's own JSONL transcripts. Closed the auth question. Added prompt-injection requirements and the conditions under which others may reuse the template.

---

## 1. Vision & Concept

A **self-hosted layer over Claude Code for developers**: a containerized personal agent platform that lives on a VPS and works autonomously while the owner is away. It adds four things the CLI alone does not have — autonomy (tasks queue and run without a terminal), control over what agents do (an audit log per agent and project), management (agents, skills, projects as files with a UI) and pipelines (skills chaining sub-agents into repeatable flows). Think of it as `/rc` (remote control) for Claude Code, but through Telegram and without a laptop: the owner is driving to a conference, gets a message that a hotfix is needed, records a voice note to the bot — and the agent does the work and reports back.

The system is a thin **supervisor** around the owner's own **Claude Code** installation. The supervisor receives tasks from multiple triggers — Telegram messages (text and voice), cron schedules, and (optionally) external webhooks — and hands them to a Claude Code session, which decomposes them, spawns specialized **sub-agents** (developer, reviewer, QA, email assistant, …) via Claude Code's native sub-agent mechanism, iterates until the work is done, and reports back through the channel the task came from.

The platform is an **agent factory**: new sub-agents, skills (workflows), and project definitions are plain Markdown files in Claude Code's own configuration directory. They can be created and edited both through a web UI and conversationally through Telegram ("create an agent that triages my email"). Everything — configuration, credentials, knowledge base, transcripts — lives in a single data volume, making the whole system trivially portable between servers.

Inspiration: Guild.ai's "Software Factory" (specialized agents producing ready pull requests) — but personal, self-hosted, Telegram-first, and fully owned by the developer. Closest first-party analogue: Claude Code Channels (Telegram/Discord bridge to a running session) — but with a task queue, on-demand session lifecycle, schedules and a web UI on top.

### Core principles

1. **Zero idle cost.** Claude Code is spawned per task, not kept alive. Tokens are consumed only while a task is running; RAM is consumed only while a session is open. When there is nothing to do, only the cheap deterministic supervisor (bot polling, scheduler, web UI) is awake.
2. **Claude Code is the agent; we are the supervisor.** The tool never modifies the Claude Code binary, never handles the owner's credentials, and never re-implements what Claude Code already does (sub-agents, skills, sessions, memory, MCP, transcripts). The supervisor adds only what Claude Code lacks: a Telegram front-end, a task queue, schedules, lifecycle management, and a UI over the files.
3. **Everything is a file.** Sub-agents, skills, project knowledge, and global rules are Markdown files on a volume. The UI and the agent itself edit the same files. No hidden state. Every change the agent makes to its own configuration is a file event in the Audit log (§6.9), attributed to the task and agent that made it.
4. **Deterministic pre-filter before LLM.** Polling, event filtering, and deduplication are done by plain code. Claude Code is invoked only when there is real work.
5. **Facts ≠ procedures ≠ roles.** Project facts live in the knowledge base, step-by-step workflows live in skills, roles live in sub-agent definitions, universal rules live in `CLAUDE.md`. No duplication.
6. **Portable by design.** One Docker Compose stack + one `/data` volume = the entire system. Migration is `rsync` + `docker compose up`.
7. **Template for others.** No personal facts hardcoded in the codebase — any developer can fork the repo, log in to Claude Code with **their own subscription**, add their own Telegram bot and projects, and get their own factory. The tool is strictly single-owner: it never offers Claude login inside its own UI, never stores or proxies anyone's Claude credentials, and never intermediates Claude usage for a third party. Each installation is billed to its owner under the owner's own agreement with Anthropic.

---

## 2. Goals & Non-Goals

### Goals

- Autonomous execution of multi-step software tasks (feature → PR → review → fixes → report) without supervision.
- Telegram as the primary human channel: task input (text + voice), progress milestones, clarifying questions, final reports. Only essential information — details live in the UI.
- Web UI for observability and administration: agents, skills, projects, schedules, task log, session transcripts, token analytics and subscription-window (5-hour / weekly) visibility.
- Event-driven task creation: Telegram, cron schedules with UI management, and optionally external webhooks (GitHub).
- Support for multiple independent repositories (personal and organization-owned) with per-project workflows, credentials, and conventions.
- Human-in-the-loop: the agent pauses and asks the owner via Telegram when it hits ambiguity or a decision gate; runs resume after the answer.
- Self-improvement loop: corrections given via Telegram ("remember: in this project always update the CHANGELOG") are persisted by the agent into its own knowledge files (visible as file events in the Audit log).
- Session lifecycle under the owner's control: sessions close on idle timeout, on explicit "done", or on a Telegram command, and can be resumed later with full context.

### Non-Goals (v1)

- Multi-tenant / team usage. This is a single-owner system (whitelist of one or few Telegram IDs belonging to the same person).
- Enterprise fleet management, RBAC, SSO, compliance (that is Guild.ai's territory).
- A general-purpose chat assistant. The system is task-oriented.
- Horizontal autoscaling. Scaling model is "one more VPS with its own instance".
- Re-implementing the agent loop, sub-agents, tracing, or memory. Claude Code provides these; the tool wraps them.

---

## 3. Use Cases

### UC-1 — Feature task in a personal project (via Telegram)

> "In my personal project, URLs in the `/photos` section must change from numeric IDs to SEO slugs like `12245-andromeda-galaxy`."

1. Owner sends the message (text or voice) to the Telegram bot.
2. Voice is transcribed (STT); the supervisor creates a task and spawns a Claude Code session.
3. Claude Code matches the message to the `photos` project via the knowledge base, applies the `feature-to-pr` skill.
4. Spawns *developer* sub-agent (branch, implementation, tests) → *reviewer* sub-agent (diff review, fresh context) → fix loop until review passes → runs the project's checks.
5. Opens a PR via `gh`, sends a Telegram report: "PR ready: <link>. Summary of changes…". Session is closed after the idle timeout or when the owner replies "done".

### UC-2 — Organization task from ClickUp (via Telegram)

> "In project webshop take ClickUp task DEV-1234 and do it."

1. Claude Code matches `webshop` → org repo, ClickUp workspace, `clickup-task` skill.
2. Reads the task via ClickUp MCP. If ambiguous — sends batched clarifying questions to Telegram; the task goes to `waiting_for_user`, the session is kept warm for a while and then released; the owner's reply resumes it.
3. Branch `feature/DEV-21234-…`, developer → reviewer → QA loop, PR to the branch defined in project config.
4. Posts a comment on the ClickUp task with the PR link, transitions the task status to *Review*.
5. Telegram report: "DEV-21234 done, PR ready, task moved to Review."

### UC-3 — GitHub review request (via polling or webhook)

1. Someone requests the owner's review / mentions them on GitHub.
2. Default: a **prefilter schedule** polls `gh api` every few minutes and diffs against `seen_items` — no public endpoint needed. Optional: a webhook endpoint with signature verification and in-code event filtering (only `review_requested` / mention create a task).
3. Claude Code applies the `pr-review` skill: reads the PR diff and context, performs the review, posts comments on the PR. The `pr-review` skill runs with **read-only repository tools** — PR bodies and diffs are untrusted input.
4. Telegram notification: "Reviewed org/repo#123: 2 issues found, comments posted."

### UC-4 — Scheduled TRAC defect monitor (via cron)

1. Schedule: hourly, working hours only (Mon–Fri, configurable window).
2. **Deterministic pre-filter script** (no LLM): polls the TRAC API, diffs ticket IDs against the `seen_items` table. No new defects → zero tokens spent, no session spawned.
3. New relevant defect → task created with the `trac-defect-fix` skill: reproduce on staging, find root cause, branch, fix, review loop, PR.
4. Telegram report: "Defect #46812 fixed, PR ready: <link>."

### UC-5 — Creating a new sub-agent (via Telegram or UI)

> "I need an agent that triages my inbox and prepares draft replies."

- Via Telegram: Claude Code itself writes `agents/email-agent.md` (+ skill + MCP binding) and confirms; the edit shows up in the Audit log. Next time a mail-related task arrives, the dispatcher knows to spawn it.
- Via UI: the owner creates/edits the same Markdown file in the agent editor (form for frontmatter: name, trigger description, allowed tools/MCP, model + prompt body).

### UC-6 — Onboarding a new project

> "Connect project X: repo <url>, tasks in ClickUp."

The `onboard-project` skill interviews the owner (PR target branch, branch naming, pre-PR checks, tracker workflow), inspects the repo itself (README, CI config, conventions), and generates `projects/x.md`. The owner reviews/edits it in the UI.

### UC-7 — Teaching / correcting behavior

> "Remember: in webshop always update CHANGELOG before the PR."

Claude Code edits the corresponding project file or skill itself and confirms. The UI editors and the Audit log (file events per task) are used to audit and clean up accumulated knowledge.

### UC-8 — Ending a session

The owner writes "thanks, we're done", sends `/done`, or simply stops replying. The supervisor terminates the Claude Code process (immediately on explicit finish; after the idle timeout otherwise). The transcript stays on disk; a later message on the same topic resumes the session with full context.

---

## 4. System Architecture

```
                     ┌──────────────────────── VPS · docker compose ────────────────────────┐
 Telegram ◄─────────►│  supervisor (always on, no LLM)                    web              │
 (text / voice)      │  ┌──────────────────────────────────────────┐     ┌──────────────┐  │
 GitHub (polling ───►│  │ telegram bot (long polling) + STT        │     │ Next.js UI   │  │
  or webhook)        │  │ task queue · scheduler · prefilters      │◄────│ agents/skills│  │
                     │  │ session manager: spawn / feed / resume / │     │ projects     │  │
                     │  │   idle-timeout / kill                    │     │ schedules    │  │
                     │  └───────────────┬──────────────────────────┘     │ tasks/       │  │
                     │                  │ stdio (stream-json)            │  transcripts │  │
                     │                  ▼                                │ cost dash    │  │
                     │  claude -p  (unmodified Claude Code CLI,          └──────────────┘  │
                     │              owner's own login, 0..N processes)                     │
                     │              └─ sub-agents · skills · MCP                           │
                     │                                 │                                    │
                     │                                 ▼                                    │
                     │  /data volume: claude/ (CLAUDE_CONFIG_DIR: credentials, agents,     │
                     │  skills, transcripts) · config/ (projects, git) · workspaces ·      │
                     │  db (SQLite) · secrets (PATs, MCP)                                  │
                     └──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Components

| Component | Responsibility | Tech |
|---|---|---|
| **supervisor** | Telegram bot (long polling — no public IP required), voice → text (STT), task queue + worker, scheduler + prefilters, optional webhook endpoint, **session manager** (spawn Claude Code, stream messages in/out, resume, idle timeout, kill), delivery of reports/questions back to Telegram, transcript indexing and cost accounting | Node.js/TypeScript, grammY, node-cron, `child_process` around `claude -p` |
| **claude** | The agent itself: dispatcher prompt, sub-agents, skills, MCP, sessions, memory. Unmodified Claude Code CLI, logged in by the owner. Not a long-running service — spawned per task, 0..N processes at a time | `@anthropic-ai/claude-code` (pinned version), `git`, `gh`, project runtimes |
| **web** | Admin & observability UI (see §6) | Vite + React SPA, built into the image and served by the supervisor; SSE for live output |
| **db** | Tasks, schedules, seen-items, session index, usage aggregates | SQLite on the volume (WAL mode) |

The container image also ships: `git`, `gh` CLI, project runtimes as needed (node, yarn, …).

### 4.2 The trigger → task model (central abstraction)

Every source converges into one queue:

```
tasks (
  id, source,            -- telegram | webhook | cron | ui
  idempotency_key,       -- dedup: webhook retries, overlapping cron runs
  project,               -- resolved project slug (nullable until dispatched)
  prompt, payload_json,  -- user text / webhook payload / schedule prompt
  status,                -- queued | running | waiting_for_user | done | failed | cancelled
  session_id,            -- Claude Code session id (for --resume)
  reply_to,              -- where to report: telegram chat, PR, clickup task…
  created_at, started_at, finished_at,
  tokens_in, tokens_out, cost_usd
)
```

Rules:

- **Idle = free.** The worker spawns Claude Code only for queued tasks.
- **Dedup** via `idempotency_key` (e.g. webhook delivery ID, `schedule_id + fire_time`).
- **Workspace:** the agent works inside the owner's real checkout on a branch — no worktrees, no re-cloning (decided during Phase 0; the owner's repositories are bind-mounted and expected to stay in the state the owner left them). One running task per conversation; tasks touching the same repository are the owner's responsibility to sequence for now.
- **Pause/resume:** clarifying questions flip the task to `waiting_for_user`; the Telegram reply resumes the stored session.
- **Cancellation & steering:** the owner can stop a running task or inject a mid-run instruction from Telegram/UI (`/stop`, `/done`, free text while a task runs).

### 4.3 Schedules

```
schedules (id, name, cron_expr, active_window,   -- e.g. Mon–Fri 09:00–18:00 TZ
           type,          -- 'prompt' | 'prefilter'
           prefilter_ref, -- script to run first (poll → diff → maybe create task)
           prompt, skill, project, enabled, last_run_at)
```

- Type **prompt**: fire → create an agent task directly.
- Type **prefilter**: fire → run a deterministic script (e.g. TRAC poller or GitHub review-request poller with `seen_items` diff); a task is created only when the script emits one. This is the default pattern for all polling-style automations.
- Fully managed in the UI: create, edit, enable/disable, "run now", last-run status.

### 4.4 Session lifecycle

The session manager is the piece Claude Code does not provide and the core of the "zero idle cost" promise.

> **As implemented (v1.2):** every task is a one-shot `claude -p` run; the conversation remembers the session id and the next task in the same conversation resumes it with `--resume`. There is no process to keep warm, so the idle timer below is a no-op and "explicit finish" is simply the owner opening a new conversation (`/new`). Questions from the agent are its final message; the owner's reply is the next task on the same session. The diagram is kept as the design for long-lived interactive sessions (`--input-format stream-json`) should they ever be needed.

```
                 task queued / owner message
                            │
              ┌─────────────▼─────────────┐
   no session │  spawn                    │ session on disk
   ───────────►  claude -p                ◄──────────────── --resume <session_id>
              │   --input-format  stream-json
              │   --output-format stream-json
              │   --max-turns N [--max-budget-usd X]
              └─────────────┬─────────────┘
                            │ stdin: owner messages, tool answers
                            │ stdout: assistant text, tool events, result (usage, cost)
                            ▼
                     ┌── running ──┐
                     │             │
        result msg   │             │  question to owner
        received     │             │  → waiting_for_user (process kept warm)
                     ▼             ▼
               ┌─────────── idle ───────────┐
               │  timer: IDLE_TIMEOUT (default 30 min)
               │  reset by any owner message or new queued task for this session
               └──────────────┬─────────────┘
                              │ timeout  ·  or  owner: "done" / /done  ·  or  /stop
                              ▼
                     SIGTERM → process exits
                     transcript stays in CLAUDE_CONFIG_DIR/projects/<ws>/<session_id>.jsonl
```

Rules:

- **Spawn on demand.** One task → one `claude -p` process with its own `cwd` (the task's worktree). Several may run concurrently (bounded by `MAX_CONCURRENT_SESSIONS`, RAM ≈ 1 GiB each).
- **Idle timeout** is per session, configurable globally and per project. "Idle" means: no owner input, no queued follow-up, and the last output was a `result` message (not mid-tool-call). A running tool call is never interrupted by the idle timer.
- **Explicit finish.** Any of: the owner's message classified as a closing phrase ("thanks, done", …) by a cheap in-code matcher, the `/done` command, or the agent's own final report followed by no follow-up. The process is terminated immediately; the task is marked `done`.
- **Hard stop.** `/stop` sends SIGTERM regardless of state and marks the task `cancelled`.
- **Resume.** A later message that the supervisor routes to a finished/idle-killed task (reply in the same Telegram thread, or explicit `/resume <task>`) restarts the process with `--resume <session_id>`. Context continuity is Claude Code's own transcript, nothing is copied.
- **Crash safety.** If the supervisor restarts (deploy, reboot, crash), running CLIs are lost. A task found `running` at startup goes back to the queue and its next run resumes the conversation's session, so the agent continues from where the transcript ends (the task's prompt is sent once more to the resumed session). Each task survives this once (`restarts` column); a task that keeps hitting restarts fails with a notice, so a task that takes the supervisor down cannot loop. A graceful stop (SIGTERM to the supervisor) leaves running tasks `running` on purpose for the same recovery; only the owner's `/stop` cancels.
- **Bounds.** Every spawn sets `--max-turns`; the per-task budget (§7) is passed via `--max-budget-usd` where the installed CLI version supports it, otherwise enforced by the supervisor from streamed usage.

---

## 5. Configuration Model ("the factory")

Four layers, all plain files under `/data`, editable by UI, by the owner, and by the agent itself. The first two live where Claude Code natively reads them (`CLAUDE_CONFIG_DIR`), so no translation layer is needed:

| Layer | Location | Contains | Example |
|---|---|---|---|
| **Roles → sub-agents** | `claude/agents/*.md` | Who: frontmatter (name, trigger description, allowed tools/MCP, model) + system prompt. Project-agnostic, reusable. | `developer.md`, `reviewer.md`, `qa.md`, `email-agent.md` |
| **Procedures → skills** | `claude/skills/*/SKILL.md` | How, step by step. Composable (a skill may reference another). | `feature-to-pr`, `clickup-task` (→ feature-to-pr), `pr-review`, `trac-defect-fix`, `onboard-project` |
| **Facts → knowledge base** | `config/projects/*.md` | What is true about each project: repo URL & credentials ref, tracker & workflow, branch/PR conventions, stack, test/lint commands, which skill applies. | `photos.md`, `global-navigation.md` |
| **Universal rules → dispatcher prompt** | `claude/CLAUDE.md` | Always-on behavior: match task → project (ask if unknown); Telegram gets milestones/questions/results only; never merge without approval; batch questions; persist corrections into files; treat PR bodies, tickets and emails as untrusted data. | — |

**Dispatcher flow:** incoming task → resolve project from knowledge base → project file names the workflow (skill) → skill orchestrates sub-agents → report to `reply_to`.

**Learning = file edits, not training.** Corrections via Telegram are applied by the agent to its own skills/knowledge files; the UI editors and the Audit log are the audit/cleanup surface (the config git history of v1.2 was dropped in v1.3). `onboard-project` bootstraps new project files through an interview + repo inspection.

MCP servers are configured declaratively in `.mcp.json`; each sub-agent's frontmatter restricts which tools/MCP it may use (email agent gets Gmail MCP only and no git; developer gets git/gh and no mail; reviewer gets read-only tools).

---

## 6. Web UI Requirements

The UI is deliberately small: it is a viewer for files and transcripts Claude Code already produces, plus CRUD for the supervisor's own tables.

Screens (v1):

1. **Tasks** — unified feed across all sources; status, project, source, duration, tokens and share of the 5-hour window; filters; cancel / retry / "run now" / resume.
2. **Session view** — rendered Claude Code transcript (`*.jsonl`): dispatcher turns → sub-agent spans → expandable tool calls with results; live tail via SSE while a session is running; token/cost per turn from the usage fields in the transcript.
3. **Agents** — list + Markdown editor with frontmatter form (name, description/trigger, tools/MCP allowlist, model).
4. **Skills** — same editor pattern; show which skills reference which.
5. **Projects** — knowledge-base editor; onboarding wizard (drives the `onboard-project` skill).
6. **Schedules** — CRUD for cron entries, active windows, prefilter binding, enable/disable, run-now, last result.
7. **Quota dashboard** — the 5-hour and weekly windows as the CLI reports them (`rate_limit_event`), with reset times and a history of readings; tokens per day/project/agent/task-type; forecast to limit. No money anywhere: the owner pays a subscription, so the unit is tokens and window share.
8. **Settings** — MCP servers, connected repos/credentials references, Telegram whitelist, idle timeout, concurrency, budget policies. Shows Claude Code login status (`claude auth status`) but never performs the login.
9. **Audit log** — every model call (model, tokens), tool call, file edit, sub-agent start / end, task lifecycle and rate-limit reading, each attributed to the agent that produced it (orchestrator or sub-agent type) and the project the task worked in. Period selector, filter by kind / agent / project, expandable details. Built live from the stream-json events; there is no separate config git history (dropped in v1.3: the owner's repositories are on GitHub, and self-edits of agents / skills show up here as file events).

Non-functional: UI is behind auth (basic auth minimum; Tailscale/Cloudflare Access recommended) — it controls an agent holding GitHub and mail credentials.

---

## 7. Logging & Observability

- **Transcripts are the log of record.** Claude Code writes every session to `CLAUDE_CONFIG_DIR/projects/<workspace>/<session_id>.jsonl` (assistant messages, tool_use/tool_result, sub-agent activity, per-turn usage). The supervisor does not duplicate this; it indexes it:

```
sessions (session_id, task_id, workspace, started_at, ended_at,
          turns, tokens_in, tokens_out, cache_read, cost_usd, model)
usage_daily (date, project, agent, task_type, tokens_in, tokens_out, cost_usd)
```

- Tokens per task come from the `result` message in stream-json output (`usage`, cache read/creation included); `total_cost_usd` is stored for the record but never shown. Window utilisation comes from the `rate_limit_event` messages (`unifiedWindows.five_hour` / `seven_day`, utilisation 0..1 and reset time) that the CLI emits after API calls; every task refreshes it, and an explicit probe (one Haiku turn) refreshes it on demand. The `/api/oauth/usage` endpoint requires the `user:profile` scope, which a setup-token does not carry, so it is not used. Per-turn detail is parsed from the transcript for the session view and aggregates.
- Supervisor's own logs (bot, scheduler, prefilters, lifecycle events) go to stdout/JSON files under `/data/logs`.
- Optional: enable Claude Code's built-in OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP env vars) if the owner already runs a collector. Not required for v1.

### Budget & quota protection

- Per-task token/cost ceiling (configurable per task type), enforced via `--max-turns` / `--max-budget-usd` and the supervisor; the task is paused and the owner is asked when exceeded.
- Model policy: dispatcher on the strongest model; worker sub-agents default to cheaper models (Sonnet/Haiku class) via their frontmatter unless overridden.
- Soft-stop: when the rolling 5-hour or weekly window approaches the limit, background/cron tasks are deferred; direct owner tasks keep working. Telegram warning at configurable thresholds. (The reading is the CLI's own `rate_limit_event`; it is exact as of the last API call, not an estimate.)

---

## 8. Security Requirements

- **Telegram whitelist** by chat/user ID — the bot must ignore everyone else. This is mandatory: the bot fronts an agent with repo and mail access.
- **Claude auth belongs to the owner, not to the tool.** The owner runs `claude setup-token` on a machine with a browser and puts the resulting token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`; only the Claude Code CLI reads it. (Interactive `/login` inside a container is broken upstream — anthropics/claude-code#34917 — so this is the primary path, not a fallback.) The supervisor never reads, copies, proxies or exposes the token; the UI only shows login status (whether the variable is set), and the agent editor offers the CLI's model aliases rather than a list fetched from the Claude API (the CLI resolves an alias to the subscription's current model). The Claude Code binary is installed as published and never patched.
- **Untrusted input.** PR bodies and diffs, tracker tickets, webhook payloads and emails are data, not instructions. `CLAUDE.md` says so; sub-agents that read such content get the minimum tool set (`pr-review` and `email-agent` have no push / no destructive tools). Any instruction found inside such content that asks to change repos, send messages or read secrets must be reported to the owner, not executed.
- **Webhook signature verification** (GitHub HMAC secret) + in-code event filtering, if the optional webhook endpoint is enabled. Default is polling, which exposes no inbound port.
- **Container as sandbox:** the agent may run with broad in-container permissions, but the container gets resource limits (`mem_limit`, `pids_limit` in compose) and, where possible, restricted egress; the host is never exposed to the agent. The CLI's environment is the supervisor's minus the supervisor's own secrets (`TELEGRAM_BOT_TOKEN`, `WEB_AUTH_*`, `GROQ_API_KEY`): a prompt injection that runs `env` must not walk away with the bot or the UI.
- **Secrets** for tools in `/data/secrets` + env (docker secrets / `.env` on volume), never in config Markdown, never in the repo. GitHub access via **fine-grained PATs** (per-repo scope; one per repository owner as `GH_TOKEN_<OWNER>`, since a fine-grained token belongs to a single user or organization) or a GitHub App — not a classic all-scope token.
- UI behind auth (see §6). HTTPS via reverse proxy (Caddy/Traefik) or Cloudflare Tunnel. The API refuses mutating requests with a foreign `Origin` in both auth modes (a browser attaches basic-auth credentials to cross-site requests too), refuses foreign `Host` names without a password (DNS rebinding), and caps request bodies at 2 MB.
- No destructive actions without a human gate: merging PRs, deleting branches/data, sending email, and anything irreversible require explicit Telegram confirmation.

---

## 9. Portability & Scaling

- **All state in `/data`** (Claude Code config + credentials + transcripts, project config, workspaces, secrets, db, logs). The image is stateless.
- **Migration:** `docker compose down` → rsync `/data` → `docker compose up` on the new VPS. Everything moves: agents, skills, memory, login, history.
- **Scaling v1:** semantic sharding — a second VPS runs an independent instance (e.g. a dedicated mail instance), each with its own bot.
- **Concurrency** within one instance is bounded by RAM (≈1 GiB per open session) and by the subscription's usage limits, not by the supervisor.

---

## 10. Technology Stack (proposed)

| Concern | Choice | Rationale |
|---|---|---|
| Agent runtime | **Claude Code CLI**, unmodified, `claude -p` with `--input-format/--output-format stream-json` | The owner's own subscription and login; sub-agents, skills, sessions, memory, MCP, transcripts all built in. The tool only supervises. |
| Language | TypeScript / Node 22 | Single language across supervisor and UI; owner's stack. |
| Telegram | grammY | Long polling, mature middleware. |
| STT | Whisper via Groq API (default) or faster-whisper (local) | A small VPS CPU is slow for local Whisper; voice is occasional, API is cheap and fast. Local stays an option. |
| Queue/scheduler | SQLite table + worker; node-cron | Simplest thing that works. |
| DB | SQLite on volume (WAL) | Zero-ops, portable. |
| Web UI | Vite + React SPA served by the supervisor | One container, no SSR needed for an admin panel; same TypeScript types as the API. |
| Observability | Claude Code transcripts + SQLite index; optional OTEL export | Don't rebuild what the CLI already writes. |
| GitHub | `gh` CLI + fine-grained PAT / GitHub App | PRs, reviews, comments, polling. |
| Trackers | ClickUp MCP, TRAC API (custom prefilter script + MCP) | Per-project binding. |
| Deployment | Docker Compose; Caddy or Cloudflare Tunnel only for the UI (and webhooks if enabled) | Single-file infra. |

---

## 11. Roadmap

| Phase | Deliverable | Acceptance |
|---|---|---|
| **0. Skeleton** ✅ | Repo, Dockerfile (node + claude-code + git + gh), compose, `/data` layout, `claude setup-token` documented | `docker compose up` runs on a clean VPS; `claude -p "hi"` answers from inside the container |
| **1. Voice hotfix** ✅ (code) | Telegram bot + STT → `claude -p` in the owner's checkout → reply in Telegram; `developer`/`reviewer` agents, `feature-to-pr` skill, project file format + `onboard-project` | UC-1 end-to-end from a voice note: PR link comes back; zero tokens when idle — **still to be exercised on a real project** |
| **2. Lifecycle & persistence** ✅ | Task queue in SQLite, session manager (`/new`, `/stop`, `--resume`, one-shot runs), HITL questions via Telegram (agent's final message ↔ owner's reply), crash recovery (orphans failed, queued tasks resumed) | UC-2 and UC-8: a question survives a supervisor restart |
| **3. Web UI (read)** ✅ | Task feed + session view (transcript rendering, SSE live feed), overview with spend from the tasks table, **chat with Claude Code from the browser** | Owner can watch a live run and see spend without SSH |
| **4. Factory CRUD** ✅ | Agent/skill/project editors (projects incl. tracker + hosts), audit log, presets install, `onboard-project`, correction-to-file loop via CLAUDE.md rule | UC-5, UC-6, UC-7 work from both TG and UI; every agent self-edit is a file event in the Audit log |
| **5. Schedules** | `schedules` table + UI, prefilter pattern, TRAC poller, GitHub review-request poller | UC-3 and UC-4: zero tokens on empty polls |
| **6. Hardening** | Budgets/soft-stop, quota estimate, backups of `/data`, template-ization (README for forkers with the conditions from §1.7), optional webhook ingress | Quota forecast visible; fork-and-run documented and tested on a fresh account |

Phase 1 is deliberately the whole "driving to a conference" story: if it works, everything after is refinement.

---

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Token burn by autonomous loops (dispatcher + 3 sub-agents on a strong model) | Subscription window exhausted mid-day | Per-task budgets, model policy for sub-agents, soft-stop for background tasks, cost dashboard with forecast |
| Runaway/looping agent | Cost + garbage PRs | `--max-turns` on every spawn, per-sub-agent turn caps, idle timeout, kill switch (`/stop`) in TG and UI |
| Prompt injection via PR bodies, tickets, emails | Credential misuse, unwanted pushes/emails | Untrusted-input rule in `CLAUDE.md`, minimal tool sets per sub-agent, human gate on irreversible actions, fine-grained PATs |
| Credential blast radius (GitHub + mail in one box) | Account compromise | Fine-grained PATs, per-agent MCP/tool allowlists, container egress limits, TG whitelist |
| Usage-policy drift: limits assume "ordinary, individual usage"; heavy background automation could look otherwise | Account restricted | Keep cron/background work modest and prefiltered; owner-initiated tasks are the primary load; re-read the policy at each phase |
| Reviewer agent rubber-stamps the developer agent | Bad PRs while owner is away | Reviewer runs in a fresh context with diff + project rules only; deterministic checks (tests, lint, CI) are the real gate; start supervised (report before PR), graduate to full autonomy per project |
| Session killed mid-thought by idle timer | Lost work | Idle only counts after a `result` message; running tool calls are never interrupted; resume is always possible |
| Claude Code CLI changes flags/transcript format | Supervisor breaks | Pin the CLI version in the image; upgrade deliberately; integration test on `stream-json` shape |
| SQLite contention at scale | Slow UI during runs | WAL mode; Postgres migration path documented |

---

## 13. Open Questions

0. ~~Idle timeout / closing-phrase detection~~ — **moot in v1.2:** runs are one-shot; nothing stays warm. Revisit only if interactive `--input-format stream-json` sessions are introduced.

1. ~~Claude auth mode for production~~ — **Decided (v1.1):** the owner's own Claude Code login via `claude setup-token` → `.env`; the tool never holds credentials.
2. ~~Does the pinned Claude Code version support `--max-budget-usd`?~~ — **Yes** (verified on 2.1.283); the CLI enforces it.
3. ~~Quota visibility~~ — answered 2026-09-28: `claude -p --output-format stream-json` emits `rate_limit_event` with `unifiedWindows.five_hour` / `seven_day` utilisation and reset times (CLI 2.1.283); works with a setup-token. Implemented (§7).
4. STT: confirm Groq Whisper latency/cost from a moving car (LTE); keep faster-whisper as a fallback for offline-ish VPS setups.
5. Closing-phrase detection: pure keyword list + `/done`, or let the agent emit an explicit "session can be closed" marker in its final report?
6. Voice replies (TTS) from the agent — nice-to-have, out of v1 scope?
7. How much of the transcript should be mirrored into Telegram on failure (error digest format).
8. Staging access pattern for UC-4 (how sub-agents reach the staging environment: SSH? VPN? MCP?) — must be resolved before Phase 5.
9. Webhook ingress: is anyone going to miss the few-minutes latency of polling enough to justify a public endpoint?

---

## Appendix A — Repository Layout (proposed)

```
pocket-factory/
├── docker-compose.yml
├── Dockerfile                # node 22 + @anthropic-ai/claude-code (pinned) + git + gh
├── .env.example
├── supervisor/               # telegram bot, STT, queue / session manager, HTTP API (TypeScript)
├── web/                      # Vite + React admin UI, served by the supervisor
├── templates/claude/         # seeded into data/claude (CLAUDE.md, agents/, skills/)
├── presets/                  # shareable agent + skill bundles, installable from the UI
├── prefilters/               # (Phase 5) deterministic pollers (trac.ts, github-reviews.ts, …)
└── data/                     # → mounted volume in production
    ├── claude/               # CLAUDE_CONFIG_DIR — owned by Claude Code
    │   ├── CLAUDE.md         #   dispatcher rules
    │   ├── agents/           #   developer.md, reviewer.md, …
    │   ├── skills/           #   feature-to-pr/, onboard-project/, …
    │   ├── projects/         #   session transcripts (*.jsonl), written by the CLI
    │   └── (credentials)     #   never touched by the tool
    ├── config/               # projects/*.md, mcp.json
    │   ├── projects/         #   photos.md, global-navigation.md, … (frontmatter: repo, branches, tracker, hosts, checks)
    │   └── .mcp.json
    ├── workspaces/           # the owner's checkouts (or WORKSPACES_DIR bind-mounted)
    ├── secrets/ssh/          # keys for project hosts → ~/.ssh in the container
    ├── db/                   # sqlite: conversations, tasks, task_events
    └── logs/                 # supervisor logs
```
