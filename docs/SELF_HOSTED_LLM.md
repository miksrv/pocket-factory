# Running your own LLM server for Pocket Factory

This guide sets up a machine with a GPU as a **model provider** of Pocket Factory: the
factory's tasks run on your model instead of the Claude subscription, with web search if you
want it, and the factory talks to the box exactly as it talks to a cloud API — one HTTPS URL
and one key, a request only while a task runs. Nothing on the factory side keeps a
connection open to the box (no VPN, no SSH tunnel).

What you get on the box:

| Piece | Role |
|---|---|
| **Ollama** | serves the models and speaks the Anthropic Messages API (`/v1/messages`), which the `claude` CLI uses |
| **Caddy** | the only thing reachable from outside: TLS on one port, a bearer token in front of Ollama, everything else answers 401 |
| **SearXNG + mcp-searxng** (optional) | web search, suggestions and page reading as an MCP server, so the model can research |

Tested with an RTX 2080 Ti (11 GB), Ubuntu 26.04, Ollama 0.40, `gemma4:12b` and `qwen3.5:9b`.
Any Linux box with Docker and an NVIDIA card works the same; a CPU-only box works too, slowly.

## 1. Prerequisites on the box

- Docker Engine with the compose plugin; your user in the `docker` group.
- For a GPU: the NVIDIA driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  (`nvidia-ctk runtime configure --runtime=docker`, then restart Docker). Check with
  `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`.
- A CDI spec for the GPU: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml` (again after
  every driver upgrade). The compose file below asks for the GPU through CDI because the older
  `driver: nvidia` request loses the device on a cgroup v2 host after any `systemctl
  daemon-reload` (unattended upgrades run one): `nvidia-smi` in the container then says "Failed to
  initialize NVML: Unknown Error" and Ollama quietly runs the model on the CPU, twenty times slower.
- A static public IP, or a DNS name that points at the box. The examples below use a bare IP;
  with a name, put the name where the IP is.
- One TCP port forwarded on your router to the box (any number; the examples use 8443 inside and
  let the router map whatever external port you choose).

## 2. Files

Everything lives in one directory, for example `/srv/llm`:

```
/srv/llm/
├── docker-compose.yml
├── Caddyfile
├── .env            # the two tokens (chmod 600)
├── ollama/         # models (created by Ollama)
├── searxng/        # SearXNG settings (created on first start)
├── caddy-data/     # Caddy's CA and certificates
└── caddy-config/
```

### `.env`

Two random tokens: one for the model, one for the search MCP. They are different on purpose:
the factory keeps the model key away from the agent's environment, while the MCP key is handed
to the CLI (an agent can read it with `env`), so a leaked MCP key must not open the model.

```bash
cd /srv/llm
printf 'LLM_API_TOKEN=%s\nMCP_HTTP_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

### `docker-compose.yml`

Replace `203.0.113.10` with your public IP (or name) everywhere.

```yaml
name: llm
services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    ports: ["127.0.0.1:11434:11434"]     # loopback only: Caddy is the public face
    volumes: ["./ollama:/root/.ollama"]
    environment:
      OLLAMA_CONTEXT_LENGTH: "65536"      # 32k overflows after two or three web pages
      OLLAMA_FLASH_ATTENTION: "1"
      OLLAMA_KV_CACHE_TYPE: q8_0          # halves the KV cache, so 64k fits an 11 GB card with a 12B model
      OLLAMA_MAX_LOADED_MODELS: "1"
      OLLAMA_KEEP_ALIVE: 30m
    deploy:
      resources:
        reservations:
          devices: [{ driver: cdi, device_ids: ["nvidia.com/gpu=all"], capabilities: [gpu] }]   # drop for CPU-only

  # --- optional: web search for the models ---------------------------------
  searxng:
    image: searxng/searxng:latest
    restart: unless-stopped
    ports: ["127.0.0.1:8888:8080"]
    volumes: ["./searxng:/etc/searxng"]

  mcp:
    image: isokoliuk/mcp-searxng:latest
    restart: unless-stopped
    env_file: .env                        # MCP_HTTP_AUTH_TOKEN
    environment:
      SEARXNG_URL: http://searxng:8080
      MCP_HTTP_PORT: "3000"
      MCP_HTTP_HOST: 0.0.0.0
      MCP_HTTP_HARDEN: "true"
      MCP_HTTP_ALLOWED_HOSTS: 203.0.113.10,203.0.113.10:8443
      MCP_HTTP_ALLOWED_ORIGINS: https://203.0.113.10:8443
      MCP_HTTP_TRUST_PROXY: "1"
  # ---------------------------------------------------------------------------

  caddy:
    image: caddy:2
    restart: unless-stopped
    env_file: .env                        # LLM_API_TOKEN
    ports: ["8443:8443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
```

