#!/usr/bin/env bash
#
# LOOM one-command runner for the DE-BERO host.
#
#   bash scripts/cloud/bero-up.sh <loom-personal-preview-linux-<sha>.tar.gz>
#   bash scripts/cloud/bero-up.sh --upgrade <loom-personal-preview-linux-<sha>.tar.gz>
#
# Input is one downloaded CI Linux personal artifact (uploaded by
# .github/workflows/loom-v2-e3-linux.yml as loom-personal-preview-linux-<sha>,
# assembled by scripts/package-linux-personal.mjs). Output is a running Core +
# WebUI behind a cloudflared quick tunnel, plus the operator facts needed to use
# it: tunnel URL, image tag, where the Owner token lives and the exact command
# that prints it.
#
# Both modes share one build path: the archive is extracted, the allowlisted
# payload is staged and the `runtime` image is built exactly the same way. They
# differ only in what they do to the running compose stack:
#   * normal (no flag) starts cloudflared + core, waits for the quick tunnel URL
#     and recreates core once with PUBLIC_ORIGIN=<that URL>.
#   * --upgrade leaves the running stack alone. It never runs the initial
#     `docker compose up -d --wait`, never starts or restarts cloudflared, and
#     never recreates the tunnel. It reads the CURRENT quick tunnel URL from
#     /opt/loom-cloud/url.txt (only a URL of the exact shape
#     https://<name>.trycloudflare.com is accepted), falls back to
#     `docker compose logs cloudflared` when that file is missing, unreadable
#     or invalid, refuses if neither source holds a URL, and recreates ONLY core
#     with the new image and that URL, via `--force-recreate --no-deps`. The live
#     tunnel URL therefore keeps working.
#     No volume is removed, `down` is never run and /data (rovai.sqlite,
#     web-auth.json, skills, logs) is reused as-is, so the Owner token and all
#     server state survive the upgrade.
#
# Nothing here compiles: no cargo, no pnpm, no npm, no python3, neither inside
# nor outside the image. The only build is the `runtime` stage of
# docker/Dockerfile, from binaries CI already built. Nothing secret is printed:
# the Owner token stays in /data/web-auth.json inside the core container and is
# read only by an explicit operator command.
#
# Why this extracts the payload directly instead of replaying manifest.json:
#   * The server package is already inside the personal package —
#     scripts/package-linux-personal.mjs cpSync()s the whole built server package
#     (rovai, rovai-host, rovai-server, web-ui/, skills/, LICENSE, package-info,
#     linux-abi.json, manifest.json) into it, then deletes install-server.sh and
#     replaces README.md with the personal guide.
#   * docker/Dockerfile consumes exactly this tree: `COPY package/ /opt/rovai/`
#     (plus entrypoint.sh/healthcheck.sh, staged from this checkout) and
#     presence checks for web-ui/index.html, skills/cli-operations/SKILL.md,
#     manifest.json and linux-abi.json. So copying exactly those files is all the
#     image needs; nothing is rewritten and README.md is not regenerated.
#   * Strict provenance — dirty=false plus a sha256 replay of every manifest
#     entry — belongs to scripts/smoke-linux-server.py (Gate A, driven by
#     .github/workflows/full-check.yml) and the server package's own manifest. It
#     is not the live Bero acceptance path. CI personal artifacts legitimately
#     record dirty=true because their workflow checks out pinned reference repos
#     inside the worktree (_artifacts/reference-repos/pi-purge-current) before
#     building the server package. This runner therefore uses the CI-produced
#     binaries as delivered and makes no Gate A provenance claim; it rewrites no
#     manifest and only warns.
#   Only the allowlisted payload is copied. The embedded Pi runtime is part of
#   that allowlist — runtime/pi and runtime/extensions are staged into the image
#   so Core can configure Pi (members.runtime.set pi) — while the remaining
#   personal-package extras (runtime/computer, runtime/office, rovai-core,
#   loom-node, *-Loom.sh, candidate-manifest.json) never reach the build
#   context or the image.
set -Eeuo pipefail
umask 022

