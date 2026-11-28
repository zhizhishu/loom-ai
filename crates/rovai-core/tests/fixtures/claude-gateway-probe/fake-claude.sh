#!/bin/sh
# Local, network-free Claude Code stand-in for the member gateway probe test.
# It only accepts a fake gateway environment; it never reads a real credential
# and never contacts ANTHROPIC_BASE_URL.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Calls record argv only. Environment records set/unset booleans only, so the
# member token (and the gateway URL) can never leak through these logs.
printf '%s\n' "$*" >> "$here/calls.log"

gateway=no
if [ "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:-}" = "1" ] &&
   [ -n "${ANTHROPIC_BASE_URL:-}" ] &&
   { [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; }; then
  gateway=yes
fi
printf 'gateway=%s base=%s key=%s token=%s\n' \
  "$gateway" \
  "$([ -n "${ANTHROPIC_BASE_URL:-}" ] && echo set || echo unset)" \
  "$([ -n "${ANTHROPIC_API_KEY:-}" ] && echo set || echo unset)" \
  "$([ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && echo set || echo unset)" \
  >> "$here/env.log"

case "${1:-}" in
  --version)
    printf '%s\n' '2.1.287 (Claude Code)'
    exit 0
    ;;
  --help)
    cat <<'EOF'
Usage: claude [options]
  --print
  --output-format
  --input-format
  --no-session-persistence
  --resume
  --session-id
  --append-system-prompt
  --mcp-config
  --allowedTools
  --add-dir
  --permission-mode
  --model
EOF
    exit 0
    ;;
  auth)
    [ "${2:-}" = "status" ] || exit 64
    if [ "$gateway" = "yes" ]; then
      printf '%s\n' '{"loggedIn":true}'
      exit 0
    fi
    # A non-zero exit with a JSON body drives the health probe's stable
    # authentication-required classification.
    printf '%s\n' '{"loggedIn":false}' >&2
    exit 1
    ;;
  --print)
    IFS= read -r request || exit 1
    request_id=$(printf '%s\n' "$request" | sed -n \
      's/.*"request_id":"\([^"]*\)".*/\1/p')
    [ -n "$request_id" ] || exit 65
    # response.response must be an object, not a JSON string: the health probe
    # parses it as RawValue and then reads its "models" array.
    printf '%s\n' "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"$request_id\",\"response\":{\"models\":[{\"value\":\"gateway-model-a\",\"displayName\":\"Gateway A\",\"supportsEffort\":true,\"supportedEffortLevels\":[\"low\",\"high\"]}]}}}"
    exit 0
    ;;
  *)
    exit 64
    ;;
esac