### `Caddyfile`

```caddyfile
{
    # Clients that connect by IP send no SNI: serve the IP certificate then.
    # (With a DNS name instead of an IP, drop this block.)
    default_sni 203.0.113.10
}

https://203.0.113.10:8443 {
    # Caddy's own CA signs the certificate; the factory trusts the root (step 4).
    # With a public DNS name and port 443 reachable, delete this line and Caddy
    # gets a Let's Encrypt certificate instead.
    tls internal

    # The model: only with the bearer, and only the API the CLI needs.
    # Model management (/api/pull, /api/delete, …) stays closed.
    @model {
        header Authorization "Bearer {$LLM_API_TOKEN}"
        path /v1/* /api/tags /api/show
    }

    # The search MCP checks its own bearer. The Host is pinned so the router may
    # map any external port to 8443.
    @mcp path /mcp /mcp/* /health
    handle @mcp {
        reverse_proxy mcp:3000 {
            header_up Host 203.0.113.10:8443
        }
    }

    handle @model {
        reverse_proxy ollama:11434
    }

    respond "unauthorized" 401

    log {
        output stdout
        # The factory sends the key as X-Api-Key too: keep both key headers out of the log.
        format filter {
            request>headers>X-Api-Key delete
            request>headers>Authorization delete
            wrap console
        }
    }
}
```

Without the search pieces, delete the `@mcp` matcher and its `handle`.

## 3. Start and pull models

```bash
cd /srv/llm
docker compose up -d
docker compose exec ollama ollama pull gemma4:12b
docker compose exec ollama ollama pull qwen3.5:9b
docker compose logs caddy | grep "certificate obtained"
```

Which models: a 12B model in q4 with a 64k context fits 11 GB; a 14B does not (Ollama offloads
to the CPU and the box crawls). Check `nvidia-smi` while a model answers: the whole model should
be in VRAM. Pick models that **call tools**: the factory's agents work only through tool calls.
In our runs `gemma4:12b` wrote clean text and called tools reliably, `qwen3.5:9b` researched
more thoroughly but wrote worse; an agent that researches with one and edits with the other
gave the best articles.

## 4. Export the root certificate

Caddy's local CA root is valid for ten years; the server certificate under it renews itself.

```bash
docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > /srv/llm/ca.crt
openssl x509 -in /srv/llm/ca.crt -noout -subject -enddate -fingerprint -sha256
```

Copy `ca.crt` to the factory host (step 6). Keep the fingerprint: it is how you tell a real
server from an impostor when you look at it again.

## 5. Check from the box

The public IP is usually not reachable from inside your own LAN (no NAT hairpin), so point the
name at loopback for the check:

```bash
cd /srv/llm && . ./.env
R="--resolve 203.0.113.10:8443:127.0.0.1 --cacert ca.crt"
curl -s $R https://203.0.113.10:8443/health                          # {"status":"healthy",…} (with the MCP)
curl -s $R -o /dev/null -w '%{http_code}\n' https://203.0.113.10:8443/api/tags          # 401
curl -s $R -H "Authorization: Bearer $LLM_API_TOKEN" https://203.0.113.10:8443/api/tags   # the model list
```

A tool-calling probe, the same request the factory's **Test** button sends:

```bash
curl -s $R -H "Authorization: Bearer $LLM_API_TOKEN" -H content-type:application/json \
  -H anthropic-version:2023-06-01 https://203.0.113.10:8443/v1/messages -d '{
  "model": "gemma4:12b", "max_tokens": 512,
  "system": "You are a tool-calling probe. Use the tool; do not answer in prose.",
  "messages": [{"role": "user", "content": "Call the tool ping with ok = true."}],
  "tools": [{"name": "ping", "description": "Report readiness",
             "input_schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}}]
}'
```

The answer must contain a `tool_use` block named `ping`. A model that answers in prose here will
not work as an agent.

Then forward the port on the router (`TCP <external port> → <box LAN IP>:8443`) and repeat the
`curl` from outside without `--resolve`, with the external port in the URL.

## 6. Register the provider in Pocket Factory

On the factory host (the directory with `docker-compose.yml` and `data/`):

