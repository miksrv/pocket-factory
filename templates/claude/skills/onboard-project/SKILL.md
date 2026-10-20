---
name: onboard-project
description: Connect a new repository to the factory by preparing its project file for /data/config/projects/ — inspects the checkout, asks the owner what cannot be inferred, then hands the owner the file to create in the UI. Use when the owner says "connect/add/onboard project X" or when a task names a project that has no file yet.
---

# onboard-project

## Steps

1. Find the checkout under `/data/workspaces/`. If the name is ambiguous or missing, list the candidates and ask.
2. Inspect it: README, package manifests, CI config, existing branches, PR templates, `CLAUDE.md`. Derive stack, default branch, lint/test/build commands, branch naming in use.
3. Ask the owner, in one message, only what you could not infer: PR target branch if unclear, tracker and workflow (and what to do with a ticket once its PR is open: which status, tag or assignee), hosts the project runs on and which key in `/data/secrets/ssh/` opens each (list the file names there, never their contents), any rule they want enforced.
4. Prepare `/data/config/projects/<slug>.md` in the format below, where `<slug>` is the checkout's directory name exactly as it is under `/data/workspaces/` (case included): tasks name projects by that directory. Keep the free-form notes short and concrete.
5. Do not write the file: `/data/config` is read-only in your sandbox. Give the owner its full text and ask them to create the project in the UI (Projects → New project), plus any new shared host in Settings → Hosts first.

## Project file format

```markdown
---
slug: shop
path: /data/workspaces/shop
repo: https://github.com/owner/shop
skill: feature-to-pr
hosts:
  - host: staging-eu                # a shared host (connection) from /data/config/hosts.yaml
    path: /srv/shop     # this project's path on that server
    notes: compose service `web`; docker needs sudo there; restart with `docker compose up -d web`
---

Free-form notes for the agent: conventions, gotchas, what never to touch, how deploys work, where the docs are.

Checks before a PR, from the repository root (all must pass): `yarn lint`, `yarn typecheck`, `yarn test`.

Tracker: GitHub issues, https://github.com/owner/shop/issues. When a PR is open, comment on the ticket with its link.
```

`path` defaults to `/data/workspaces/<slug>`; write it only when the checkout's folder is named otherwise. The default branch comes from git, never from the file; a PR base other than it is a sentence in the notes. `skill` names the workflow for development tasks: `feature-to-pr` by default, or one installed from a preset (for example `fullstack-feature` for a `client/` + `server/` layout); list what exists in `/data/claude/skills/` and pick the one whose description matches. Branches are `feature/…` for features and `fix/…` for defects unless the repository says otherwise; write a convention into the notes rather than a field. The checks and the tracker are notes too, never fields: the commands to run before a PR (only what this environment can run; name the ones that run in CI only as such), where the tickets live, and what happens to a ticket after its PR is open (the status to set, a tag, an assignee). Skip either sentence when the repository's own `CLAUDE.md` already says it. `hosts` refer by name to the shared hosts in `/data/config/hosts.yaml`, which holds the connection only — the `ssh` target (user@host or user@host:port) and the `key` (a file name in `/data/secrets/ssh/`, optional) — once for every project; read that file first and reuse an existing host when the owner names the same server, otherwise tell the owner the connection to add in Settings → Hosts (name, ssh, key) and refer to it from the project. Everything about the project on that server — its `path` and `notes` (what runs there, how deploys work, what never to touch) — goes into the project's own entry. Keys are never copied anywhere; a key or password never goes into a project file or hosts.yaml; passwords are not supported.
