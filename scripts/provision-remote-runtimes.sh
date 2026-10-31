#!/bin/sh
# Provision the Agent CLIs that a native Rovai Server probes on a fresh
# Debian/Ubuntu host: Claude Code (@anthropic-ai/claude-code) and Codex
# (@openai/codex).
#
# Scope: this script only installs CLIs through npm. It does not read, write or
# migrate rovai-server data, does not start or stop the Server, and opens no
# ports. It is non-interactive, writes no credential and never logs in: account
# sign-in stays a separate manual step on this machine only.
set -eu
usage() {
  printf '%s\n' 'Usage: provision-remote-runtimes.sh [--only claude|codex] [--prefix NPM_GLOBAL_PREFIX]'
}
fail() { printf 'provision-remote-runtimes: %s\n' "$*" >&2; exit 1; }
only=all
npm_prefix=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      [ "$#" -ge 2 ] || fail 'Missing value for --only'
      case "$2" in
        claude|codex) only=$2;;
        *) fail "Unsupported --only value: $2 (expected claude or codex)";;
      esac
      shift 2;;
    --prefix)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail 'Missing value for --prefix'
      npm_prefix=$2
      shift 2;;
    --help|-h) usage; exit 0;;
    *) fail "Unknown option: $1";;
  esac
done
command -v node >/dev/null 2>&1 || fail 'Node.js is not installed. Install Node.js 22 or newer, then run this script again.'
command -v npm >/dev/null 2>&1 || fail 'npm is not installed. Install npm (it ships with Node.js) and run this script again.'
node_version=$(node -v 2>/dev/null) || fail 'Unable to read the installed Node.js version.'
case "$node_version" in
  v[0-9]*) ;;
  *) fail "Unexpected Node.js version output: $node_version";;
esac
node_major=${node_version#v}
node_major=${node_major%%.*}
case "$node_major" in
  ''|*[!0-9]*) fail "Unable to read the Node.js major version from $node_version";;
esac
[ "$node_major" -ge 22 ] || fail "Node.js $node_version is too old. Install Node.js 22 or newer, then run this script again."
npm_version=$(npm --version 2>/dev/null) || fail 'Unable to run npm; reinstall npm and run this script again.'
printf 'Host toolchain: Node.js %s, npm %s\n' "$node_version" "$npm_version"
if [ -n "$npm_prefix" ]; then
  case "$npm_prefix" in /*) ;; *) fail '--prefix must be an absolute directory.';; esac
  npm_global_prefix=$npm_prefix
else
  npm_global_prefix=$(npm prefix --global 2>/dev/null) || fail 'Unable to read the npm global prefix; pass --prefix explicitly.'
  [ -n "$npm_global_prefix" ] || fail 'npm reported an empty global prefix; pass --prefix explicitly.'
fi
npm_bin_dir=$npm_global_prefix/bin
locate_command() {
  if located=$(command -v "$1" 2>/dev/null); then printf '%s\n' "$located"; return 0; fi
  if [ -x "$npm_bin_dir/$1" ]; then printf '%s\n' "$npm_bin_dir/$1"; return 0; fi
  return 1
}
provision() {
  label=$1
  command_name=$2
  package=$3
  if installed_path=$(locate_command "$command_name"); then
    printf '%s: already installed at %s\n' "$label" "$installed_path"
  else
    printf '%s: installing %s with npm --global into %s\n' "$label" "$package" "$npm_global_prefix"
    npm install --global --prefix "$npm_global_prefix" "$package" || fail "npm failed to install $package"
    installed_path=$(locate_command "$command_name") || fail "$label installed $package but $command_name is not executable in $npm_bin_dir; add it to PATH and run this script again"
    printf '%s: installed at %s\n' "$label" "$installed_path"
  fi
  installed_version=$("$installed_path" --version 2>/dev/null | head -n 1) || installed_version=
  [ -n "$installed_version" ] || installed_version='version unavailable'
  printf '  path:    %s\n  version: %s\n' "$installed_path" "$installed_version"
}
[ "$only" = codex ] || provision 'Claude Code' claude @anthropic-ai/claude-code
[ "$only" = claude ] || provision 'Codex' codex @openai/codex
case ":${PATH:-}:" in
  *":$npm_bin_dir:"*) ;;
  *) printf '\n%s is not in PATH for this shell; add it before launching rovai-server.\n' "$npm_bin_dir";;
esac
printf '\nNext: finish account login yourself, on this server only.\n'
[ "$only" = codex ] || printf '  claude        # start Claude Code once and follow its sign-in prompt\n'
[ "$only" = claude ] || printf '  codex login   # sign in to Codex\n'
printf 'Login credentials stay on this server; rovai-server does not read them from this script and nothing was uploaded.\n'
