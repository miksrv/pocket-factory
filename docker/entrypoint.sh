#!/bin/sh
# Container entrypoint: prepare /data on first start, wire git/gh, then exec.
set -e

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/data/claude}"
DATA_ROOT="${DATA_ROOT:-/data}"

mkdir -p "$CLAUDE_CONFIG_DIR" \
    "$DATA_ROOT/config/projects" \
    "$DATA_ROOT/workspaces" \
    "$DATA_ROOT/db" \
    "$DATA_ROOT/logs"

# Seed Claude Code's config dir from the templates once; never overwrite the
# owner's edited files afterwards.
if [ ! -f "$CLAUDE_CONFIG_DIR/CLAUDE.md" ]; then
    echo "[entrypoint] seeding $CLAUDE_CONFIG_DIR from templates"
    cp -Rn /app/templates/claude/. "$CLAUDE_CONFIG_DIR"/
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
