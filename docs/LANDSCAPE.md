# Landscape: what else drives Claude Code from a phone (2026-09)

A survey of projects that overlap with Pocket Factory, made to decide what to borrow and what to
leave alone. Facts come from each project's README / docs as of late September 2026; items marked
*unverified* were seen only in search results or secondary descriptions.

## Anthropic's own offerings

| | What it is | Overlap with Pocket Factory |
|---|---|---|
| **Remote Control** (`claude remote-control`, `/rc`) | A live `claude` process on your machine, driven from claude.ai/code or the Claude mobile app. Server mode runs several sessions (`--spawn worktree`, `--permission-mode`, resume within ~4 h). Pro/Max/Team; not with `ANTHROPIC_BASE_URL`. | Permission prompts, `AskUserQuestion`, photos and push notifications from the phone. No task queue, no per-tool audit, no subscription windows in the UI; the process must stay alive (tmux) and the transcript lives at Anthropic. |
| **Cloud sessions + Routines** | Sessions in Anthropic VMs from a fresh GitHub clone; `--teleport` to the terminal; auto-fix PRs. Routines: cron (≥ 1 h), API trigger, GitHub PR / release triggers, daily run limit. Self-hosted runners only for Team / Enterprise. | Scheduling and GitHub triggers (Pocket Factory's Phase 5). No work in a real checkout with local MCP servers; no self-hosting on Pro / Max. |
| **Channels + Telegram plugin** | An MCP server that pushes Telegram / Discord / iMessage messages into an *already running* session (`claude --channels plugin:telegram@…`). Pairing code, allowlist, photos to an inbox directory. Research preview. | Messages are lost while no session runs; no history, no queue. Voice and permission relay through Telegram: *unverified*. |
| **Scheduled tasks** (`/loop`, `CronCreate`) | In-session cron, restored on `--resume`; not persisted across `-p` runs. | Cheap, but tied to one live session. |

## Open-source Telegram and Discord bridges

- **RichardAtCT/claude-code-telegram** (Python, MIT, ~2.8k★): Agent SDK or CLI subprocess; photos, voice (Voxtral / Whisper), file uploads, per-user cost caps, GitHub webhook with HMAC, cron, multi-user. No web UI, no audit log, no subscription windows.
- **andrometiq/c3** (Go, MIT): one bot, a forum topic per project, adapters for seven CLIs; Allow / Deny buttons for permission prompts; a durable offline queue while the session is away; voice in and TTS out. Sits inside an interactive session, does not spawn `-p`.
- **olosegres/telegramcode** (TypeScript, MIT): tmux scraping or stream-json; topic = directory; voice through Groq / OpenAI Whisper; photos, documents; a cron scheduler exposed to the agent as MCP tools; auto-continue after a usage-limit reset. Closest in spirit.
- **xhyumiracle/tg-claude-bot** (Python, MIT): resumes any terminal session from an inline picker over `~/.claude/projects/`; inline buttons for permissions, plan approval and `AskUserQuestion`; live tool status; usage as progress bars.
- **mas-aleksey/claude-bot** (Docker, MIT): prompt queue during a run; sandboxed mode with a Docker-in-Docker daemon per project.
- **JessyTsui/Claude-Code-Remote** (Node, MIT, ~1.3k★): hooks in `settings.json` plus keystroke injection into tmux; email, Telegram, LINE. Notify-and-reply, not a session manager.
- **Discord**: chadingTV/claudecode-discord (multi-machine hub, approval buttons, usage dashboard), terryds/claude-code-discord (thread = session, scheduled watcher jobs), t11z/claudecord (each member brings their own subscription).

## Mobile and web clients, orchestrators, utilities

- **Happy** (slopus/happy, MIT, ~24k★): wrapper `happy claude`, self-hostable relay with end-to-end encryption, iOS / Android / web, push on permission requests, voice, worktrees, usage. Interactive CLI wrapper.
- **siteboon/claudecodeui** (AGPL, ~14k★): reads and writes `~/.claude` directly; file explorer, git panel, terminal, permissions and MCP management in the UI, image input, usage dashboard, Docker sandbox, paid cloud tier.
- **OpenCode `serve`**: the agent as an HTTP server with OpenAPI, SSE, `prompt_async` and endpoints to answer permission requests. Not Claude Code, but the cleanest "agent behind an API" reference.
- **Vibe Kanban** (Apache-2.0, ~28k★, main project sunsetting; `vibe-kanban-indie` fork with Telegram escalations): kanban → worktree → agent → diff review with inline comments → PR.
- **Paperclip** (MIT, ~93k★, Postgres): agents as employees with token / dollar budgets and throttling, approval gates, cron routines, an immutable activity log. Company scale, not one developer.
- **CCManager**, **claude-squad**, **Conductor**, **Sculptor**: local PTY / worktree managers and desktop apps; no remote access by themselves.
- **Terragon** (service closed 2026-01, code snapshot Apache-2.0), **Omnara** (now "open-source Managed Agents"): cloud-orchestrator references.
- **BAND** (band.ai, Thenvoi AI Ltd., $17M seed 2026): not a Claude Code driver but a "communication layer" for agents of any framework: cloud chat rooms where agents and people @mention each other, delegate, ask for approvals, with a control plane for authority and an audit trail. For coding: **Band Desktop** (formerly Jam) plus the `band-peer` Claude Code plugin and a `jamd` daemon bind local Claude Code / Codex sessions to rooms; the earlier **codeband** (MIT, Python, maintenance only) ran planner / reviewer / coders / mergemaster as cross-model adversarial pairs (Claude writes, Codex reviews) in worktrees with risk-tiered auto-merge. Free tier 20 remote agents; Pro $17.99; no self-hosting, no mobile or Telegram, code stays local but chat and session state live in BAND's cloud. Overlap with Pocket Factory: approvals in chat, audit trail, work items and ownership. Different premise: a live desktop session and a SaaS backplane versus a headless queue on your own server.
- **ccusage** (MIT, ~19k★): 5-hour blocks, daily / weekly reports and a live block monitor computed from JSONL transcripts. Complements `rate_limit_event`. **ccremote** (unmaintained): auto-continue after the 5-hour window resets.
- Proprietary clouds (Cursor background agents, Codex cloud, Jules, Devin): sandbox VMs, none self-hosted on an individual subscription.

## What most of them have and Pocket Factory does not

1. **Permission prompts, plan approval and `AskUserQuestion` from the phone.** Pocket Factory runs `-p` with a fixed permission mode: either everything is allowed or the task fails.
2. **Images and files as input.** Text and voice only today.
3. **Schedules and triggers** (cron, HTTP fire, GitHub webhooks). `source: cron` exists only in the schema.
4. **Auto-continue after a window reset** and push notifications for "needs a decision".
5. **A diff panel per task and a "Create PR" button.** The audit log renders Edits as diffs, but there is no branch-level diff.
6. **Worktrees for parallel tasks on one repository.** One task per conversation in the real checkout is a deliberate choice, not a gap, but an opt-in worktree flag per project would not break it.
7. **Resuming a terminal session** started on the laptop from the chat.
8. **Budgets per agent / project with a soft stop.** Tokens are counted, nothing is limited but `CLAUDE_MAX_BUDGET_USD`.

## What Pocket Factory has that almost nobody does

- The **audit log per model call, tool call and sub-agent** with `parent_tool_use_id`, project detection and Edit-as-diff. Only Paperclip (action level) and Coder's Boundaries (HTTP level) come close; no Telegram / Discord bridge does this.
- **Subscription windows from `rate_limit_event`** in the task list and in Telegram, instead of transcript arithmetic (ccusage) or the interactive `/usage` text.
- **Agents, skills and projects as Markdown with a UI editor, plus presets.** claudecodeui manages permissions and MCP, not roles.
- **Three-layer MCP** (repository `.mcp.json`, owner `mcp.json`, role-owned servers in agent frontmatter, `disabledMcpjsonServers` per project).
- **Work in the owner's real checkout** with the repository's own `CLAUDE.md`, agents and skills, on a server, with a queue that survives restarts. Remote Control does the checkout part but needs a live process and keeps transcripts at Anthropic.

## Prioritised ideas

1. **Approvals from Telegram and the web** without an interactive CLI: `--permission-prompt-tool` pointing at a small MCP server the supervisor runs; a `permission` event in SSE, Allow / Deny / Always buttons in Telegram, deny on timeout. The same channel carries `AskUserQuestion`.
2. **Photos and files in**: download to `data/inbox/<task>/`, pass as `@path` in the prompt (what the official plugin and Remote Control do).
3. **Phase 5 as three triggers** in the shape of Routines: cron, `POST /api/tasks/fire` with a bearer token and an "untrusted payload" wrapper, GitHub webhook (PR opened / labelled). The TRAC poller and review requests from the roadmap fit in.
4. **Auto-continue after a window reset**: a task that failed on `rejected` is re-queued for `resets_at` with a Telegram notice.
5. **Diff panel and "Create PR"** on the task page: `git diff <base>..HEAD` of the task's branch and `gh pr create`.
6. **Telegram notifications for web-started tasks** (already Phase 6) and a distinct "needs a decision" event.
7. **"Continue in chat" for an indexed transcript** from `sessions/transcripts.ts`, so a laptop session carries on from the phone.
8. **Budgets per agent / project** in tokens and window share with a soft stop for background tasks (SPEC §7 already asks for it).
9. **Opt-in worktree per project** for parallel tasks on one repository.
10. **Audit export** (JSON / ccusage-compatible 5-hour blocks): cheap and unique.
11. **State the positioning against Remote Control in the README**: queue + audit + role management on your own server versus one live process with transcripts at Anthropic; Pocket Factory also works behind an `ANTHROPIC_BASE_URL` proxy, Remote Control does not.

Still to check by hand: permission relay and voice in the official Telegram plugin; whether Omnara's mobile apps are still maintained; the licence of `vibe-kanban-indie`; how Happy drives the CLI (PTY or SDK).
