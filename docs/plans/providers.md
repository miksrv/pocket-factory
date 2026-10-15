# Plan: model providers besides the subscription (self-hosted and cloud LLMs)

Status: **decided 2026-10-14** after the owner's tests on `lookatstars` (below); implementation
is release 1.3.0. Delegation (§4) is deferred to a later release.

## Problem

Every task runs on the owner's Claude subscription. Monotonous work (finding a topic, collecting
SEO keywords, writing an article for geometki.com) burns the 5-hour and weekly windows that
coding work needs. A spare server, `lookatstars`, stands idle and could do that work; cloud
models (Gemini, OpenAI, Groq, OpenRouter …) could take other kinds of work.

## Owner's requirements

- The factory connects **both** self-hosted models and cloud ones, as many as the owner adds,
  from the UI: a provider is a URL + key + models, local or cloud, anywhere (a model on any
  computer that speaks a standard API).
- A provider is then chosen for an agent, a schedule, a chat.
- Agents on any provider can search the web; an SEO article starts from keyword research.
- Writing articles is one case; the work is varied, so distributing it by provider must be
  general: cheap bulk work elsewhere, Claude for what needs quality.

## What the tests showed (2026-10-14, `lookatstars`: RTX 2080 Ti 11 GB, Ollama 0.40)

Setup: Ollama + SearXNG in `/srv/llm` on `lookatstars` (Russia, so **no Claude Code there**:
the CLI ran on the owner's Mac through an SSH tunnel, `ANTHROPIC_BASE_URL=http://localhost:11434`,
a throw-away `CLAUDE_CONFIG_DIR`, no Anthropic credentials). Task: keywords → sources →
an SEO page about Медведицкая гряда for geometki.com, written to a file.

| Model | Fits VRAM | Default CLI prompt | Short system prompt |
|---|---|---|---|
| qwen3.5:9b | yes (7 GB @ 64k) | researched well (8 pages), never wrote the file | file written; thorough research (6 pages), 1900 words, broken Russian in places, legends as facts |
| gemma4:12b | yes (9.3 GB @ 64k) | 0–3 pages, text in the reply, not the file | file written in 1:53; clean Russian, 640 words, 2 pages read |
| qwen3:14b | **no** (12 GB → 20 % on CPU, 10 min) | 4 searches, no page read | not tried |

Findings that shape the design:

1. **The default Claude Code system prompt (~15k tokens, coding-oriented) breaks small models**:
   with it, no run reached the file. With `--system-prompt` (~400 tokens: autonomy rules,
   fact rules, output format) and `--tools Read Write Edit` + search MCP, both models finished
   on the first try. → agents on such providers run in a **light mode** (§3).
2. **Context 64k is needed**: at 32k the context overflows after 2–3 pages read.
3. **Two roles beat one**: qwen3.5 researches thoroughly, gemma4 writes cleanly. A research
   draft edited by gemma4 gave the best page (~950 words, clean language, 6 real sources,
   keywords from real suggestions). → one provider can serve several models; a skill chains
   roles.
4. **Facts are the weak point**: both models present legends as facts and get routes wrong.
   → publication goes through a review (Claude via delegation later, the owner now).
5. **Throughput**: one model in VRAM at a time, ~5 min research + ~5 min edit per page;
   **one task at a time per such provider** (a per-provider concurrency limit), the rest of the
   factory keeps running on Claude / cloud providers in parallel.
6. GPU: 84 °C average under load, 88 °C peak, 275 W; `nvidia-smi -pl 200` is the owner's call.
7. Speed: ~25 tok/s generation (≈10 Russian words/s), prompt processing 1–2k tok/s; the cost
   of a task is re-reading the growing context every turn, not the writing.

## The mechanism

The `claude` CLI talks to any endpoint that speaks the Anthropic Messages API:
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`. Ollama, llama.cpp
server, vLLM and OpenRouter serve `/v1/messages`. So a provider is **the same runtime with
another environment**: queue, schedules, Telegram, Audit log and token accounting stay as they
are. No Agent SDK, no second runtime.

Providers that speak only the OpenAI chat API (OpenAI, Gemini, Groq, LM Studio …) go through
a **translating gateway inside the supervisor** (`gateway/`, TypeScript, no Python service —
decided: LiteLLM would be a second runtime and needs a restart per config change): the CLI is
pointed at `http://127.0.0.1:<port>/gateway/<provider>` and the supervisor converts
`/v1/messages` (streaming too) to `/v1/chat/completions` and back. The gateway lives with the
factory (outside Russia), so blocked providers are reachable; the self-hosted model stays where
it is.

