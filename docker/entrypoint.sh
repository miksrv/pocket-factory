#!/bin/sh
# Container entrypoint: prepare /data on first start, wire git/gh, then exec.
set -e

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/data/claude}"
DATA_ROOT="${DATA_ROOT:-/data}"

mkdir -p "$CLAUDE_CONFIG_DIR" \
    "$DATA_ROOT/config/projects" \
    "$DATA_ROOT/workspaces" \
    "$DATA_ROOT/db" \
    "$DATA_ROOT/logs" \
    "$DATA_ROOT/secrets"

# Seed Claude Code's config dir from the templates. `cp -n` never overwrites
# the owner's edited files, so new template files (agents, skills) appear on
# upgrade while local changes are kept.
echo "[entrypoint] seeding new template files into $CLAUDE_CONFIG_DIR"
cp -Rn /app/templates/claude/. "$CLAUDE_CONFIG_DIR"/ 2>/dev/null || true

# SSH keys for project hosts live on the volume, never in the image.
if [ -d "$DATA_ROOT/secrets/ssh" ] && [ ! -e "$HOME/.ssh" ]; then
    ln -s "$DATA_ROOT/secrets/ssh" "$HOME/.ssh"
fi

# Bind-mounted repositories may be owned by a different uid than `node`.
git config --global --add safe.directory '*'
git config --global user.name "${GIT_AUTHOR_NAME:-Pocket Factory}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-pocket-factory@localhost}"

# Let `git push` over HTTPS reuse the fine-grained PAT that `gh` uses.
if [ -n "$GH_TOKEN" ]; then
    gh auth setup-git >/dev/null 2>&1 || echo "[entrypoint] warning: gh auth setup-git failed"
fi

exec "$@"