usage() {
  printf 'usage: bash scripts/cloud/bero-up.sh <CI-linux-personal.tar.gz>\n' >&2
  printf '       bash scripts/cloud/bero-up.sh --upgrade <CI-linux-personal.tar.gz>\n' >&2
  printf '  --upgrade  build the new image, then recreate only core against the\n' >&2
  printf '             existing cloudflared quick tunnel URL (cloudflared and /data\n' >&2
  printf '             are left untouched)\n' >&2
}

die() {
  printf 'bero-up: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '==> %s\n' "$*" >&2
}

# Own the working directory from this script's own location, never from $PWD.
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) ||
  die 'could not resolve the script directory'
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P) ||
  die 'could not resolve the repository root'
cd "$repo_root"

for required in docker-compose.yml docker/Dockerfile docker/entrypoint.sh docker/healthcheck.sh; do
  [ -f "$required" ] || die "$repo_root is not a LOOM checkout: missing $required"
done

# Pin the docker compose project for EVERY compose call in this script.
# docker compose derives the default project name from the working directory:
# run from the on-host checkout /opt/loom-cloud/src the default project would be
# "src", but the running Bero stack (and cloud-real-acceptance.bero.sh) uses the
# project "loomcloud". Unpinned, --upgrade would target the wrong namespace and
# create a parallel src-core/src_loom-data stack with a fresh empty volume and
# no cloudflared service, then fail. Exporting COMPOSE_PROJECT_NAME before the
# first docker compose invocation below (the version check, then logs/up/ps)
# makes loomcloud the project for all of them; set LOOM_COMPOSE_PROJECT to
# override it when a host runs the stack under a different project name.
export COMPOSE_PROJECT_NAME="${LOOM_COMPOSE_PROJECT:-loomcloud}"

mode=normal
if [ "${1:-}" = '--upgrade' ]; then
  mode=upgrade
  shift
fi
[ "$#" -eq 1 ] || { usage; exit 2; }
archive_input=$1
case "$archive_input" in
  -*) usage; exit 2 ;;
esac
[ -f "$archive_input" ] && [ -r "$archive_input" ] ||
  die "input is not a readable file: $archive_input"
case "$archive_input" in
  *.tar.gz | *.tgz) ;;
  *) die "expected the CI personal package archive (*.tar.gz), got: $archive_input" ;;
esac
archive=$(CDPATH= cd -- "$(dirname -- "$archive_input")" && pwd -P)/$(basename -- "$archive_input")

for tool in docker tar; do
  command -v "$tool" >/dev/null 2>&1 ||
    die "$tool is required; install it first (this runner installs nothing)"
done
docker compose version >/dev/null 2>&1 ||
  die 'docker compose (v2) is required; this runner drives docker compose only'

work=$(mktemp -d "${TMPDIR:-/tmp}/loom-bero-up.XXXXXXXX") ||
  die 'could not create a temporary work directory'
cleanup() {
  status=$?
  trap - EXIT
  if [ -n "${work:-}" ] && [ -d "$work" ]; then
    rm -rf -- "$work" || printf 'bero-up: warning: could not remove %s\n' "$work" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------- 1. extract
log "extracting $(basename -- "$archive")"
mkdir -p "$work/extract"
tar -xzf "$archive" -C "$work/extract" ||
  die "could not extract $archive (is it a complete *.tar.gz?)"
personal="$work/extract/loom-personal-linux-x64"
[ -d "$personal" ] ||
  die "expected a single top-level loom-personal-linux-x64/ directory in $archive"

# ------------------------------------------------- 2. read the package facts
manifest=$personal/manifest.json
[ -f "$manifest" ] ||
  die "loom-personal-linux-x64/manifest.json is missing; not a CI linux personal package"
grep -Eq '"target"[[:space:]]*:[[:space:]]*"linux-x64"' "$manifest" ||
  die 'manifest target is not linux-x64; this runner only serves the CI linux-x64 package'
grep -Eq '"profile"[[:space:]]*:[[:space:]]*"debug"' "$manifest" ||
  die 'manifest profile is not debug; this runner only serves the CI debug candidate package'
if grep -Eq '"dirty"[[:space:]]*:[[:space:]]*true' "$manifest"; then
  log 'warning: manifest records dirty=true (CI stages reference repos in the checkout); continuing — Gate A provenance is not claimed here'
fi
source_commit=$(sed -n 's/^[[:space:]]*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' "$manifest")
if [ -z "$source_commit" ]; then
  source_commit=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null) ||
    die 'manifest.json records no source commit and this checkout has no git HEAD'
  log "manifest records no source commit; labelling the image from git HEAD $source_commit"