### The constraint that shapes the design

The environment belongs to the **process**: one `claude -p` = one endpoint for the orchestrator
and all its sub-agents. Mixing the subscription and another provider inside one CLI process is
impossible, and proxying the subscription's OAuth token through a gateway is out (SPEC §8).
Inside one provider, roles can use different models (`model:` in each agent file).

Hence **Claude orchestrator + a role on another provider** needs two processes — delegation,
§4, deferred. In 1.3.0 a provider is chosen **per task**: a schedule, a chat, or an agent that
the task is run as.

## Design

### 1. `lookatstars` (done 2026-10-14) and the network

- NVIDIA utils + container toolkit; `/srv/llm/docker-compose.yml`: Ollama (`OLLAMA_CONTEXT_LENGTH`
  65536, flash attention, KV cache q8_0, one model loaded, 30 min keep-alive) and SearXNG
  (JSON format, Google autocomplete), both on `127.0.0.1` only. Models: qwen3.5:9b, gemma4:12b
  (qwen3:14b is too big for the card).
- Router: UDP 51820 forwarded to `192.168.0.226` (verified from mikserver), static IP, DHCP
  reservation. WireGuard between mikserver and `lookatstars` is the next step (not installed yet).
- The search MCP (`mcp-searxng`, `SEARXNG_URL` through the tunnel) goes into
  `data/config/mcp.json`, so every task can use it. On other providers the built-in WebSearch
  does not exist (it is an Anthropic server-side tool).

### 2. Provider registry: `data/config/providers.yaml`

```yaml
- name: lookatstars
  kind: anthropic            # anthropic = speaks /v1/messages itself; openai = via the gateway
  url: http://10.77.0.1:11434
  token: LOOKATSTARS_TOKEN   # name of the variable in .env (optional for a local server)
  models: [qwen3.5:9b, gemma4:12b]
  default: gemma4:12b
  small: qwen3.5:9b          # the CLI's haiku-tier calls
  concurrency: 1             # one task at a time (one GPU)
  light: true                # light mode for every task (default for a non-claude provider)
- name: gemini
  kind: openai
  url: https://generativelanguage.googleapis.com/v1beta/openai
  token: GEMINI_API_KEY
  models: [gemini-2.5-pro, gemini-2.5-flash]
```

The subscription is the built-in provider `claude` (aliases `sonnet` / `opus` / `haiku` /
`fable`, the run-time `claude.model` as today). `files/providers.ts` parses and validates,
like `hosts.ts`; secrets only as variable names, never values.

### 3. Choosing a provider; light mode

A model reference is `provider:model` (`lookatstars:gemma4-12b`); a bare alias is the
subscription, so every existing file stays valid.

- **Schedule**: `provider:` + `model:` in the frontmatter; the whole run goes there.
- **Chat**: a provider / model selector next to the project selector (`conversations.provider`
  / `model`); Telegram `/model lookatstars:gemma4:12b` for the chat.
- **Agent file**: `provider:` + `model:`; a task run *as* that agent (a schedule's `agent:`, a
  chat with an agent chosen) uses them. Sub-agents of a Claude task keep `model:` within Claude.
- **Task**: `tasks.provider` records what it ran on, next to `tasks.model`.

**Light mode** (`light: true`, the default for a non-claude provider): the CLI starts with
`--system-prompt` = the agent's file body (or `templates/claude/light-system.md` without an
agent), `--tools` = the agent's `tools:` (default Read, Write, Edit, Bash, Glob, Grep),
`--disable-slash-commands`, the factory's `--mcp-config` kept, no dispatcher CLAUDE.md. The
prompt carries the task text only. A Claude provider never uses it.

**Concurrency**: `concurrency` per provider (default unlimited for cloud, 1 for `light`
self-hosted); the worker counts running tasks per provider and skips a queued task whose
provider is full, still within `MAX_CONCURRENT_SESSIONS`.

**Accounting**: tokens from stream-json as today, per task. Tasks on another provider do not
move the subscription's windows (`rate_limit_event` never comes), are not paused by
auto-continue (`limitReset` applies only to `claude`), the schedules' soft-stop ignores them.
A provider that is down fails the task with a clear error (no retry loop). The `unrecognized_model`
warning of the CLI is harmless.

### 4. Delegation (later release)

A factory MCP tool `delegate(agent, prompt)` queues a child task on the agent's provider and
returns its report; the parent's slot is lent to the child, `tasks.parent_id` links them, the
Audit log nests them, the dispatcher rules route roles on other providers to `delegate`. The
fact-check of locally written pages is the first use.

### 5. UI and Telegram

