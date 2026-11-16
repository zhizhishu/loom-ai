#!/bin/sh
# Match the Server's configured LISTEN port, never a public/authenticated URL.
# A candidate may use a non-default port to coexist with an installed service.
set -eu
listen=${LISTEN:-0.0.0.0:8767}
case "$listen" in
  *:*) host=${listen%:*}; port=${listen##*:} ;;
  *) printf '%s\n' 'loom-health: invalid LISTEN' >&2; exit 1 ;;
esac
case "$port" in
  ''|*[!0-9]*) printf '%s\n' 'loom-health: invalid port' >&2; exit 1 ;;
esac
# Bound before shell arithmetic, so hostile/oversized input cannot overflow.
[ "${#port}" -le 5 ] && [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || {
  printf '%s\n' 'loom-health: invalid port' >&2; exit 1;
}
case "$host" in
  '::'|'[::]'|'::1'|'[::1]') probe_host='[::1]' ;;
  localhost|0.0.0.0|127.*) probe_host=127.0.0.1 ;;
  # A specific non-loopback interface is allowed only as a plain IP literal.
  # Never let LISTEN inject a URL, credential, query or curl option.
  ''|*[!0-9.]*) printf '%s\n' 'loom-health: unsupported bind address' >&2; exit 1 ;;
  *) probe_host=$host ;;
esac
# Do not use ambient proxies or accept a redirect to an unrelated service.
# Exit 1 consistently (Docker reserves healthcheck exit 2).
status=$(curl --noproxy '*' --max-time 4 -sS -o /dev/null -w '%{http_code}' \
  "http://${probe_host}:${port}/") || exit 1
[ "$status" = 200 ]
