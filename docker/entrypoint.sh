#!/bin/sh
# LOOM Host+Web container candidate entrypoint.
#
# It only builds the documented `rovai-server` argv from the environment and
# then `exec`s the native binary, so the Server is PID 1 and keeps its own
# SIGTERM/SIGHUP handlers (crates/rovai-host/src/signals.rs). There is no
# automatic authentication: the container never accepts or prints a token.
set -eu
umask 077

fail() { printf 'loom-container: %s\n' "$*" >&2; exit 64; }

program=/opt/rovai/rovai-server
ui=/opt/rovai/web-ui/index.html
data_dir=${DATA_DIR:-/data}
listen=${LISTEN:-0.0.0.0:8767}
public_origin=${PUBLIC_ORIGIN:-}
verbose=${VERBOSE:-0}

# The entrypoint owns the argv; it must not silently swallow a caller's command.
if [ "$#" -gt 0 ]; then
  fail "this entrypoint takes no arguments (got: $*); use 'docker exec <container> /opt/rovai/rovai-server --data-dir ${data_dir} token' to read the token"
fi

# No implicit credential: a token in the environment would be mergeable from
# `docker inspect` and would fake an authenticated instance.
for name in ROVAI_TOKEN ROVAI_SERVER_TOKEN ROVAI_WEB_TOKEN ADMIN_TOKEN; do
  if [ -n "$(printenv "$name" 2>/dev/null || true)" ]; then
    fail "refusing $name: this image has no automatic authentication; run 'rovai-server token' instead"
  fi
done

# The data root must be an explicit, existing, private directory. The Server
# itself refuses files, symlinks and non-normalized paths (storage_layout.rs).
case "$data_dir" in
  /*) ;;
  *) fail 'DATA_DIR must be an absolute path' ;;
esac
case "$data_dir" in
  *..*) fail 'DATA_DIR must not contain a parent-directory segment' ;;
esac
[ "$data_dir" != / ] || fail 'DATA_DIR must not be the container root'
data_dir=${data_dir%/}
[ -d "$data_dir" ] || fail "DATA_DIR $data_dir does not exist; mount a volume at /data"
[ ! -L "$data_dir" ] || fail 'DATA_DIR must be a real directory, not a symbolic link'
[ -w "$data_dir" ] || fail "DATA_DIR $data_dir is not writable by uid $(id -u)"

[ -x "$program" ] || fail 'matching Server package is missing /opt/rovai/rovai-server'
[ -f "$ui" ] || fail 'matching WebUI is missing /opt/rovai/web-ui/index.html'

case "$listen" in
  *:?*) ;;
  *) fail 'LISTEN must be host:port' ;;
esac
host=${listen%:*}
port=${listen##*:}
[ -n "$host" ] || fail 'LISTEN must name a host'
case "$port" in
  ''|*[!0-9]*) fail 'LISTEN port must be numeric' ;;
esac

case "$host" in
  # Loopback stays the default contract. Anything else is unencrypted LAN HTTP
  # and needs the Server's own explicit switch (rovai-web refuses it otherwise).
  localhost|127.*|::1|\[::1\]) set -- --data-dir "$data_dir" --listen "$listen" ;;
  *) set -- --data-dir "$data_dir" --listen "$listen" --allow-insecure-lan ;;
esac

if [ -n "$public_origin" ]; then
  case "$public_origin" in
    https://?*|http://?*) set -- "$@" --public-origin "$public_origin" ;;
    *) fail 'PUBLIC_ORIGIN must be an absolute http(s) origin' ;;
  esac
fi

case "$verbose" in
  1|true|yes) set -- "$@" --verbose ;;
  0|false|no|'') ;;
  *) fail 'VERBOSE must be 0/1' ;;
esac

# stdio is not a terminal in a container, so the Server never prints the token;
# it stays in <DATA_DIR>/web-auth.json and is read with `rovai-server token`
exec "$program" "$@"