- **Settings → Providers**: the built-in `claude` row, then each provider: kind, URL, models,
  variable status (set / missing), concurrency, light mode; **Test** (reachable + key accepted
  + a one-turn tool-calling probe + the context the server reports when it does); add / edit /
  delete like Hosts.
- **Agent form**: Provider select, then Model (free text with the provider's list as choices).
- **Schedule form** and **Chat**: the same pair.
- **Task page / footer**: `lookatstars · gemma4:12b · 48k tok` instead of the window share.
- `/api/status` carries `providers` (name, kind, running, last error) for Overview Health.

### 6. geometki pipeline (the first user of all this)

A schedule on `lookatstars`: pick a place from a list in the schedule body (or found by
search), check it is not already on geometki.com, research (qwen3.5), write the page (gemma4
edit pass), save as a **draft** and send the link to Telegram; the owner publishes. Later:
delegation to Claude for a fact-check, then automatic publication.

## Implementation notes (1.3.0 MVP, 2026-10-14, verified in the local container)

- `lookatstars` registered as `http://host.docker.internal:11434` (the Mac's SSH tunnel) for the
  container test: gemma4:12b in light mode wrote a file in 2 turns / 11 s / 9k tokens; the Test
  button needs `max_tokens` 1024 (gemma4 thinks before the call; 64 tokens never reached it).
- Known gap: with Ollama's Messages API the CLI reports `output_tokens` 0 on its assistant
  messages (the usage of `message_start`; the real count is in `message_delta`), so provider
  tasks show input tokens only. A fix is the gateway counting usage per request and attributing
  it to the task (a per-task bearer instead of the per-start one).
- Not verified yet: a `kind: openai` provider against a real endpoint (the translator is unit-
  tested and the gateway test mocks fetch); WireGuard mikserver ↔ `lookatstars`; the dispatcher
  `CLAUDE.md` is not loaded in light mode as far as the token counts show (~4.6k per call).

### Review pass (2026-10-14, a reviewer agent on the MVP)

Fixed: a provider's `token` may not name the factory's own secrets (`TELEGRAM_*`, `WEB_*`,
`GROQ_*`, `CLAUDE_*`, `ANTHROPIC_*`, `GH_TOKEN` …) and must look like a key variable, so the
Test / Fetch probes cannot be made to mail the bot token to a URL of the body; the gateway
address is known from `config.web.port` at construction, so a provider task re-queued at boot
runs; the schedules' soft-stop skips subscription runs only; the gateway waits up to 10 min for
the first byte (prompt evaluation on a GPU box); light mode passes `--strict-mcp-config` (the
factory's search server only, no connectors / plugins / project servers); an agent file keeps
`model:` for the CLI and carries the provider's id as `provider_model:` (a foreign id in
`model:` would 404 when the orchestrator spawns the agent as a sub-agent); the stream
translator opens one block per tool-call id when a provider omits `index` and relays an
upstream `error` payload; the bearer compare is constant-time; a chat's provider cannot change
while a task is queued; `/model <provider>` alone picks its default model; no "Skill to apply"
line for an embodied run. Verified in the container: the CLI honours `ANTHROPIC_AUTH_TOKEN` over
the stored claude.ai login (the task ran).

Deferred: `max_completion_tokens` for OpenAI reasoning models; `--system-prompt-snapshot off`
for resumed light sessions (CLI 2.1.283 has no such flag); Overview Health line for providers;
the context length in Test; web tests for `ModelPicker` / `ProvidersSection`; a chat-level
agent selector (plan §3).

## State 2026-10-15: `lookatstars` as a plain HTTPS provider (no VPN)

Release 1.3.0 is merged, tagged and deployed to mikserver (PR #15). The first production
run on `lookatstars` (gemma4 in light mode, four chat tasks) worked but had no web access:
light mode offers six built-in tools and `--strict-mcp-config`, WebSearch is an Anthropic
server-side tool, and the search MCP of the Mac test was never installed on the factory.

**Network decision (owner, 2026-10-15).** No WireGuard and no persistent SSH tunnel: a
standing encrypted link from a box inside the office network to a server in Russia is a
corporate-security problem (beaconing to a RU address) regardless of what it carries, and the
SSH sidecar that briefly ran on mikserver was removed the same day. Instead `lookatstars` is
reached like any cloud API: **HTTPS on one TCP port with a bearer, a request only while a task
runs.** The owner also rejected third-party DNS (sslip.io) and Let's Encrypt, so TLS comes from
Caddy's own CA (`tls internal`) for the bare IP, and the factory trusts that root certificate.
The data rule stands: work-project code never goes to this provider; a per-project provider
allowlist is a wanted guardrail (not built yet).

**Done on `lookatstars`** (`/srv/llm`, see `docs/SELF_HOSTED_LLM.md` for the generic form):
`caddy:2` on **8443** with `default_sni` for the IP (IP clients send no SNI; a reload did not
apply it, a restart did), bearer `LLM_API_TOKEN` in front of Ollama for `/v1/*`, `/api/tags`,
`/api/show` only (model management stays closed), `mcp-searxng` 2.6 as a streamable-HTTP MCP on
`/mcp` with its own bearer (`MCP_HTTP_HARDEN`, allowed hosts / origins, `TRUST_PROXY`), the
upstream Host pinned so the router may map any external port. Root CA exported to
`/srv/llm/caddy-root.crt` (valid to 2036). Verified on the box over TLS: health, 401 without
tokens, `/api/pull` blocked, a gemma4 tool-call probe, an MCP `initialize` with a foreign port in
the Host header.

**Done on mikserver** (on 1.3.0): `LOOKATSTARS_TOKEN` and `LOOKATSTARS_MCP_TOKEN` in `.env`,
the CA at `data/config/certs/lookatstars-ca.crt` with `NODE_EXTRA_CA_CERTS` in the compose
override, `providers.yaml` → `https://<box IP>:<router port>` + `token: LOOKATSTARS_TOKEN` (the
router forwards that port to the box's 8443; verified from outside), the search server parked as
`data/config/mcp.json.pending`: in the global `mcp.json` every session, subscription ones
included, would connect to the box at start. Ollama had silently fallen back to the CPU
("Failed to initialize NVML" after a `daemon-reload`), which made the first task run into
Node's 300 s headers timeout; fixed with CDI on the box (see the guide), and Caddy's log no
longer prints `X-Api-Key`.

**1.4.0** (this release) closes the gap without any of that: a provider's own `mcp:` servers
(only its tasks get them, through the gateway, which adds the key), the CA pasted into the
provider form (trusted at once, no `NODE_EXTRA_CA_CERTS`), a per-provider gateway bearer (closes
the first review follow-up below) and Test checking the MCP servers too. Verified in the local
container: Test ok + MCP ok, a search task on `lookatstars` (17 s), a subscription task with zero
requests to the box.

**After the 1.4.0 release, on mikserver** (`/srv/pocket-factory`):

1. `git pull && docker compose up -d --build`.
2. Settings → Providers → `lookatstars` → Edit:
   - **TLS certificate**: paste `/srv/llm/caddy-root.crt` from the box (`cat` it there, or the
     current `data/config/certs/lookatstars-ca.crt`); the fingerprint must start `C7:EA:89:7D`.
   - **MCP servers** → Add: `search`, `https://<box IP>:<router port>/mcp`,
     `LOOKATSTARS_MCP_TOKEN`. Save.
3. Test on the row: "tool calling ok" and "MCP search ok".
4. Remove `NODE_EXTRA_CA_CERTS` from `docker-compose.override.yml` (backup first), delete
   `data/config/certs/lookatstars-ca.crt` (the form keeps its own copy as `lookatstars.pem`) and
   `data/config/mcp.json.pending`; `docker compose up -d`.
5. A chat on `lookatstars`: a search task; then a subscription task and the box's Caddy log
   (`docker compose logs --since 5m caddy` in `/srv/llm`) shows no request from it.

**Follow-ups from the 1.3.0 review** (listed in PR #15): ~~the gateway bearer is per start and
shared by every provider~~ (per provider since 1.4.0; per-task tokens would still give per-task
usage accounting); `light: false` and `kind: openai` not verified
against a live endpoint; a schedule that inherits `provider:` from its agent shows the
subscription in the form and `usedBy` misses it; `session: continue` keeps the old backend's
session on a provider change; `/model claude:<alias>` reply and `/status` name the factory
model instead of the chat's pinned alias.

## Steps

1. ~~`lookatstars` setup and the hand-run tests~~ — done 2026-10-14.
2. ~~Factory, release 1.3.0~~ — merged, tagged and deployed 2026-10-14.
3. ~~WireGuard~~ → HTTPS with a bearer on a router port (above), the search MCP in
   `data/config/mcp.json`; then the geometki schedule and skill.
4. Delegation (§4); a per-project provider allowlist; the review follow-ups above.

## Open questions (owner)

1. Money for cloud providers: `$` next to tokens, or tokens only (the "no money in the UI"
   rule was about the subscription).
2. `nvidia-smi -pl 200` on `lookatstars` (88 °C peak).
