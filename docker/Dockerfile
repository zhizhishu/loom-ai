# syntax=docker/dockerfile:1
#
# LOOM Host + Web container — CANDIDATE (`--debug`) build only.
#
# Scope and non-claims:
#   * Ships the standalone Server (`rovai-server`) plus its matching WebUI and
#     bundled Skill library. Host+Web only.
#   * The Pi runtime is NOT bundled. `scripts/build-server.mjs` packages no Pi
#     assets, so this image cannot start a Pi agent. Do not claim otherwise
#     until a separately verified Pi bundle exists.
#   * No automatic authentication, no default token, no seeded Owner session.
#   * No agent Runtime (Claude Code, Codex, …) is installed here. Core never
#     installs Runtimes (docs/development/server-preview.md).
#   * Not a release channel: no `latest`, no draft Release, no channel pointer.
#
# Build context is the allowlisted staging directory produced by
# .github/workflows/loom-v2-container.yml. It contains exactly:
#   Dockerfile, entrypoint.sh, healthcheck.sh, smoke-linux-server.py, package/
# There is no source checkout, no `.git`, no credential and no whole working
# tree in the context. `package/` is the native Server package built by
# `node scripts/build-server.mjs --target-key linux-x64 --debug`, whose
# manifest.json must record dirty=false for the exact source commit.
#
# BASE_IMAGE must be an immutable digest reference
# (`ubuntu@sha256:…`); the workflow resolves and records it. The plain tag is
# only a local fallback so a manual build still fails closed on the ABI gate
# rather than silently using a different base.

ARG BASE_IMAGE=ubuntu:22.04

FROM ${BASE_IMAGE} AS runtime

# Recorded provenance; no secret and no user identity is baked in.
ARG SOURCE_COMMIT=unknown
ARG BUILD_PROFILE=debug

LABEL org.opencontainers.image.title="LOOM Host + Web (candidate)" \
      org.opencontainers.image.description="Standalone Rovai Server host+web candidate build. Pi runtime is NOT bundled; authentication is a manually retrieved Owner token." \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="MIT" \
      dev.loom.channel="candidate" \
      dev.loom.build.profile="${BUILD_PROFILE}" \
      dev.loom.bundle.pi="absent" \
      dev.loom.auth="manual-owner-token" \
      dev.loom.release="not-a-release"

ENV DEBIAN_FRONTEND=noninteractive

# curl exists only for the container health probe (`GET /` is public and
# returns the WebUI index, crates/rovai-web/src/lib.rs:317,782).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Dedicated unprivileged identity. The Server must never run as root: opening an
# existing database as root rewrites WAL owner metadata and the next start is
# refused (IdentityChanged{stage:Revalidation}).
RUN groupadd --gid 10001 loom \
 && useradd --uid 10001 --gid 10001 --home-dir /home/loom --create-home \
      --shell /usr/sbin/nologin loom \
 && install -d -o 10001 -g 10001 -m 0700 /data \
 && install -d -o root -g root -m 0755 /opt/rovai

# Program files stay root-owned and read-only to the runtime user; only /data
# and HOME are writable.
COPY --chown=root:root package/ /opt/rovai/
COPY --chown=root:root entrypoint.sh /usr/local/bin/loom-entrypoint
COPY --chown=root:root healthcheck.sh /usr/local/bin/loom-healthcheck

RUN chmod 0755 /usr/local/bin/loom-entrypoint \
 && chmod 0755 /usr/local/bin/loom-healthcheck \
 && chmod 0755 /opt/rovai/rovai-server /opt/rovai/rovai-host /opt/rovai/rovai \
 && test -f /opt/rovai/web-ui/index.html \
 && test -f /opt/rovai/skills/cli-operations/SKILL.md \
 && test -f /opt/rovai/manifest.json \
 && test -f /opt/rovai/linux-abi.json \
 && ! command -v node \
 && ! command -v pnpm \
 && ! command -v cargo

ENV HOME=/home/loom \
    DATA_DIR=/data \
    LISTEN=0.0.0.0:8767 \
    LANG=C.UTF-8

EXPOSE 8767
# /data is pre-owned by uid 10001, so a named or anonymous volume inherits that
# ownership instead of being created root-owned.
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["/usr/local/bin/loom-healthcheck"]

STOPSIGNAL SIGTERM
WORKDIR /opt/rovai
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/loom-entrypoint"]

FROM runtime AS verify

# Verification-only stage: python3 exists here so the workflow can run the
# repository's own Gate A smoke (scripts/smoke-linux-server.py) as uid 10001
# against this exact package. Nothing here is pushed; the runtime stage above is
# the artifact.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --chown=root:root smoke-linux-server.py /opt/loom-verify/smoke-linux-server.py
RUN chmod 0755 /opt/loom-verify/smoke-linux-server.py
USER 10001:10001
WORKDIR /opt/rovai