fi

# ----------------------------------------- 3. stage the docker build context
# Exactly what docker/Dockerfile copies: the server payload under package/ —
# including the embedded Pi runtime staged below as package/runtime/pi and
# package/runtime/extensions — plus the two container scripts. No source
# checkout, no .git, no credential, and no other personal-package extra can
# enter the context.
log 'staging the docker context from the personal package payload'
context=$work/context
package=$context/package
mkdir -p "$package"
payload=(rovai rovai-host rovai-server web-ui skills LICENSE package-info linux-abi.json manifest.json)
for item in "${payload[@]}"; do
  [ -e "$personal/$item" ] && [ ! -L "$personal/$item" ] ||
    die "the personal package has no regular $item; it is not a complete linux-x64 server package"
  cp -a -- "$personal/$item" "$package/$item"
done
# The personal package ships the embedded Pi runtime
# (scripts/package-linux-personal.mjs REQUIRED: runtime/pi/pi-bundle.json,
# runtime/pi/node/node, runtime/pi/pi and
# runtime/extensions/pi-purge/upstream/extensions/pi-purge.ts). The server image
# must carry it: without /opt/rovai/runtime/pi Core resolves no packaged Pi
# bundle and members.runtime.set pi answers runtime_configuration_unavailable.
# Stage exactly runtime/pi and runtime/extensions under package/runtime —
# docker/Dockerfile's `COPY package/ /opt/rovai/` lands them at
# /opt/rovai/runtime/… where ROVAI_EMBEDDED_PI_ROOT (docker-compose.yml) points
# and crates/rovai-core/src/pi/host.rs finds the pinned pi-purge source. The
# rest of runtime/ (computer, office) is deliberately left out, so runtime/ is
# never copied whole.
mkdir -p "$package/runtime"
for runtime_item in pi extensions; do
  [ -e "$personal/runtime/$runtime_item" ] && [ ! -L "$personal/runtime/$runtime_item" ] ||
    die "the personal package has no regular runtime/$runtime_item; it is not a complete linux-x64 personal package with the embedded Pi runtime"
  cp -a -- "$personal/runtime/$runtime_item" "$package/runtime/$runtime_item"
done
cp docker/Dockerfile docker/entrypoint.sh docker/healthcheck.sh "$context/"
# smoke-linux-server.py is only used by the `verify` stage, which is not built
# here (`--target runtime`), so it stays out of the context.
version=$(sed -n 's/^version=//p' "$package/package-info")
log "payload: rovai-server ${version:-unknown}, commit $source_commit"

log 'resolving the immutable ubuntu:22.04 base image digest'
docker pull -q ubuntu:22.04 >/dev/null || die 'could not pull ubuntu:22.04'
base_image=$(docker inspect --format '{{index .RepoDigests 0}}' ubuntu:22.04) ||
  die 'could not inspect ubuntu:22.04 after pulling it'
case "$base_image" in
  ubuntu@sha256:*) ;;
  *) die "could not resolve an immutable ubuntu:22.04 digest (got: $base_image)" ;;
esac

image="loom-bero-core:sha-$source_commit"
log "building the runtime image $image (no Rust or Node compilation)"
docker build --progress=plain --target runtime \
  --build-arg "BASE_IMAGE=$base_image" \
  --build-arg "SOURCE_COMMIT=$source_commit" \
  --build-arg BUILD_PROFILE=debug \
  -t "$image" -f "$context/Dockerfile" "$context" ||
  die "docker build failed for $image (see the build log above)"

# ---------------------------------------------------- 4. cloudflared + core
export LOOM_IMAGE="$image"

# The quick tunnel URL lives in cloudflared's own log and changes only when
# cloudflared restarts, so the most recent URL there is the live one. Normal
# mode always reads it from there; upgrade mode reaches this scan only as the
# fallback, after /opt/loom-cloud/url.txt fails to yield a valid URL.
current_tunnel_url() {
  docker compose logs cloudflared 2>/dev/null |
    grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true
}

