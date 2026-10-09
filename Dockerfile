# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
ARG CLAUDE_CODE_VERSION=2.1.283
# Toolchains for the agents (see docs/plans/toolchains.md): mise installs language runtimes
# per checkout into /data/tools, PHP comes from the sury repository (compiling it through
# mise is slow), the docker CLI talks to the optional dind sidecar (docker-compose.yml).
ARG MISE_VERSION=2026.10.6
ARG PHP_VERSION=8.2

# ---- base: node + git + gh + unmodified Claude Code CLI -------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG CLAUDE_CODE_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client ripgrep \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code is installed exactly as published. The version is pinned so the
# supervisor's stream-json parsing is tested against a known CLI.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && corepack enable

# ---- deps: install workspace dependencies ---------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY supervisor/package.json supervisor/
COPY web/package.json web/
RUN yarn install --immutable

# ---- build: compile the supervisor and bundle the web UI -----------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY supervisor/ supervisor/
COPY web/ web/
RUN yarn build

# ---- tools: what the agents build and test with ---------------------------
# Kept out of `base` so the deps / build stages stay small and cache well.
FROM base AS tools
ARG NODE_VERSION
ARG MISE_VERSION
ARG PHP_VERSION

# Build tools (cgo, native node modules, make), the sury PHP repository and the
# docker CLI + compose plugin from Docker's own repository.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential pkg-config unzip zip xz-utils jq procps less \
    && curl -fsSL https://packages.sury.org/php/apt.gpg -o /usr/share/keyrings/sury-php.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ bookworm main" \
        > /etc/apt/sources.list.d/sury-php.list \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /usr/share/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        php${PHP_VERSION}-cli php${PHP_VERSION}-mbstring php${PHP_VERSION}-xml php${PHP_VERSION}-intl \
        php${PHP_VERSION}-curl php${PHP_VERSION}-zip php${PHP_VERSION}-mysql php${PHP_VERSION}-pgsql \
        php${PHP_VERSION}-sqlite3 php${PHP_VERSION}-bcmath php${PHP_VERSION}-gd \
        docker-ce-cli docker-compose-plugin docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# composer, verified against the checksum getcomposer.org publishes next to it.
RUN curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar -o /usr/local/bin/composer \
    && curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar.sha256sum \
        | sed 's# .*# /usr/local/bin/composer#' | sha256sum -c - \
    && chmod +x /usr/local/bin/composer

# mise: one static binary; the tools it installs live on the /data/tools volume.
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${arch}.tar.gz" \
        | tar -xz -C /usr/local --strip-components=1 mise/bin/mise \
    && mise --version

# The factory's mise policy: no prompts, read the repositories' own version files
# (.nvmrc, .python-version, go.mod's toolchain …), trust every checkout's mise.toml,
# and a node of the image's major everywhere a checkout does not ask for another
# (the entrypoint installs it, so the shim always resolves).
RUN mkdir -p /etc/mise && printf '%s\n' \
    '[settings]' \
    'yes = true' \
    'idiomatic_version_file_enable_tools = ["node", "go", "python", "ruby", "java", "php", "bun", "deno"]' \
    'trusted_config_paths = ["/data/workspaces"]' \
    '' \
    '[tools]' \
    "node = \"${NODE_VERSION}\"" \
    > /etc/mise/config.toml

# ---- runtime --------------------------------------------------------------
FROM tools AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOME=/home/node \
    CLAUDE_CONFIG_DIR=/data/claude \
    WORKSPACES_ROOT=/data/workspaces \
    DATA_ROOT=/data \
    WEB_DIST=/app/web/dist \
    PRESETS_DIR=/app/presets \
    MISE_DATA_DIR=/data/tools/mise \
    MISE_CACHE_DIR=/data/tools/cache \
    MISE_STATE_DIR=/data/tools/state \
    MISE_GLOBAL_CONFIG_FILE=/data/tools/config.toml \
    PATH=/data/tools/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Shims first: an agent's `node`, `npm`, `yarn` follow the checkout's own version file. The
# Claude Code CLI is a native binary (bin/claude.exe, verified 2026-10-09), so a `.nvmrc` in
# the project it runs in does not touch it; the supervisor starts by absolute path.

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/supervisor/dist ./supervisor/dist
COPY --from=build /app/web/dist ./web/dist
COPY supervisor/package.json ./supervisor/
COPY package.json ./
COPY templates/ ./templates/
COPY presets/ ./presets/
COPY docker/entrypoint.sh docker/gh docker/gh-token docker/git-credential-owner /usr/local/bin/

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/gh /usr/local/bin/gh-token /usr/local/bin/git-credential-owner \
    && mkdir -p /data /data/tools /home/node \
    && chown -R node:node /data /home/node

# The factory's known_hosts lives with its config, not with the read-only keys:
# the UI writes it (Settings → Hosts → Test connection → Trust host key) and
# every ssh an agent runs consults the same file.
RUN printf '\nHost *\n    UserKnownHostsFile /data/config/known_hosts\n' >> /etc/ssh/ssh_config

# Never root: bind-mounted repos keep sane ownership, and Claude Code refuses
# bypassPermissions as root anyway.
USER node

EXPOSE 8080

ENTRYPOINT ["entrypoint.sh"]
# The image's own node by path: the mise shims ahead on PATH are for the agents' commands.
CMD ["/usr/local/bin/node", "supervisor/dist/index.js"]
