# Deploying the factory

How a release reaches a server, and the one-time move to Docker Sandboxes (1.7.0). The factory is
two parts on one host: the **control plane** (this repository's container: web UI, Telegram, the
queue) and the **agents**, which run in Docker Sandboxes (`sbx`, one microVM per project) that the
control plane drives through the host's sbx daemon.

## A regular release

On `main` after the merge (see `CLAUDE.md`, Versioning): `node scripts/release.mjs tag`. Then on the
server, in the factory's directory:

1. No task is running (Overview, or Telegram `/status`): a restart re-queues a running task once,
   but a long one loses its progress.
2. `cp .env .env.bak-<old version>` before editing `.env`.
3. `git pull --ff-only && docker compose up -d --build --remove-orphans`.
4. If `templates/claude/CLAUDE.md` changed in the release and the server's `data/claude/CLAUDE.md`
   carries server-only rules, merge by hand (`cp -n` never overwrites it; back it up as
   `CLAUDE.md.bak-<old version>` first).
5. `docker compose logs -f supervisor`: the start-up log names the version, `agents run in Docker
   Sandboxes` and the entrypoint's `sandboxes: sbx version …`.

Rollback: `git checkout v<previous>`, restore `.env.bak-*`, `docker compose up -d --build`.

## Host requirements (once)

- **Linux with KVM** (the user that runs the factory in the `kvm` group), or macOS / Windows with
  the sbx app. A VPS without nested virtualization cannot run sandboxes.
- **Docker Sandboxes**: the `.deb` asset for the distribution from
  github.com/docker/sbx-releases (`/usr/bin/sbx`, a static binary). Telemetry off:
  `SBX_NO_TELEMETRY=1` in the user's environment and `sbx settings set diagnostics.autoUpload never`.
- **A Docker account**: `sbx login` (opens a browser; no sandbox is created without it).
- **Global policy**: `sbx policy init balanced` (registries, GitHub and the AI services open, the
  rest refused and asked of the owner).
- **The daemon as a user service** that survives a reboot (`sbx daemon start`, per user, socket under
  `~/.local/state/sandboxes`):

  ```ini
  # ~/.config/systemd/user/sbx.service
  [Unit]
  Description=Docker Sandboxes daemon
  [Service]
  Environment=SBX_NO_TELEMETRY=1
  ExecStart=/usr/bin/sbx daemon start
  ExecStop=/usr/bin/sbx daemon stop
  Restart=on-failure
  [Install]
  WantedBy=default.target
  ```

  `sudo loginctl enable-linger <user>`, then `systemctl --user enable --now sbx`. Not yet verified:
  whether `sbx daemon start` stays in the foreground under systemd (else `Type=forking`) and whether
  the keyring works without a login session — check `sbx ls` after a reboot.
- **The Claude login**, once: `ssh -t <server> sbx run pf-factory` (creates the factory's own
  sandbox), `/login` inside (press `c` to copy the long URL; a URL copied wrapped from the terminal
  loses `code_challenge`), then exit. sbx keeps it as the global `anthropic` secret and its proxy
  hands it to every sandbox, connectors included. `sbx secret ls` shows `anthropic (oauth configured)`.
- **Previews**: published ports bind to the docker bridge (`PREVIEW_BIND`, `172.17.0.1`). ufw filters
  the container's traffic to the host, so allow the range from the docker networks:
  `sudo ufw allow from 172.16.0.0/12 to any port 18100:18199 proto tcp`.

## `.env` for sandboxes

Besides the usual (Telegram, GitHub tokens, web sign-in):

