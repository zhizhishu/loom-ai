#!/bin/sh
# LOOM cloud real acceptance - Bero-side helper only.
#
# This file is NOT an acceptance run. It is a handful of POSIX sh helpers that Hark
# runs (or sources) by hand on the Bero box to read the two secrets the Win11 side
# needs: the Owner token and a one-time node pairing code. It never starts, stops or
# recreates anything, never edits a file, and never writes a secret to disk.
#
#   . ./cloud-real-acceptance.bero.sh          # source: functions only
#   sh ./cloud-real-acceptance.bero.sh usage   # or run one subcommand
#
# Rules encoded here (read them before changing anything):
#   * the tunnel URL is never hardcoded: it is read from the cloudflared log, which is
#     the only place the quick tunnel mints it (docker-compose.yml:19-30);
#   * `docker compose up`, `restart`, `down`, `--force-recreate` are never run: a
#     cloudflared restart mints a NEW URL and would invalidate the Host's
#     --public-origin, so the URL and the Core are treated as read-only facts;
#   * a secret goes to stdout only. Nothing is appended to a file, a log, a shell
#     history entry this script writes, or the process environment;
#   * stderr carries hints, never a secret.
#
# Sources for every command used below:
#   docker-compose.yml:19-30            read the current trycloudflare URL from `docker compose logs cloudflared`
#   docker-compose.yml:31-32            `docker compose exec core /opt/rovai/rovai-server --data-dir /data token`
#   docker-compose.yml:56,59-60         LISTEN=127.0.0.1:8767 and PUBLIC_ORIGIN are Core's own argv
#   docker/entrypoint.sh:27-30,83       a token is never accepted from the environment; it lives in <DATA_DIR>/web-auth.json
#   crates/rovai-host/src/server.rs:114-117,178-185
#                                       `node-pair` prints the code, `token` prints the Owner token
#   crates/rovai-host/src/node_cli.rs:69-77
#                                       node-pair: code on stdout, `connect:` on stderr
#   scripts/node/README.md:24-33        first pairing takes that one-time code; it expires in 10 minutes
#   crates/rovai-web/src/nodes.rs:2045-2065
#                                       the code is minted only while Core listens on loopback (compose sets that)
#
# Defaults, all overridable from the environment:
#   LOOM_COMPOSE_PROJECT  loomcloud
#   LOOM_CLOUD_SRC        /opt/loom-cloud/src
#   LOOM_COMPOSE_FILE     ${LOOM_CLOUD_SRC}/docker-compose.yml
#   LOOM_CORE_SERVICE     core
#   LOOM_TUNNEL_SERVICE   cloudflared
#   LOOM_DATA_DIR         /data              (inside the container)
#   LOOM_SERVER_PROGRAM   /opt/rovai/rovai-server   (inside the container)

LOOM_COMPOSE_PROJECT=${LOOM_COMPOSE_PROJECT:-loomcloud}
LOOM_CLOUD_SRC=${LOOM_CLOUD_SRC:-/opt/loom-cloud/src}
LOOM_COMPOSE_FILE=${LOOM_COMPOSE_FILE:-${LOOM_CLOUD_SRC}/docker-compose.yml}
LOOM_CORE_SERVICE=${LOOM_CORE_SERVICE:-core}
LOOM_TUNNEL_SERVICE=${LOOM_TUNNEL_SERVICE:-cloudflared}
LOOM_DATA_DIR=${LOOM_DATA_DIR:-/data}
LOOM_SERVER_PROGRAM=${LOOM_SERVER_PROGRAM:-/opt/rovai/rovai-server}

# Hints go to stderr only. Nothing here may print a secret.
loom_hint() { printf '%s\n' "hint: $*" >&2; }
loom_error() { printf '%s\n' "error: $*" >&2; }

loom_usage() {
    cat <<'USAGE'
LOOM cloud real acceptance - Bero helper (read-only)

  usage                     this text
  origin_print              print the current tunnel origin (read from the cloudflared log)
  origin_export             print `export LOOM_CLOUD_BASE_URL=...` for this shell
  owner_token_print         print the Owner token to stdout (copy it, do not save it)
  owner_token_export        print `export LOOM_OWNER_TOKEN=...` for this shell
  pair_code_print           print one-time node pairing code (stdout) and its connect: URL (stderr)
  ps1_env_hint              print the environment the Win11 script expects
  preflight                 print read-only status: compose services + both required facts

Nothing here writes a file, restarts a service or edits the tunnel.

Secrets stay in the terminal: redirect nothing, paste nothing into a chat, and remember
that `export` puts the value into every child process environment of this shell.
USAGE
}

loom_require() {
    if [ ! -r "$LOOM_COMPOSE_FILE" ]; then
        loom_error "compose file is not readable: $LOOM_COMPOSE_FILE (set LOOM_CLOUD_SRC or LOOM_COMPOSE_FILE)"
        return 1
    fi
    if ! command -v docker >/dev/null 2>&1; then
        loom_error "docker is not on PATH; these helpers only read the running loomcloud stack"
        return 1
    fi
    return 0
}

loom_compose() {
    loom_require || return 1
    docker compose -p "$LOOM_COMPOSE_PROJECT" -f "$LOOM_COMPOSE_FILE" "$@"
}

