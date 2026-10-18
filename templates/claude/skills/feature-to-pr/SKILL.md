---
name: feature-to-pr
description: Turn a task in a known project into a reviewed pull request — branch, developer sub-agent, reviewer sub-agent, fix loop, project checks, gh pr create, report. Use when the task is a code change in a project whose file names no other workflow in `skill:`; the default for "change / add / fix something in project X".
---

# feature-to-pr

Use this when the project is known (a file in `/data/config/projects/` matches) and the task is a change to its code.

## Steps

1. **Project.** Read `/data/config/projects/<project>.md`. Note `path` and the free-form notes: the checks to run and the tracker, when the notes name them. `cd` into `path` and read the repository's `CLAUDE.md` for its layout and commands.
2. **Sync.** `git fetch origin`; the default branch is the remote's (`git symbolic-ref --short refs/remotes/origin/HEAD`; if unset, `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`). Branch from it up to date; never work on it itself.
3. **Branch.** `feature/<short-kebab-summary>` for a feature, `fix/<short-kebab-summary>` for a defect, with the ticket id when the task has one (e.g. `feature/DEV-1234-seo-slugs`); the repository's `CLAUDE.md` or the project notes may name another convention, and a `branch_prefix` in the project file, if present, overrides both. If the branch already exists, continue on it.
4. **Plan.** In two to five lines, decide what will change and where. If the task is ambiguous in a way that changes the outcome, stop here and ask the owner all questions in one message. Otherwise proceed.
5. **Build.** Spawn the `developer` sub-agent with: the project file path, the task text, the plan, the branch name. It commits on the branch.
6. **Review.** Spawn the `reviewer` sub-agent with the same context. It answers `APPROVE` or `REQUEST CHANGES` with findings.
7. **Fix loop.** On `REQUEST CHANGES`, hand the findings to `developer` and review again. At most three rounds; after that, report the open findings to the owner instead of looping.
8. **Checks.** Run the project's checks yourself once more on the final state: the commands the project notes name, or, when they name none, the repository's own (lint, typecheck, tests, build). Failing checks mean the task is not done.
9. **Push & PR.** `git push -u origin <branch>` then `gh pr create --base <base> --title … --body …` with the body in this shape — `## Summary` (what and why, one paragraph), `## Changes` (bullets), `## How it was verified` (checks run, tests added), `## Notes for the reviewer` (trade-offs, follow-ups, ticket link). The base is the one the task names, else the one the project notes name (an older file's `pr_base` counts), else the default branch. If the repository has a PR template, follow that instead. Never merge.
10. **Tracker.** If the project notes name a tracker and the task has a ticket id, add a comment with the PR link and update the ticket (status, tag, assignee) the way the project notes say; with no such rule, comment only.
11. **Report** to the owner: PR link, three-line summary, open questions.

## Rules

- One task, one branch, one PR.
- The reviewer sees the code, not the developer's story.
- Anything irreversible (merge, delete, force-push, deploy) needs an explicit "yes" from the owner first.
