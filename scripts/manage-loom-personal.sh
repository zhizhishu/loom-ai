#!/bin/sh
set -eu

usage() {
  echo 'usage: Manage-Loom.sh --action install|start|portable|rollback|status [--package-dir DIR] [--install-dir DIR] [--data-dir DIR] [--port PORT] [--runtimes LIST]' >&2
  echo '  --runtimes LIST  comma/semicolon/space separated; accepts codex, pi, dsh, claude or canonical ids (case-insensitive).' >&2
  echo '                   Omit it to keep the saved selection, or to enable all four on a first install.' >&2
  exit 2
}
# An explicit --runtimes (or an interactive answer) naming something that is not
# a known runtime is rejected here, exactly like the Windows manager, instead of
# silently narrowing the installation to whatever tokens happened to parse.
runtimes_unknown() {
  echo "Unknown LOOM runtime: $1. Use codex, pi, dsh or claude." >&2
  exit 2
}
# A selection persisted by an older/failed run must not be silently widened back
# to all four either: report it and let the owner restate the choice.
runtimes_corrupt() {
  echo "LOOM runtime selection in $1 is not usable: $2. Reinstall with --runtimes codex,pi,dsh,claude." >&2
  exit 1
}

# Installation-time runtime selection (light edition). Every packaged runtime
# is always copied; this only decides which ones the launcher advertises to
# LOOM through LOOM_ENABLED_RUNTIMES. Order here is the canonical AdapterKind
# order, so the exported comma list is stable.
runtimes_all='codex-cli,pi,deepseek-harness,claude-code-cli'
runtimes_file_name='.loom-runtimes'
# Accept both short names and canonical AdapterKind ids, case-insensitively
# like the Windows manager; print the canonical id on stdout, or nothing for an
# unknown token.
runtime_canonical() {
  case $(printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz') in
    codex|codex-cli) echo 'codex-cli' ;;
    pi) echo 'pi' ;;
    dsh|deepseek|harness|deepseek-harness) echo 'deepseek-harness' ;;
    claude|claude-code|claude-code-cli) echo 'claude-code-cli' ;;
    *) return 0 ;;
  esac
}
# Split a selection on commas, semicolons and any whitespace, exactly like the
# Windows manager's [,;\s]+ split, collapsing runs so empty tokens never appear.
runtimes_split() {
  printf '%s' "$1" | tr ',;\t\r\n' '      ' | tr -s ' '
}
# Validate a selection in the current shell. Sets runtimes_canonical to the
# canonical AdapterKind-ordered list (empty for an empty selection) and
# runtimes_unknown_tokens to the rejected tokens, returning 1 when any token is
# unknown. It deliberately runs in the caller's shell rather than a $(...)
# subshell so the error message can still name exactly what was rejected.
runtimes_parse() {
  runtimes_canonical=''
  runtimes_unknown_tokens=''
  [ -n "$1" ] || return 0
  chosen=''
  for token in $(runtimes_split "$1"); do
    canonical=$(runtime_canonical "$token")
    if [ -z "$canonical" ]; then
      if [ -z "$runtimes_unknown_tokens" ]; then runtimes_unknown_tokens=$token
      else runtimes_unknown_tokens="$runtimes_unknown_tokens,$token"; fi
      continue
    fi
    case ",$chosen," in *",$canonical,"*) continue ;; esac
    if [ -z "$chosen" ]; then chosen=$canonical; else chosen="$chosen,$canonical"; fi
  done
  if [ -z "$chosen" ]; then
    [ -z "$runtimes_unknown_tokens" ]
    return
  fi
  out=''
  for canonical in codex-cli pi deepseek-harness claude-code-cli; do
    case ",$chosen," in *",$canonical,"*) ;; *) continue ;; esac
    if [ -z "$out" ]; then out=$canonical; else out="$out,$canonical"; fi
  done
  runtimes_canonical=$out
  [ -z "$runtimes_unknown_tokens" ]
}
# Selection validation for something the owner typed or passed explicitly.
# Returns the canonical list, or fails (with a usage error naming the token)
# when a token is unknown; an empty value stays empty so the caller keeps the
# saved selection or the all-four default.
explicit_runtimes() {
  [ -n "$1" ] || return 0
  if ! runtimes_parse "$1"; then runtimes_unknown "$runtimes_unknown_tokens"; fi
  printf '%s' "$runtimes_canonical"
}
# The exported list is never empty: an empty or unusable selection keeps the
# all-runtime default so LOOM can always start.
runtimes_export() {
  runtimes_parse "$1" || :
  if [ -n "$runtimes_canonical" ]; then printf '%s' "$runtimes_canonical";
  else printf '%s' "$runtimes_all"; fi
}
# Read the saved selection from an installation directory. A saved file that
# still holds an unknown token is an installation error rather than a silent
# widening back to all four runtimes.
saved_runtimes() {
  [ -f "$1/$runtimes_file_name" ] || return 0
  stored=''
  stored=$(cat "$1/$runtimes_file_name" 2>/dev/null || :)
  [ -n "$stored" ] || return 0
  if ! runtimes_parse "$stored"; then
    runtimes_corrupt "$1/$runtimes_file_name" "$runtimes_unknown_tokens"
  fi
  printf '%s' "$runtimes_canonical"
}
# First-install prompt. Only a real terminal gets it, so CI and redirected
# stdin fall through to the safe default without ever blocking.
runtimes_prompt() {
  [ -t 0 ] || return 0
  printf '\n' >&2
  printf 'Light edition: choose the runtimes to enable at launch.\n' >&2
  printf '  1. codex (codex-cli)\n  2. pi\n  3. dsh (deepseek-harness)\n  4. claude (claude-code-cli)\n' >&2
  printf "Enter numbers separated by commas, or press Enter to enable all four: " >&2
  answer=''
  read -r answer || answer=''
  [ -n "$answer" ] || return 0
  picked=''
  for token in $(runtimes_split "$answer"); do
    case "$token" in
      1) canonical='codex-cli' ;;
      2) canonical='pi' ;;
      3) canonical='deepseek-harness' ;;
      4) canonical='claude-code-cli' ;;
      *)
        canonical=$(runtime_canonical "$token")
        # The owner typed an explicit answer, so an unknown token is an error
        # here too instead of being dropped from the selection.
        [ -n "$canonical" ] || runtimes_unknown "$token"
        ;;
    esac
    if [ -z "$picked" ]; then picked=$canonical; else picked="$picked,$canonical"; fi
  done
  explicit_runtimes "$picked"
}

