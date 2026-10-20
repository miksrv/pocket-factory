# Deploying the factory

How a release reaches a server and what the host needs. The factory is
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
| `WEB_AUTH_PASSWORD` | required: the supervisor refuses to start without it, since every sandbox reaches the web port |
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

`CLAUDE_CODE_OAUTH_TOKEN` stays empty. Upgrading a 1.6 factory (dind, provider keys in `.env`):
`docs/DEPLOY.md` at tag `v1.7.0`.

## How the factory uses sbx (for debugging)

- Sandboxes are `pf-<project>` (`pf-factory` for chats without a project); the owner's own sandboxes
  are never touched. `sbx ls`, `sbx policy ls pf-<project>`, `sbx policy approval ls` on the host.
- A run is `sbx exec -i -w <cwd> -e NAME… pf-<project> claude …` with `PF_RUN=<id>` in its
  environment; killing the client does not stop the process in the VM, so a stop signals it by
  that mark.
- A sandbox's mounts are fixed when it is made: a moved or deleted checkout keeps it from starting
  ("cannot restore mount"). Reset it in Settings → Sandboxes; the next task makes a new one.
- `data/config` is mounted read-only (the supervisor trusts it: a project's `path:` and `network:`,
  a provider's `url`, the CAs) with `data/config/routines` read-write on top, so an agent still keeps
  its routine's notes, scripts and data; agents and skills live in `data/claude`, read-write. A
  sandbox made before that (config read-write) is removed and made again by the next task that finds
  it free, told in Telegram. A project's checkout must lie under `WORKSPACES_DIR`.
- From a VM the supervisor is `http://host.docker.internal:<WEB_PORT>`; the policy rule for it is
  `localhost:<WEB_PORT>` (the factory adds it).
- Open checks: the Claude login refreshing over several days, a host reboot with the user unit,
  several sandboxes at once under load, sbx on macOS, the nested mount (`data/config:ro` with
  `data/config/routines` read-write inside it: a write to `data/config/x` must fail in the VM, one
  to `data/config/routines/x` must succeed; check with a throwaway `sbx create` before the release).
