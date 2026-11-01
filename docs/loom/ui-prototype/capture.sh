#!/bin/bash
# Regenerates the 1440×920 review frames. Sample prototype only.
set -u
root="$(cd "$(dirname "$0")" && pwd)"
out="$root/screenshots"
mkdir -p "$out"
base="file://${root}/index.html"
chrome="${CHROME:-google-chrome}"

capture() {
  local name="$1"
  local query="$2"
  local dest="$out/${name}.png"
  rm -f "$dest"
  "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1440,920 \
    --screenshot="$dest" "${base}?${query}&shot=1" >/tmp/loom-ui-capture.log 2>&1 &
  local pid=$!
  local i
  for i in $(seq 1 60); do
    if [ -s "$dest" ]; then
      sleep 0.4
      kill "$pid" 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      echo "OK ${name}"
      return 0
    fi
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true
  echo "FAIL ${name}" >&2
  return 1
}

frames=(
  "nodes-ready:screen=nodes&state=ready"
  "nodes-empty:screen=nodes&state=empty"
  "nodes-loading:screen=nodes&state=loading"
  "nodes-error:screen=nodes&state=error"
  "nodes-offline:screen=nodes&state=offline"
  "nodes-pair:screen=nodes&state=pair"
  "nodes-revoke:screen=nodes&state=revoke"
  "hosts-ready:screen=hosts&state=ready"
  "project-ready:screen=project&state=ready"
  "project-empty:screen=project&state=empty"
  "project-loading:screen=project&state=loading"
  "project-error:screen=project&state=error"
  "project-offline:screen=project&state=offline"
  "catalog-ready:screen=catalog&state=ready"
  "catalog-empty:screen=catalog&state=empty"
  "catalog-loading:screen=catalog&state=loading"
  "catalog-error:screen=catalog&state=error"
  "catalog-offline:screen=catalog&state=offline"
  "dispatch-ready:screen=dispatch&state=ready"
  "dispatch-empty:screen=dispatch&state=empty"
  "dispatch-loading:screen=dispatch&state=loading"
  "dispatch-error:screen=dispatch&state=error"
  "dispatch-offline:screen=dispatch&state=offline"
  "live-ready:screen=live&state=ready"
  "live-empty:screen=live&state=empty"
  "live-loading:screen=live&state=loading"
  "live-error:screen=live&state=error"
  "live-offline:screen=live&state=offline"
  "live-claims:screen=live&state=claims"
)

fail=0
for theme in day night; do
  for frame in "${frames[@]}"; do
    name="${frame%%:*}"
    query="${frame#*:}"
    capture "${name}-${theme}" "${query}&theme=${theme}" || fail=1
  done
done

echo "done fail=${fail}"
exit "$fail"