1. **Keys** into `.env` (the names are yours; a key variable must end with `_TOKEN`, `_KEY`,
   `_API_KEY` or `_SECRET` and must not start with the factory's own prefixes):

   ```
   MYBOX_TOKEN=<LLM_API_TOKEN from the box>
   MYBOX_MCP_TOKEN=<MCP_HTTP_AUTH_TOKEN from the box>
   ```

2. Recreate the container so it sees the new variables: `docker compose up -d`.

3. **The provider**: Settings → Providers → Add provider. Everything else is in the form:

   - **URL** `https://203.0.113.10:<external port>`, **Key variable** `MYBOX_TOKEN`, the models
     (or **Fetch from the endpoint**).
   - **TLS certificate**: paste `ca.crt` (the whole `-----BEGIN CERTIFICATE-----` block). The
     factory keeps it as `data/config/certs/mybox.pem` and trusts it at once, for this box only in
     practice (it signs nothing else); no `NODE_EXTRA_CA_CERTS`, no restart. Compare the
     fingerprint the form shows with the one you noted on the box. Leave it empty with a Let's
     Encrypt certificate or a cloud API.
   - **MCP servers** → Add MCP server: `search`, `https://203.0.113.10:<external port>/mcp`,
     `MYBOX_MCP_TOKEN`. Only the tasks on this provider get it, through the factory's gateway,
     which adds the key; a task on the subscription never connects to the box.

   The same in `data/config/providers.yaml`, if you prefer the file (the certificate only through
   the form, or as the file `data/config/certs/<provider>.pem`):

   ```yaml
   providers:
     - name: mybox
       kind: anthropic                      # Ollama speaks /v1/messages itself
       url: https://203.0.113.10:<external port>
       token: MYBOX_TOKEN                   # the variable's NAME, never the key
       models: [gemma4:12b, qwen3.5:9b]
       default: gemma4:12b
       concurrency: 1                       # one GPU serves one task at a time
       light: true                          # short system prompt + six tools: small models need it
       max_output: 8000                     # tokens per model call (the default); a looping model fails here, not at 32k
       context: 65536                       # the model's real window (num_ctx), so the CLI compacts before it is full
       mcp:                                 # only for the tasks on this provider
         - name: search
           url: https://203.0.113.10:<external port>/mcp
           token: MYBOX_MCP_TOKEN
   ```

   `light: true` is the point for models under ~30B: Claude Code's own system prompt
   (~15k tokens, coding-oriented) made every 9–12B model we tried lose the task, a short prompt
   (`data/claude/light-system.md`, or the agent file's body when a schedule names an agent)
   with Read / Write / Edit / Bash / Glob / Grep worked on the first try. A frontier model can
   take `light: false` and the full tool set.

4. **Test**: Settings → Providers → Test on the row (one tool-calling probe from the supervisor
   and one MCP `initialize` per server; expect "tool calling ok" and "MCP search ok"), then a chat: `/model mybox` in Telegram or the selector in the chat
   head, and a task like "search the web for … and write three lines to notes.md".

## 7. What to expect, and limits

- A task on the box touches no subscription window; the footer and the task page name the
  provider and the model instead of the window share. Tokens are counted from the model's own
  usage report; with Ollama's Messages API output tokens may show as 0 (known gap).
- Speed on a 2080 Ti: ~25 tokens/s generation, 1–2k tokens/s prompt evaluation. The cost of a
  task is re-reading the growing context every turn, not the writing: keep tasks short and
  make the agent save results to files early.
- Anthropic's own tools do not exist here: no `WebSearch`, no claude.ai connectors (Gmail,
  ClickUp …). Search comes from the MCP above; pages are read with its `web_url_read`. In an
  agent file its tools are `mcp__search__<tool>` (the README's "MCP servers" section has the
  naming rule); Settings → Providers lists the full names once a task has run on the box.
- The CLI knows Claude's context windows, not the box's: without `context:` it never compacts a
  long role, and Ollama shifts its window silently until the model loops. `max_output` (8000
  tokens unless set) ends such a loop in a minute instead of at the CLI's 32 000 ceiling.
- A box in another country or on another network: whatever the task puts in the prompt (code,
  tickets, mail) travels there. A project delegates only to the providers ticked in its file
  ("Providers this project may delegate to"); with none ticked, a role runs on the subscription
  and the reply says so.
- Ollama has no authentication of its own, so Caddy must stay the only thing published; keep
  Ollama on `127.0.0.1`. Rotate a token by changing `.env` on both sides and recreating the
  containers.

## Variants

- **OpenAI-style server** (vLLM's OpenAI endpoint, LM Studio, llama.cpp's server, text-generation
  WebUI): set `kind: openai` and the URL up to `/chat/completions` (for vLLM
  `https://…/v1`); the factory translates both ways, streaming included. Put the same Caddy
  bearer in front.
- **A DNS name and a public port 443**: drop `default_sni` and `tls internal`, Caddy gets a
  Let's Encrypt certificate itself, and step 6.2 is not needed.
- **Several models at once**: raise `OLLAMA_MAX_LOADED_MODELS` and `concurrency` only if the
  VRAM holds both; otherwise a second task waits in the factory's queue, which is the design.