| Name | Value |
|---|---|
| `SANDBOX` | `sbx` (the image's default) |
| `DATA_DIR` | the absolute host path of this checkout's `data/` (e.g. `/srv/pocket-factory/data`) |
| `WORKSPACES_DIR` | the absolute host path of the repositories |
| `SBX_HOME` | the home of the host user that runs sbx (uid 1000) |
| `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `SANDBOX_IDLE_MIN` | `8g`, `0`, `60` |
| `PREVIEW_PORTS`, `PREVIEW_BIND`, `PREVIEW_TTL_HOURS` | `18100-18199`, `172.17.0.1`, `24` |
| `CONTAINER_MEMORY` | `2g` (the control plane only) |
| `SANDBOX_FACTORY_URL` | only when `WEB_BIND` is neither `127.0.0.1` nor `0.0.0.0` |

Compose refuses to start without `DATA_DIR`, `WORKSPACES_DIR` and `SBX_HOME`, and without
`/usr/bin/sbx` and the user's `~/.local/state/sandboxes`, `~/.config/sandboxes`,
`~/.config/com.docker.sandboxes` (mounted at the same paths; the last one is the file-based secret
store the client needs). Every path the agents see is the host's own: the container mounts `data/`
at `DATA_DIR` and the repositories at `WORKSPACES_DIR`, and each sandbox mounts the same paths.

Remove what 1.7.0 dropped: `COMPOSE_PROFILES=docker`, `DOCKER_MEMORY`. `CLAUDE_CODE_OAUTH_TOKEN`
stays empty.

## Upgrading a 1.6 factory to 1.7.0

1. No task running. Back up: `tar czf ~/backups/pocket-factory-<date>.tar.gz .env
   docker-compose.override.yml data/config data/claude data/db` and a `VACUUM INTO` copy of the
   database through the container's node; `cp .env .env.bak-1.6.1`.
2. Host requirements above: sbx installed, `sbx login`, `sbx policy init balanced`, the daemon unit
   with linger, the Claude login in `pf-factory`, the ufw rule.
3. `.env`: the table above; remove `COMPOSE_PROFILES` and `DOCKER_MEMORY`.
4. A local `docker-compose.override.yml` that still names the `docker:` service (the dind volume)
   must lose that block, or compose refuses the file.
5. `git pull --ff-only && docker compose up -d --build --remove-orphans` (removes the dind
   container).
6. Re-merge the server's `data/claude/CLAUDE.md`: the template's toolchain lines are replaced by
   the sandbox, network and preview rules.
7. Smoke test: Settings → Sandboxes (daemon, both logins); a chat in a project of each kind (Go,
   PHP, Node) asks for its tests; a routine's Run now; a Telegram message; a provider task and a
   delegation; a preview opened from another machine; a blocked host allowed from Telegram.
   On the host: `sbx exec pf-factory claude -p "Reply with exactly: OK" --model haiku --max-turns 1`.
8. After a week without a rollback: delete `data/tools`, `data/docker` and the `docker-certs` volume.

Project files that still say `path: /data/workspaces/<x>` keep working (read as
`WORKSPACES_DIR/<x>`). The real login in `data/claude/.credentials.json` from 1.6 is harmless: the
proxy replaces its tokens. Rollback to 1.6: `git checkout v1.6.1`, restore `.env.bak-1.6.1`,
`docker compose up -d --build` (dind and `data/tools` are on disk until step 8); the sandboxes
stay and do no harm.

## How the factory uses sbx (for debugging)

- Sandboxes are `pf-<project>` (`pf-factory` for chats without a project); the owner's own sandboxes
  are never touched. `sbx ls`, `sbx policy ls pf-<project>`, `sbx policy approval ls` on the host.
- A run is `sbx exec -i -w <cwd> -e NAME… pf-<project> claude …` with `PF_RUN=<id>` in its
  environment; killing the client does not stop the process in the VM, so a stop signals it by
  that mark.
- A sandbox's mounts are fixed when it is made: a moved or deleted checkout keeps it from starting
  ("cannot restore mount"). Reset it in Settings → Sandboxes; the next task makes a new one.
- From a VM the supervisor is `http://host.docker.internal:<WEB_PORT>`; the policy rule for it is
  `localhost:<WEB_PORT>` (the factory adds it).
- Open checks: the Claude login refreshing over several days, a host reboot with the user unit,
  several sandboxes at once under load, sbx on macOS.
