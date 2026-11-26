#!/bin/sh
set -eu

usage() {
  echo 'usage: Manage-Loom.sh --action install|start|portable|rollback|status [--package-dir DIR] [--install-dir DIR] [--data-dir DIR] [--port PORT]' >&2
  exit 2
}

action=''
package_dir=''
install_dir=''
data_dir=''
port='64852'
while [ $# -gt 0 ]; do
  case "$1" in
    --action) action=$2; shift 2 ;;
    --package-dir) package_dir=$2; shift 2 ;;
    --install-dir) install_dir=$2; shift 2 ;;
    --data-dir) data_dir=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    install|start|portable|rollback|status)
      if [ -z "$action" ]; then action=$1; shift; else usage; fi ;;
    *) usage ;;
  esac
done
[ -n "$action" ] || usage
case "$port" in *[!0-9]*|'') echo 'port must be numeric' >&2; exit 2 ;; esac

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
  require_file "$root/runtime/dsh-hook-executor/executor-bundle.json" runtime/dsh-hook-executor/executor-bundle.json
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
  assert_separate "$root" "$data"
  export ROVAI_EMBEDDED_PI_ROOT="$root/runtime/pi"
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
    run_loom "$package_dir" "$data_dir" "$port"
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
    echo "LOOM installed. Open: $install_dir/Start-Loom.sh"
    echo "Personal data: $data_dir"
    ;;
  start)
    install_dir=$(abs_dir "$install_dir")
    [ -f "$install_dir/.loom-current" ] || { echo 'LOOM installation did not finish. Run Install-Loom.sh again.' >&2; exit 1; }
    current=$(cat "$install_dir/.loom-current")
    data_dir=$(cat "$install_dir/.loom-data-dir")
    port=$(cat "$install_dir/.loom-port")
    release="$install_dir/versions/$current"
    verify_package "$release"
    run_loom "$release" "$data_dir" "$port"
    ;;
  status)
    install_dir=$(abs_dir "$install_dir")
    [ -f "$install_dir/.loom-current" ] || { echo 'LOOM is not installed in this folder.' >&2; exit 1; }
    printf 'current=%s\nprevious=%s\ndataDirectory=%s\nport=%s\n' \
      "$(cat "$install_dir/.loom-current")" "$(cat "$install_dir/.loom-previous" 2>/dev/null || true)" \
      "$(cat "$install_dir/.loom-data-dir")" "$(cat "$install_dir/.loom-port")"
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
