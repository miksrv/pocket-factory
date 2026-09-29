---
name: typescript-conventions
description: House rules for TypeScript / React clients — types, components, data fetching, generated API client, tests, lint and format, package manager. Use when writing or reviewing TypeScript code in a project; preloaded by web-developer, read by the reviewer for client-side diffs. The repository's own CLAUDE.md wins where they differ.
---

# TypeScript conventions

The repository's `CLAUDE.md` and its `.claude/agents/` describe the specific setup; these are the defaults underneath.

## Tooling

- The package manager and version are the repository's (`packageManager` in `package.json`, the lockfile). Never switch managers, never commit a second lockfile, never upgrade dependencies as a side effect.
- Lint and format with the repository's scripts (`eslint`, `prettier`, a type check such as `tsc --noEmit`); a change that needs `eslint-disable` needs a comment saying why.
- Generated code (API client from an OpenAPI/Swagger file, locale files, types) is regenerated with the repository's script and committed; never edited by hand.

## Types

- `strict` is on and stays on. No `any`; `unknown` plus narrowing where the shape is open. Types for API data come from the generated client, not from hand-written duplicates.
- Exhaustive `switch` over unions with a `never` check; nullable values are handled where they enter, not deep inside components.

## Components and state

- Mirror the closest existing page / component: file layout, naming, styling approach (CSS modules, Tailwind, a UI kit — whatever the repository uses), how props and tests are organised.
- Server state through the repository's data layer (React Query or its equivalent): query keys and invalidation follow the existing pattern; no ad-hoc `fetch` in components. Local UI state stays local.
- Effects only for synchronising with something outside React; derive values instead of mirroring them in state.
- Keep existing i18n mechanisms (translation keys, locale scanning) and accessibility (labels, keyboard paths, focus) intact when touching UI.
- In a micro-frontend setup, a component's public contract (exports, shared dependencies, events) is an API: change it deliberately and say so in the report.

## Tests

- The repository's runner and patterns (Jest or Vitest, Testing Library). Test behaviour through the DOM, not implementation details; mock the network at the boundary the repository already mocks at.
- A new behaviour gets a test; a fixed bug gets a regression test that fails before the fix.

## Before reporting done

Lint, format check, type check, unit tests and the production build — the repository's scripts, from `client/` or wherever it keeps them.
