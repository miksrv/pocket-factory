# Plan: toolchains and test services inside the factory

Status: **planned, not started** (2026-10-06, owner: "save as a plan, we'll come back to it").
Target: release 1.2.0, branch `feature/toolchains`.

## Problem

The image has only `node`, `git`, `gh`, `claude`. Agents cannot run the projects' linters, builds,
swagger generation or tests (Go, PHP, Python). The end-to-end Telegram → PR run itself works
(verified by the owner on mikserver, 2026-10-06).

## Owner's requirements

- **Cleanliness first**: nothing installed on the host besides Docker. Moving the factory to a
  fresh Ubuntu needs no setup; deleting the factory directory leaves nothing behind on a VPS.
- The agent installs whatever environment it needs itself, inside the factory's containers.
- PHP tests sometimes need a database or other services.
- Stacks: Go, PHP, Python, Node. Versions are mostly the same across projects; read them from
  each checkout.

## What the workspaces use (surveyed on mikserver, 2026-10-06)

| Stack | Projects | Version |
|---|---|---|
| Go | global-navigation, system-management-api, tenant-management, user-management | 1.25 (`server/go.mod`) |
| PHP | arduino-weather-station, astronomy-portal, geometki | 8.2 (`server/composer.json`), phpunit |
| Python | starmap-service, telegram-ai-bot | 3.11 (CI), pytest |
| Node | every UI | 20.11 / 22 (`.nvmrc`) |

`docker-compose.yml` exists in tenant-management, system-management-api, starmap-service,
telegram-ai-bot and the three PHP projects (`config/docker-compose.yml`). CI tools seen:
golangci-lint, swag, phpunit, pytest.

## Design (owner liked B + part of C; C reworked for cleanliness)

### 1. Toolchains in the container (B)

- Image gets `mise` plus its runtime deps; tools install into `data/tools` (a volume under
  `data/`), so they survive image rebuilds and disappear with the factory.
- mise reads `go.mod`, `.nvmrc`, `.python-version`, `.tool-versions`, `mise.toml`. Go,
  golangci-lint, swag, Python (prebuilt), uv, Node versions install as binaries in seconds.
- PHP: compiling through mise is slow and needs build deps, so PHP 8.2 CLI comes from the sury
  apt repo in the image (mbstring, xml, intl, curl, zip, pdo-mysql / pgsql, sqlite) + composer.
- Dispatcher rule (`templates/claude/CLAUDE.md`): run `mise install` in the checkout before checks;
  a missing tool → `mise use …` by the agent itself, mentioned in the report.

### 2. Test services: the factory's own Docker daemon (C, reworked)

- Not the host's socket (leftover images / volumes on the host, root-equivalent access) but a
  `docker:dind` sidecar in our compose, internal network only, TLS, its own `mem_limit`; state in
  `data/docker`. `docker compose down` + `rm -rf` removes everything.
- Factory gets the `docker` CLI + compose plugin and `DOCKER_HOST=tcp://docker:2376`.
- Workspaces are mounted into dind at the same path `/data/workspaces`, so a project's own
  `docker compose up` resolves its bind mounts without path translation; services are reachable
  from the agent as `docker:<port>`.
- Off by default: `FACTORY_DOCKER=1` in `.env` via a compose profile.
- Cleanup: weekly `docker system prune` (a schedule) and a build-cache size cap.

**Risk to accept**: dind needs `privileged: true`. The agent gets no host socket, but a privileged
container can in principle escape to the host. Sysbox avoids privileged but must be installed on
the host, which breaks the cleanliness rule. Mitigation: off by default, enabled only when a
project's tests need services. **Open question for the owner**: enable dind now, or ship
toolchains (part 1) first.

### 3. Around it

- `onboard-project` fills the project file's `checks:` with the real commands (`make lint`,
  `go test ./...`, `vendor/bin/phpunit`, `pytest`).
- `pr-reviewer`: drop the "never build / test, the factory has no toolchains" budget rule.
- Overview → Health: a "Toolchains" line (mise, php, docker versions) and the size of
  `data/docker`.
- CHANGELOG 1.2.0, CLAUDE.md, SPEC (§8 sandbox note about dind).
