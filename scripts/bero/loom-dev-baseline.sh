#!/bin/bash
# LOOM P-1 baseline inside loom-dev. Log: /root/sandbox/projects/loom-dev/logs/baseline.log ; summary: logs/baseline.summary
B=/root/sandbox/projects/loom-dev
exec >>$B/logs/baseline.log 2>&1
echo "=== baseline start $(date -Is)"
cd $B/src
git bundle verify $B/bundles/loom-inc-b5c5d67.bundle && git fetch -q $B/bundles/loom-inc-b5c5d67.bundle HEAD:refs/heads/hark-b5c5d67 && git checkout -q rovai/loom-v2-personal-20261116 && git merge -q --ff-only hark-b5c5d67
echo "HEAD $(git rev-parse HEAD)"
S=$B/logs/baseline.summary; : > $S
step(){ name=$1; shift; t0=$(date +%s); docker exec loom-dev bash -lc "cd /src && $*" > $B/logs/step-$name.log 2>&1; rc=$?; echo "$name rc=$rc secs=$(( $(date +%s)-t0 ))" | tee -a $S; }
echo "commit $(git rev-parse --short HEAD) $(date -Is)" >> $S
step pnpm-install "pnpm install --frozen-lockfile"
step cargo-check "cargo check --workspace --all-targets -j 4"
step cargo-check-warm "cargo check --workspace --all-targets -j 4"
step docs-decisions "node scripts/check-doc-decisions.mjs"
step rust-core-lib "cargo test -p rovai-core --lib -j 4"
step cospan-doctor "node /opt/cospan/bin/cospan.mjs doctor --check"
echo "=== baseline done $(date -Is)" | tee -a $S
