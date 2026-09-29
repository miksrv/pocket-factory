# Full-stack TypeScript + Go

For repositories laid out as `client/` (TypeScript, React) plus `server/` (Go), each with its own checks. Turns "add X to project Y" into a reviewed pull request, and "look at the staging host of Y" into a read-only report.

**Adds**

- agent `go-developer` — the server side: handlers, use cases, repositories, migrations, tests, regenerated mocks and API docs. Preloads `go-conventions`.
- agent `web-developer` — the client side: components, hooks, API client, tests, lint and formatting. Preloads `typescript-conventions`.
- agent `host-inspector` — looks at a project's servers over SSH and reports. Read-only by contract *and* by a hook that blocks state-changing commands.
- skill `fullstack-feature` — the pipeline: plan → the developer(s) for the areas touched → `reviewer` → fix loop (three rounds at most) → checks → PR with a structured description → report.
- skill `host-check` — "check the host": pick the host from the project file, run `host-inspector`, report; a change is proposed, never made without a "yes".
- skills `go-conventions`, `typescript-conventions` — house rules the developers start with and the reviewer checks against.

**Needs**

- The core `reviewer` agent (shipped with the factory).
- A project file per repository. Let `onboard-project` draft it from the repository's own docs, then set `skill: fullstack-feature`, fill `checks:` with the real commands (root `make check`, `cd client && yarn test`, …) and `hosts:` with the servers the factory may look at.
- For `host-check`: SSH keys in `data/secrets/ssh/` and the hosts' user@address in the project file.

**Repository-level agents.** The factory runs Claude Code from the workspaces root, so `.claude/agents/` inside a repository is not loaded automatically. Both developers read those files for their area when they exist and follow them; nothing needs to be copied into the factory.

**Usage from Telegram**

> "In webshop add a `DELETE /v1/coupons/{code}` endpoint and a remove button on the coupons page" "webshop: the tenant switcher loses state after refresh — fix it" "Check the staging host of webshop: is the api container up and what is in its log?"
