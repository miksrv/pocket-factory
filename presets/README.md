# Presets

A preset is a ready-made bundle of factory files — sub-agents, skills and project templates — that a colleague can install with one click from the web UI (Presets → Install) or by copying the files onto the volume.

```
presets/<name>/
├── preset.json          # { "title", "description", "tags": [] }
├── README.md            # shown in the UI under "Details"
├── agents/<agent>.md    # → data/claude/agents/
├── skills/<skill>/SKILL.md
└── projects/<slug>.md   # → data/config/projects/ (templates to fill in)
```

Installing never overwrites files that already exist unless you choose *Reinstall*. After installation the files belong to the owner: edit them in the UI or let the agent update them ("remember: …").

Keep presets free of personal facts (hostnames, tokens, people). Anything installation-specific goes into the project file the owner fills in.

## Sharing with a team

Fork the repository, add your presets under `presets/`, commit. Everyone on the team who runs their own factory from that fork sees them in the UI. The factory itself stays single-owner: each person uses their own Claude login, Telegram bot and GitHub token.
