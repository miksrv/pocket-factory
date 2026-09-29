---
name: fullstack-feature
description: Turn a development task in a repository with a TypeScript client and a Go or PHP server into a reviewed pull request — branch, one developer per area touched (the repository's own agent when it ships one, else the factory's developer for the server stack and web-developer for client/), reviewer, fix loop of at most three rounds, local checks, PR with a structured description, then wait for CI and fix what it finds. Use as the workflow (`skill:`) of projects laid out as client/ + server/.
---

# fullstack-feature

Use this when the project file names it in `skill:` and the task is a change to the project's code. It is `feature-to-pr` with a developer per stack. The same skill serves Go and PHP servers: the server developer and the convention file are picked from the repository, not from the skill.

## Steps

1. **Project.** Read `/data/config/projects/<project>.md`: `path`, `default_branch`, `pr_base`, `checks`, notes. `cd` into `path`. Read the repository's `CLAUDE.md` for its layout and commands.
2. **Sync.** `git fetch origin`; make sure `default_branch` is up to date locally. Never work on `default_branch` itself.
3. **Branch.** `feature/<short-kebab-summary>` for a feature, `fix/<short-kebab-summary>` for a defect, with the ticket id when the task has one (e.g. `feature/DEV-1234-seo-slugs`); the repository's `CLAUDE.md` or the project notes may name another convention, and a `branch_prefix` in the project file, if present, overrides both. If the branch already exists, continue on it.
4. **Plan.** In two to five lines: what changes, in which areas — `server`, `client` or both — and the order. If the task is ambiguous in a way that changes the outcome, stop and ask the owner all questions in one message.
5. **Pick the developers.** One per area. The project file's notes may name the repository's own agent per area (`server → go-backend-dev`); use it when named, or when the repository's `.claude/agents/` ships an agent whose description covers the area — it carries the repository's memory and MCP servers, which the factory's agents lack. Otherwise fall back to the factory's agents: `web-developer` for `client`; for `server` the developer of its stack — `go-developer` when the server has a `go.mod`, `php-developer` when it has a `composer.json`. A server with neither, or with both, is a question for the owner. Do not mix: one agent per area for the whole task, fix loop included.
6. **Build, per area.**
   - `server` only: spawn the server developer with the project file path, the task, the plan, the branch.
   - `client` only: spawn the client developer the same way.
   - both: the server developer first, so that the API contract and the regenerated API docs exist; then the client developer, telling it what changed in the contract and that the API client must be regenerated.

   Each developer commits on the branch.
7. **Review.** Spawn `reviewer` with the project file, the task, the branch and the paths of the convention files for the areas touched: `/data/claude/skills/go-conventions/SKILL.md` or `/data/claude/skills/php-conventions/SKILL.md` for the server (whichever matches the stack from step 5), `/data/claude/skills/typescript-conventions/SKILL.md` for the client. It answers `APPROVE` or `REQUEST CHANGES` with findings.
8. **Fix loop.** On `REQUEST CHANGES`, route each finding to the developer of its area (the same agents as in step 5), then review again. At most three rounds in total; after that report the open findings to the owner instead of looping.
9. **Checks.** Run every command in `checks` yourself on the final state, from the repository root. Failing checks mean the task is not done. `checks` lists only what this environment can run; when the project notes say some checks run in CI only, say so in the PR and in the report instead of claiming them.
10. **Push & PR.** `git push -u origin <branch>`, then `gh pr create --base <pr_base or default_branch> --title … --body …` with this body:

   ```
   ## Summary
   One paragraph: what and why.

   ## Changes
   - server: …
   - client: …

   ## How it was verified
   Which checks ran, which tests were added.

   ## Notes for the reviewer
   Trade-offs, follow-ups, anything to look at closely. Ticket link if any.
   ```

   Never merge.
11. **CI.** When the project notes say some checks run in CI only, wait for them: poll `gh pr checks <number>` every one to two minutes (each call short, never one long `--watch`) until every check has a result. Green: note it in the report. Red: `gh run view <run-id> --log-failed`, hand the failing step's log to the developer of that area, let it fix and push, then poll again. At most two CI rounds; after that report the failing run's link to the owner instead of looping.
12. **Tracker.** If the project file names a tracker and the task has a ticket id, comment with the PR link and update the ticket (status, tag, assignee) the way the project notes say; with no such rule, comment only.
13. **Report** to the owner: PR link, CI result, three-line summary, open questions.

## Rules

- One task, one branch, one PR.
- The reviewer reads the diff, not the developers' reports.
- Generated code (API clients, mocks, API docs) is regenerated, never edited.
- Anything irreversible (merge, delete, force-push, deploy) needs an explicit "yes" from the owner first.
