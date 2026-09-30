---
name: onboard-project
description: Connect a new repository to the factory by writing its project file in /data/config/projects/ — inspects the checkout, asks the owner what cannot be inferred, then writes the file. Use when the owner says "connect/add/onboard project X" or when a task names a project that has no file yet.
---

# onboard-project

## Steps

1. Find the checkout under `/data/workspaces/`. If the name is ambiguous or missing, list the candidates and ask.
2. Inspect it: README, package manifests, CI config, existing branches, PR templates, `CLAUDE.md`. Derive stack, default branch, lint/test/build commands, branch naming in use.
3. Ask the owner, in one message, only what you could not infer: PR target branch if unclear, tracker and workflow (and what to do with a ticket once its PR is open: which status, tag or assignee), hosts the project runs on and which key in `/data/secrets/ssh/` opens each (list the file names there, never their contents), any rule they want enforced.
4. Write `/data/config/projects/<slug>.md` in the format below, where `<slug>` is the checkout's directory name exactly as it is under `/data/workspaces/` (case included): tasks name projects by that directory. Keep the free-form notes short and concrete.
5. Show the owner the file and confirm.

## Project file format

```markdown
---
name: Astronomy Portal
slug: astronomy-portal
path: /data/workspaces/astronomy-portal
repo: https://github.com/owner/astronomy-portal
default_branch: main
pr_base: main
skill: feature-to-pr
tracker:
  type: github        # github | clickup | trac | jira | none
  url: https://github.com/owner/astronomy-portal/issues
hosts:
  - host: staging-eu                # a shared host (connection) from /data/config/hosts.yaml
    path: /srv/astronomy-portal     # this project's path on that server
    notes: compose service `portal`; docker needs sudo there; restart with `docker compose up -d portal`
checks:
  - yarn lint
  - yarn typecheck
  - yarn test
---

Free-form notes for the agent: conventions, gotchas, what never to touch,
how deploys work, where the docs are.
```

`path` defaults to `/data/workspaces/<slug>`. `skill` names the workflow for development tasks: `feature-to-pr` by default, or one installed from a preset (for example `fullstack-feature` for a `client/` + `server/` layout); list what exists in `/data/claude/skills/` and pick the one whose description matches. Branches are `feature/…` for features and `fix/…` for defects unless the repository says otherwise; write a convention into the notes rather than a field. The same goes for the tracker: `tracker` holds only the type and the URL; what happens to a ticket after its PR is open (the status to set, a tag, an assignee) is a sentence in the notes. `hosts` refer by name to the shared hosts in `/data/config/hosts.yaml`, which holds the connection only — the `ssh` target (user@host or user@host:port) and the `key` (a file name in `/data/secrets/ssh/`, optional) — once for every project; read that file first and reuse an existing host when the owner names the same server, otherwise add the connection there (name, ssh, key) and refer to it from the project. Everything about the project on that server — its `path` and `notes` (what runs there, how deploys work, what never to touch) — goes into the project's own entry. Keys are never copied anywhere; a key or password never goes into a project file or hosts.yaml; passwords are not supported.