if [ "$mode" = upgrade ]; then
  # Upgrade never brings the stack up: cloudflared must already be running, and
  # its current URL is reused verbatim so existing clients keep working. The
  # URL is taken from /opt/loom-cloud/url.txt when that file holds a valid
  # https://<name>.trycloudflare.com URL; only when it is missing, unreadable
  # or invalid does the cloudflared log scan below run as the fallback.
  log 'upgrade: reading the current quick tunnel URL (url.txt first, cloudflared logs as fallback)'
  tunnel_url=''
  url_file=/opt/loom-cloud/url.txt
  if [ -f "$url_file" ] && [ -r "$url_file" ]; then
    candidate=''
    IFS= read -r candidate < "$url_file" || true
    if [[ $candidate =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]]; then
      tunnel_url=$candidate
      log "upgrade: using the current tunnel URL from $url_file"
    else
      log "upgrade: $url_file holds no https://<name>.trycloudflare.com URL; falling back to the cloudflared logs"
    fi
  else
    log "upgrade: $url_file is missing or unreadable; falling back to the cloudflared logs"
  fi
  if [ -z "$tunnel_url" ]; then
    tunnel_url=$(current_tunnel_url)
  fi
  [ -n "$tunnel_url" ] ||
    die 'upgrade refused: neither /opt/loom-cloud/url.txt nor docker compose logs cloudflared shows a https://<name>.trycloudflare.com URL; start the stack first (normal mode, or docker compose up -d --wait) — core was not recreated'

  # --no-deps keeps cloudflared out of the recreation: it is neither started nor
  # restarted, so the tunnel URL stays valid. No volume is removed and no `down`
  # runs, so /data and the Owner token survive the upgrade.
  log "upgrade: recreating only core with image $image and the reused PUBLIC_ORIGIN=$tunnel_url (cloudflared untouched, /data kept)"
  PUBLIC_ORIGIN="$tunnel_url" docker compose up -d --force-recreate --no-deps --wait core ||
    die 'core did not become healthy on the new image; inspect: docker compose logs core (no volume and no /data was removed)'
else
  log 'starting cloudflared and core'
  docker compose up -d --wait ||
    die 'docker compose up --wait did not reach a healthy state; inspect: docker compose ps; docker compose logs core'

  log 'waiting up to 60s for the cloudflared quick tunnel URL'
  tunnel_url=''
  deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    tunnel_url=$(current_tunnel_url)
    if [ -n "$tunnel_url" ]; then
      break
    fi
    sleep 2
  done
  [ -n "$tunnel_url" ] ||
    die 'cloudflared did not print a https://<name>.trycloudflare.com URL within 60s; inspect: docker compose logs cloudflared'

  # Only core is recreated, so PUBLIC_ORIGIN takes effect without minting a new
  # tunnel URL. cloudflared keeps running untouched.
  log "recreating core with PUBLIC_ORIGIN=$tunnel_url (cloudflared is left running)"
  PUBLIC_ORIGIN="$tunnel_url" docker compose up -d --force-recreate --wait core ||
    die 'core did not become healthy with the new PUBLIC_ORIGIN; inspect: docker compose logs core'
fi

# ------------------------------------------------------------ 5. operator output
if [ "$mode" = upgrade ]; then
  cat <<EOF

LOOM Core was upgraded in place through the existing cloudflared quick tunnel.

  new image        : $image
  reused tunnel URL: $tunnel_url
  source commit    : $source_commit
  cloudflared      : left running, tunnel URL unchanged
  data             : untouched (/data volume reused, nothing removed)
  Owner token file : /data/web-auth.json (inside the core container)
EOF
else
  cat <<EOF

LOOM Core is up through the cloudflared quick tunnel.

  tunnel URL      : $tunnel_url
  image           : $image
  source commit   : $source_commit
  Owner token file: /data/web-auth.json (inside the core container)
EOF
fi

cat <<EOF

Read the Owner token only when you choose to. Its stdout is a secret: do not
paste it into logs, issues, URLs or chat.
  docker compose exec core /opt/rovai/rovai-server --data-dir /data token

Pair another machine as a node (not run by this script):
  docker compose exec core /opt/rovai/rovai-server --data-dir /data node-pair

The tunnel is outbound-only: nothing publishes a host port. Stop it with
  docker compose down
EOF