origin_print() {
    # The quick tunnel URL is minted by cloudflared and lives in its own log; the compose
    # file says so and warns that a cloudflared restart changes it (docker-compose.yml:19-30).
    loom_require || return 1
    origin=$(loom_compose logs --no-log-prefix --tail 2000 "$LOOM_TUNNEL_SERVICE" 2>/dev/null \
        | sed -n 's#.*\(https://[A-Za-z0-9][A-Za-z0-9.-]*\.trycloudflare\.com\).*#\1#p' \
        | tail -n 1)
    if [ -z "$origin" ]; then
        loom_error "no trycloudflare origin found in the ${LOOM_TUNNEL_SERVICE} log; is the tunnel service running?"
        return 1
    fi
    printf '%s\n' "$origin"
    loom_hint "that origin must be exactly the Core's --public-origin (PUBLIC_ORIGIN in the compose environment); otherwise every Web request is origin_not_allowed"
}

origin_export() {
    origin=$(origin_print 2>/dev/null) || return 1
    printf "export LOOM_CLOUD_BASE_URL='%s'\n" "$origin"
    loom_hint "the Win11 script takes this value as -CloudBaseUrl; it is not a secret"
}

owner_token_print() {
    # `rovai-server token` prints the stored management token (server.rs:159-185) and the
    # image never accepts one from the environment (docker/entrypoint.sh:27-30).
    loom_require || return 1
    token=$(loom_compose exec -T "$LOOM_CORE_SERVICE" "$LOOM_SERVER_PROGRAM" --data-dir "$LOOM_DATA_DIR" token 2>/dev/null)
    if [ -z "$token" ]; then
        loom_error "the Core did not print a token; is the ${LOOM_CORE_SERVICE} service running?"
        return 1
    fi
    printf '%s\n' "$token"
    loom_hint "Owner token printed on stdout only; it is read from <DATA_DIR>/web-auth.json inside the container"
    loom_hint "never pass it as a command-line argument on Win11: set LOOM_OWNER_TOKEN or -OwnerTokenSecure there"
}

owner_token_export() {
    token=$(owner_token_print 2>/dev/null) || return 1
    printf "export LOOM_OWNER_TOKEN='%s'\n" "$token"
    loom_hint "export makes the token visible to every child process of this shell; prefer keeping it out of the environment"
}

pair_code_print() {
    # node-pair prints the one-time code on stdout and the `connect:` URL on stderr
    # (node_cli.rs:69-77). Both streams are passed through untouched, so this helper
    # never has to hold the code itself.
    loom_require || return 1
    loom_compose exec -T "$LOOM_CORE_SERVICE" "$LOOM_SERVER_PROGRAM" --data-dir "$LOOM_DATA_DIR" node-pair
    status=$?
    loom_hint "the code is single use and expires after 10 minutes; the Win11 script reads it from LOOM_PAIR_CODE, stdin or a hidden prompt"
    loom_hint "upstream refuses to mint a code unless Core itself listens on loopback, which the compose sets as LISTEN=127.0.0.1:8767 (nodes.rs:2045-2065)"
    return $status
}

ps1_env_hint() {
    cat <<'HINT'
Set these on the Windows 11 machine before running scripts/acceptance/cloud-real-acceptance.ps1:

  $env:LOOM_OWNER_TOKEN = '<owner_print_token output>'    # or pass -OwnerTokenSecure (SecureString)
  $env:OCT_API_KEY      = '<oct gateway key>'             # the model credential, read from this variable only
  $env:LOOM_PAIR_CODE   = '<pair_code_print output>'      # first pairing only; omit once node.json exists

  powershell -NoProfile -ExecutionPolicy Bypass -File cloud-real-acceptance.ps1 \
    -CloudBaseUrl <origin_print output> -NodePackageDir <kit directory>

Omit LOOM_PAIR_CODE when the node already has a credential: Connect-LoomNode.ps1 then
reconnects without one (scripts/node/README.md:52-62).
HINT
    loom_hint "these lines are printed for the operator to type; this script writes nothing"
}

preflight() {
    loom_require || return 1
    printf 'compose project: %s\n' "$LOOM_COMPOSE_PROJECT"
    printf 'compose file:    %s\n' "$LOOM_COMPOSE_FILE"
    loom_compose ps 2>/dev/null || return 1
    printf '\ntunnel origin (read from the %s log):\n' "$LOOM_TUNNEL_SERVICE"
    origin=$(origin_print 2>/dev/null)
    if [ -n "$origin" ]; then printf '  %s\n' "$origin"; else printf '  (not found)\n'; fi
    printf '\nCore must advertise exactly that value as --public-origin.\n'
    loom_hint "compare it with PUBLIC_ORIGIN in the compose environment and with the Win11 -CloudBaseUrl; nothing here changes either"
}

# Dispatch only when the file was executed, not sourced. When sourced, $0 is the calling
# shell (or the sourcing script), so the caller keeps the functions and the shell.
if [ "${0##*/}" = "cloud-real-acceptance.bero.sh" ]; then
    set -u
    command_name=${1:-usage}
    case "$command_name" in
        usage|-h|--help|help) loom_usage ;;
        origin_print) origin_print ;;
        origin_export) origin_export ;;
        owner_token_print) owner_token_print ;;
        owner_token_export) owner_token_export ;;
        pair_code_print) pair_code_print ;;
        ps1_env_hint) ps1_env_hint ;;
        preflight) preflight ;;
        *)
            loom_error "unknown command: $command_name"
            loom_usage >&2
            exit 64
            ;;
    esac
fi
