# Full-stack TypeScript + PHP

For repositories laid out as `client/` (TypeScript, React) plus `server/` (PHP: Laravel, Symfony or plain), each with its own checks. Turns "add X to project Y" into a reviewed pull request.

**Adds**

- agent `php-developer` — the server side: controllers, services, repositories, entities, migrations, tests, regenerated API docs. Preloads `php-conventions`.
- agent `web-developer` — the client side: components, hooks, API client, tests, lint and formatting. Preloads `typescript-conventions`. Same file as in the *Full-stack TypeScript + Go* preset.
- skill `fullstack-feature` — the pipeline: plan → the developer(s) for the areas touched → `reviewer` → fix loop (three rounds at most) → checks → PR with a structured description → CI → report. Same file as in the *Full-stack TypeScript + Go* preset: it picks the server developer from the repository (`composer.json` → `php-developer`, `go.mod` → `go-developer`), so both presets can be installed side by side and reinstalled in any order.
- skills `php-conventions`, `typescript-conventions` — house rules the developers start with and the reviewer checks against.

**Needs**

- The core `reviewer` agent (shipped with the factory).
- A project file per repository. Let `onboard-project` draft it from the repository's own docs, then set `skill: fullstack-feature` and fill `checks:` with the real commands. The factory image has Node and Yarn but no PHP: `composer`, `phpstan` and `phpunit` usually run in CI only — say so in the project notes so the PR states it instead of claiming green checks.
- Host inspection lives in the *DevOps engineer* preset.

**Usage from Telegram**

> "In shop-api add a `DELETE /v1/coupons/{code}` endpoint and a remove button on the coupons page" "shop-api: the order total ignores the discount after a refund — fix it"