action=''
package_dir=''
install_dir=''
data_dir=''
port='64852'
runtimes=''
# Set once --runtimes (or --runtimes=) is seen, even when its value is empty, so
# an explicit request is validated the same way the Windows manager validates
# -Runtimes: an unknown name fails fast, an empty one keeps the saved selection.
runtimes_given=''
# Rejected tokens collected by runtimes_parse, used to name them in errors.
runtimes_unknown_tokens=''
runtimes_canonical=''
while [ $# -gt 0 ]; do
  case "$1" in
    --action) [ $# -ge 2 ] || usage; action=$2; shift 2 ;;
    --package-dir) [ $# -ge 2 ] || usage; package_dir=$2; shift 2 ;;
    --install-dir) [ $# -ge 2 ] || usage; install_dir=$2; shift 2 ;;
    --data-dir) [ $# -ge 2 ] || usage; data_dir=$2; shift 2 ;;
    --port) [ $# -ge 2 ] || usage; port=$2; shift 2 ;;
    --runtimes) [ $# -ge 2 ] || usage; runtimes=$2; runtimes_given=1; shift 2 ;;
    --runtimes=*) runtimes=${1#--runtimes=}; runtimes_given=1; shift ;;
    install|start|portable|rollback|status)
      if [ -z "$action" ]; then action=$1; shift; else usage; fi ;;
    *) usage ;;
  esac
