#!/usr/bin/env bash
# Loom Node kit (macOS): connect or reconnect this machine.
#
# The pairing code never touches argv, the environment, a file, or a log. It is
# read once from a hidden interactive prompt or from the first stdin line and
# handed to loom-node only through its stdin pipe (--pair-code-stdin).
#
# Requires bash (not POSIX sh): interactive read, character classes and
# parameter expansion below are bash features.
set -u

connect_path='/api/v1/nodes/connect'

die() {
    printf 'Connect-LoomNode: %s\n' "$*" >&2
    exit 1
}

# ---- arguments -------------------------------------------------------------
server=''
data_dir=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -s | --server)
            [ "$#" -ge 2 ] || die 'Missing the value for --server.'
            server=$2
            shift 2
            ;;
        -d | --data-dir)
            [ "$#" -ge 2 ] || die 'Missing the value for --data-dir.'
            data_dir=$2
            shift 2
            ;;
        *)
            die "Unknown argument: $1 (usage: Connect-LoomNode.sh -s <ws://|wss://host/api/v1/nodes/connect> [-d <data dir>])"
            ;;
    esac
done

# ---- server: absolute ws/wss URL ending at the outbound node channel path ---
[ -n "$server" ] || die 'Server is empty. Pass -s wss://host/api/v1/nodes/connect.'
case "$server" in
    *[[:space:]]*) die 'Server must not contain whitespace.' ;;
esac
case "$server" in
    *'"'*) die 'Server must not contain a double quote.' ;;
esac
case "$server" in
    ws://?* | wss://?*) ;;
    *) die 'Server must be an absolute ws:// or wss:// URL.' ;;
esac

scheme=${server%%://*}
remainder=${server#*://}
authority=${remainder%%/*}
if [ "$authority" = "$remainder" ]; then
    url_path=''
else
    url_path=/${remainder#*/}
fi
case "$url_path" in
    *"$connect_path") ;;
    *) die "Server path must end with ${connect_path}." ;;
esac

host=${authority##*@}
case "$host" in
    \[*) host=${host%%]*} && host=${host#\[} ;;
    *) host=${host%%:*} ;;
esac
[ -n "$host" ] || die 'Server is missing a host.'
if [ "$scheme" = 'ws' ]; then
    host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
    case "$host" in
        localhost | 127.0.0.1 | ::1) ;;
        *) die 'Plaintext ws:// is only allowed to a loopback host. Use wss:// for a remote server.' ;;
    esac
fi

# ---- data directory: holds loom-node's own node.json credential -------------
if [ -z "$data_dir" ]; then
    [ -n "${HOME:-}" ] || die 'HOME is unset. Pass -d with an explicit data directory.'
    data_dir="$HOME/Library/Application Support/LoomNode"
fi
while [ "${data_dir%/}" != "$data_dir" ]; do
    data_dir=${data_dir%/}
done
[ -n "$data_dir" ] || die 'DataDir must not be the filesystem root.'
mkdir -p -- "$data_dir" 2>/dev/null || die "Could not create the data directory: $data_dir"
[ -d "$data_dir" ] || die "Could not create the data directory: $data_dir"

# ---- loom-node beside this script, whatever the working directory is -------
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || die 'Could not resolve the script directory.'
node_bin=$script_dir/loom-node
[ -f "$node_bin" ] || die "loom-node was not found beside this script: $node_bin"
[ -x "$node_bin" ] || die "loom-node is not executable: $node_bin"

credential=$data_dir/node.json
if [ -e "$credential" ]; then
    printf 'Reconnecting with the stored node credential: %s\n' "$credential"
    exec "$node_bin" --data-dir "$data_dir" --server "$server"
fi

# ---- first pairing only: one code, never stored by this script --------------
printf 'Pairing this node once; the code is used once and not stored by this script.\n'
pair_code=''
if [ -t 0 ]; then
    printf 'One-time pairing code: ' >&2
    IFS= read -rs pair_code || true
    printf '\n' >&2
else
    IFS= read -r pair_code || true
fi
pair_code=${pair_code#"${pair_code%%[![:space:]]*}"}
pair_code=${pair_code%"${pair_code##*[![:space:]]}"}
# Errors below never echo the code itself.
[ -n "$pair_code" ] || die 'The pairing code is empty.'
[ "${#pair_code}" -le 4096 ] || die 'The pairing code is longer than loom-node accepts.'
case "$pair_code" in
    *[[:cntrl:]]*) die 'The pairing code contains control characters.' ;;
esac

printf '%s\n' "$pair_code" | "$node_bin" --data-dir "$data_dir" --server "$server" --pair-code-stdin
status=$?
unset pair_code
exit "$status"
