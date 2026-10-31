#!/bin/bash
# CI の混み合いを手元で再現して helper の IT を流す（#1681）。使い方: bash helper/scripts/stress-it.sh [回数]。先に swift build --build-tests が要る
set -euo pipefail
runs="${1:-3}"
jobs="${STRESS_JOBS:-$(( $(sysctl -n hw.ncpu) * 8 / 5 ))}"
cd "$(dirname "$0")/.."
pids=()
trap 'kill ${pids[@]+"${pids[@]}"} 2>/dev/null || true' EXIT
for _ in $(seq "$jobs"); do yes > /dev/null & pids+=($!); done
failed=0
for n in $(seq "$runs"); do
  log="${TMPDIR:-/tmp}/stress-it-$n.log"
  swift test --skip-build --filter 'ITTests/' > "$log" 2>&1 || failed=1
  echo "run $n: $(grep -E 'Test run with [0-9]+ tests? in [0-9]+ suites?' "$log" | tail -1 || true)"
  grep -oE 'recorded an issue.* at [A-Za-z0-9_]+\.swift:[0-9]+:[0-9]+: .*' "$log" | sed -E 's/.* at ([A-Za-z0-9_]+\.swift:[0-9]+):[0-9]+: /\1: /' | sort | uniq -c || true
done
exit "$failed"