done
[ -n "$action" ] || usage
case "$port" in *[!0-9]*|'') echo 'port must be numeric' >&2; exit 2 ;; esac
# An explicit --runtimes naming an unknown runtime is refused before anything is
# installed or started. An explicitly empty value is "not chosen yet" and keeps
# the saved selection / all-four default.
requested_runtimes=''
if [ -n "$runtimes_given" ]; then requested_runtimes=$(explicit_runtimes "$runtimes"); fi

path_has_newline() {
  case "$1" in *'\n'*|*'\r'*) return 0 ;; *) return 1 ;; esac
}
abs_dir() {
  mkdir -p "$1"
  CDPATH= cd -- "$1" && pwd -P
}
require_file() {
  [ -f "$1" ] || { echo "LOOM package is incomplete: missing $2" >&2; exit 1; }
}
require_exec() {
  [ -x "$1" ] || { echo "LOOM package is incomplete: missing executable $2" >&2; exit 1; }
}
verify_package() {
  root=$1
  require_exec "$root/rovai-server" rovai-server
  require_exec "$root/rovai-host" rovai-host
  require_exec "$root/rovai" rovai
  require_file "$root/web-ui/index.html" web-ui/index.html
  require_file "$root/skills/cli-operations/SKILL.md" skills/cli-operations/SKILL.md
  require_file "$root/package-info" package-info
  require_file "$root/candidate-manifest.json" candidate-manifest.json
  require_file "$root/runtime/pi/pi-bundle.json" runtime/pi/pi-bundle.json
  require_exec "$root/runtime/pi/node/node" runtime/pi/node/node
  require_exec "$root/runtime/pi/pi" runtime/pi/pi
  require_file "$root/runtime/dsh/dsh-runtime-bundle.json" runtime/dsh/dsh-runtime-bundle.json
  require_exec "$root/runtime/dsh/dsh" runtime/dsh/dsh
  require_exec "$root/runtime/dsh/node/node" runtime/dsh/node/node
  require_file "$root/runtime/computer/computer-bundle.json" runtime/computer/computer-bundle.json
  require_exec "$root/runtime/computer/python" runtime/computer/python
  require_file "$root/runtime/computer/host_desktop.py" runtime/computer/host_desktop.py
  require_file "$root/runtime/computer/mcp_bridge.py" runtime/computer/mcp_bridge.py
  grep -q '^target=linux-x64$' "$root/package-info" || { echo 'This package is not a linux-x64 personal package.' >&2; exit 1; }
  grep -q '"target"[[:space:]]*:[[:space:]]*"linux-x64"' "$root/candidate-manifest.json" || { echo 'Candidate manifest target mismatch.' >&2; exit 1; }
}
assert_separate() {
  [ "$1" != "$2" ] || { echo 'Program and personal data directories must be separate.' >&2; exit 1; }
  case "$2" in "$1"/*) echo 'Personal data cannot be inside the program directory.' >&2; exit 1 ;; esac
  case "$1" in "$2"/*) echo 'Program directory cannot be inside personal data.' >&2; exit 1 ;; esac
}
commit_of() {
  sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' "$1/candidate-manifest.json" | head -n 1
}
run_loom() {
  root=$1
  data=$2
  listen_port=$3
  enabled_runtimes=$4
  assert_separate "$root" "$data"
  # Every packaged runtime stays installed; this list only tells LOOM which
  # ones this installation advertises to the Host and the web UI.
  export LOOM_ENABLED_RUNTIMES
  LOOM_ENABLED_RUNTIMES=$(runtimes_export "$enabled_runtimes")
  export ROVAI_EMBEDDED_PI_ROOT="$root/runtime/pi"
  # Only fill the embedded DSH root when the user has not chosen one.
  ROVAI_EMBEDDED_DSH_ROOT=${ROVAI_EMBEDDED_DSH_ROOT:-"$root/runtime/dsh"}
  export ROVAI_EMBEDDED_DSH_ROOT
  export PI_CODING_AGENT_DIR="$data/runtime-home/pi"
  export CODEX_HOME="$data/runtime-home/codex"
  export CLAUDE_CONFIG_DIR="$data/runtime-home/claude"
  export DSH_HOME="$data/runtime-home/dsh"
  computer="$root/runtime/computer"
  export LOOM_COMPUTER_PYTHON="$computer/python"
  export LOOM_COMPUTER_HELPER="$computer/host_desktop.py"
  export LOOM_COMPUTER_AGENT_PYTHON="$computer/python"
  export LOOM_COMPUTER_AGENT_BRIDGE="$computer/mcp_bridge.py"
  export LOOM_COMPUTER_AGENT_PI_MCP='1'
  echo "LOOM: http://127.0.0.1:$listen_port/"
  echo 'Keep this terminal open. Press Ctrl+C to stop.'
  echo "Personal data: $data"
  echo "Enabled runtimes: $LOOM_ENABLED_RUNTIMES"
  exec "$root/rovai-server" --data-dir "$data" --listen "127.0.0.1:$listen_port"
}

if [ -z "$install_dir" ]; then
  base=${XDG_DATA_HOME:-"$HOME/.local/share"}
  install_dir="$base/loom-personal"
fi
for value in "$install_dir" "$package_dir" "$data_dir"; do
  if [ -n "$value" ] && path_has_newline "$value"; then echo 'Paths must not contain newlines.' >&2; exit 2; fi
done

case "$action" in
  portable)
    [ -n "$package_dir" ] || package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
    package_dir=$(abs_dir "$package_dir")
    verify_package "$package_dir"
    if [ -z "$data_dir" ]; then data_dir="$HOME/.local/share/loom-personal-data"; fi
    data_dir=$(abs_dir "$data_dir")
    # Portable has no saved state: an explicit --runtimes wins, everything else
    # resolves to the same four-runtime default used by install.
    run_loom "$package_dir" "$data_dir" "$port" "$(runtimes_export "$requested_runtimes")"
    ;;
  install)
    [ -n "$package_dir" ] || package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
    package_dir=$(abs_dir "$package_dir")
    verify_package "$package_dir"
    install_dir=$(abs_dir "$install_dir")
    commit=$(commit_of "$package_dir")
    case "$commit" in *[!0-9a-f]*|'') echo 'Candidate manifest does not contain a source commit.' >&2; exit 1 ;; esac
    if [ -z "$data_dir" ]; then
      if [ -f "$install_dir/.loom-data-dir" ]; then data_dir=$(cat "$install_dir/.loom-data-dir")
      else data_dir="$HOME/.local/share/loom-personal-data"; fi
    fi
    data_dir=$(abs_dir "$data_dir")
    assert_separate "$install_dir" "$data_dir"
    assert_separate "$install_dir" "$package_dir"
    assert_separate "$package_dir" "$data_dir"
    # Runtime selection: an explicit --runtimes wins (an unknown name already
    # failed fast above), an upgrade keeps what the owner saved, and only a
    # first interactive install asks. A question left unanswered or a redirected
    # stdin keeps the safe four-runtime default so unattended installs can never
    # block. A saved file holding an unknown runtime is an error, not a silent
    # widening back to all four.
    selected_runtimes=$requested_runtimes
    if [ -z "$selected_runtimes" ]; then
      selected_runtimes=$(saved_runtimes "$install_dir")
      if [ -z "$selected_runtimes" ] && [ ! -f "$install_dir/.loom-current" ]; then
        selected_runtimes=$(runtimes_prompt)
      fi
    fi
    selected_runtimes=$(runtimes_export "$selected_runtimes")
    versions="$install_dir/versions"
    mkdir -p "$versions"
    destination="$versions/$commit"
    if [ ! -d "$destination" ]; then
      incoming="$install_dir/.incoming-$commit"
      rm -rf "$incoming"
      mkdir -p "$incoming"
      cp -R "$package_dir"/. "$incoming"/
      verify_package "$incoming"
      mv "$incoming" "$destination"
    fi
    previous=''
    if [ -f "$install_dir/.loom-current" ]; then previous=$(cat "$install_dir/.loom-current"); fi
    cp "$0" "$install_dir/Manage-Loom.sh"
    chmod 755 "$install_dir/Manage-Loom.sh"
    cat > "$install_dir/Start-Loom.sh" <<'EOF'
#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$root/Manage-Loom.sh" --action start --install-dir "$root"
EOF
    chmod 755 "$install_dir/Start-Loom.sh"
    printf '%s\n' "$commit" > "$install_dir/.loom-current"
    printf '%s\n' "$previous" > "$install_dir/.loom-previous"
    printf '%s\n' "$data_dir" > "$install_dir/.loom-data-dir"
    printf '%s\n' "$port" > "$install_dir/.loom-port"
    printf '%s\n' "$selected_runtimes" > "$install_dir/$runtimes_file_name"
    echo "LOOM installed. Open: $install_dir/Start-Loom.sh"
    echo "Personal data: $data_dir"
    echo "Enabled runtimes: $selected_runtimes"
    ;;
  start)
    install_dir=$(abs_dir "$install_dir")
    [ -f "$install_dir/.loom-current" ] || { echo 'LOOM installation did not finish. Run Install-Loom.sh again.' >&2; exit 1; }
    current=$(cat "$install_dir/.loom-current")
    data_dir=$(cat "$install_dir/.loom-data-dir")
    port=$(cat "$install_dir/.loom-port")
    release="$install_dir/versions/$current"
    verify_package "$release"
    # An explicit --runtimes on start replaces the saved choice; otherwise the
    # selection recorded at install time is reused. Both are validated, so a
    # typo or a damaged saved file fails fast instead of starting LOOM with a
    # different runtime set than the owner asked for.
    start_runtimes=$requested_runtimes
    if [ -n "$start_runtimes" ]; then
      printf '%s\n' "$start_runtimes" > "$install_dir/$runtimes_file_name"
    else
      start_runtimes=$(saved_runtimes "$install_dir")
    fi
    run_loom "$release" "$data_dir" "$port" "$(runtimes_export "$start_runtimes")"
    ;;
  status)
    install_dir=$(abs_dir "$install_dir")
    [ -f "$install_dir/.loom-current" ] || { echo 'LOOM is not installed in this folder.' >&2; exit 1; }
    # Validate the saved list in this shell (not in a $(...) subshell) so a
    # damaged selection fails the command instead of printing the widened
    # all-four default next to an error nobody notices.
    status_runtimes=$(saved_runtimes "$install_dir")
    status_runtimes=$(runtimes_export "$status_runtimes")
    printf 'current=%s\nprevious=%s\ndataDirectory=%s\nport=%s\nruntimes=%s\n' \
      "$(cat "$install_dir/.loom-current")" "$(cat "$install_dir/.loom-previous" 2>/dev/null || true)" \
      "$(cat "$install_dir/.loom-data-dir")" "$(cat "$install_dir/.loom-port")" \
      "$status_runtimes"
    ;;
  rollback)
    install_dir=$(abs_dir "$install_dir")
    [ -f "$install_dir/.loom-current" ] && [ -f "$install_dir/.loom-previous" ] || { echo 'There is no previous version to switch to.' >&2; exit 1; }
    current=$(cat "$install_dir/.loom-current")
    previous=$(cat "$install_dir/.loom-previous")
    [ -n "$previous" ] && [ -d "$install_dir/versions/$previous" ] || { echo 'There is no previous version to switch to.' >&2; exit 1; }
    verify_package "$install_dir/versions/$previous"
    printf '%s\n' "$previous" > "$install_dir/.loom-current"
    printf '%s\n' "$current" > "$install_dir/.loom-previous"
    echo 'Previous program version selected. Personal data was kept. Open Start-Loom.sh to continue.'
    ;;
esac
