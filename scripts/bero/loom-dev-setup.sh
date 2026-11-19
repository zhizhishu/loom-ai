#!/bin/bash
# LOOM P-1: create isolated dev container on DE-BERO. Idempotent. Logs to /root/sandbox/projects/loom-dev/logs/setup.log
set -u
B=/root/sandbox/projects/loom-dev
mkdir -p $B/src $B/image $B/logs $B/cache/cargo-registry $B/cache/cargo-git $B/cache/target $B/cache/pnpm $B/bundles
exec >>$B/logs/setup.log 2>&1
echo "=== setup start $(date -Is)"
cat > $B/image/Dockerfile <<'DOCKER'
FROM node:24-bookworm
ARG RUST_VERSION=1.97.1
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH \
    CARGO_TARGET_DIR=/cache/target CARGO_INCREMENTAL=1 \
    CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 \
    PNPM_HOME=/opt/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev git curl ca-certificates jq ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} \
    && rustup component add clippy rustfmt && chmod -R a+w /opt/cargo /opt/rustup
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /src
CMD ["sleep", "infinity"]
DOCKER
if [ ! -d $B/src/.git ]; then
  git clone --branch rovai/loom-v2-personal-20261116 https://github.com/zhizhishu/loom-ai.git $B/src && echo "clone ok $(git -C $B/src rev-parse HEAD)"
fi
if [ ! -d $B/cospan/.git ]; then
  git clone https://github.com/keli-wen/cospan.git $B/cospan && git -C $B/cospan checkout -q 45ab14d1e44687cecbfa3272029cdd4c176e040b && echo "cospan ok"
fi
t0=$(date +%s)
docker build -t loom-dev:base $B/image && echo "image ok $(( $(date +%s)-t0 ))s"
if ! docker ps -a --format '{{.Names}}' | grep -qx loom-dev; then
  docker run -d --name loom-dev --restart unless-stopped \
    -v $B/src:/src -v $B/cospan:/opt/cospan:ro \
    -v $B/cache/cargo-registry:/opt/cargo/registry -v $B/cache/cargo-git:/opt/cargo/git \
    -v $B/cache/target:/cache/target -v $B/cache/pnpm:/root/.local/share/pnpm \
    -v $B/bundles:/bundles -v $B/logs:/logs \
    loom-dev:base && echo "container ok"
fi
docker exec loom-dev bash -lc 'node -v; pnpm -v; rustc -V; cargo -V' 
echo "=== setup done $(date -Is)"
