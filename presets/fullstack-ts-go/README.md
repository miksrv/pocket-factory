# Full-stack TypeScript + Go

For repositories laid out as `client/` (TypeScript, React) plus `server/` (Go), each with its own checks. Turns "add X to project Y" into a reviewed pull request.

**Adds**

- agent `go-developer` — the server side: handlers, use cases, repositories, migrations, tests, regenerated mocks and API docs. Preloads `go-conventions`.
- agent `web-developer` — the client side: components, hooks, API client, tests, lint and formatting. Preloads `typescript-conventions`.
- skill `fullstack-feature` — the pipeline: plan → the developer(s) for the areas touched → `reviewer` → fix loop (three rounds at most) → checks → PR with a structured description → CI → report. Shared with the *Full-stack TypeScript + PHP* preset: the same file, it picks the server developer from the repository (`go.mod` → `go-developer`, `composer.json` → `php-developer`).
- skills `go-conventions`, `typescript-conventions` — house rules the developers start with and the reviewer checks against.

**Needs**

- The core `reviewer` agent (shipped with the factory).
- A project file per repository. Let `onboard-project` draft it from the repository's own docs, then set `skill: fullstack-feature` and fill `checks:` with the real commands (root `make check`, `cd client && yarn test`, …). The factory image has Node and Yarn but no Go: server lint and tests usually run in CI only — say so in the project notes so the PR states it instead of claiming green checks.
- Host inspection lives in the *DevOps engineer* preset.

**Repository-level agents.** When a conversation is bound to the project, Claude Code runs from its checkout, so the repository's `.claude/agents/` load; the skill prefers them for their area when the project notes name them. Both factory developers also read those files and follow them.

**Usage from Telegram**

> "In webshop add a `DELETE /v1/coupons/{code}` endpoint and a remove button on the coupons page" "webshop: the tenant switcher loses state after refresh — fix it"
