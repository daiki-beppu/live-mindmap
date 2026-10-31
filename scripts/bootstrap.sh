#!/usr/bin/env bash
set -euo pipefail

run_stage() {
  local name="$1"
  shift
  "$@" 2>&1 | while IFS= read -r line || [ -n "$line" ]; do
    printf '[%s] %s\n' "$name" "$line"
  done
}

names=(install aec3 resolve)
pids=()
run_stage install bash scripts/setup-deps.sh &
pids+=("$!")
run_stage aec3 bash helper/scripts/build-webrtc-apm.sh &
pids+=("$!")
run_stage resolve swift package resolve --package-path helper &
pids+=("$!")

failed=()
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    failed+=("${names[$i]}")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'Bootstrap failed: %s\n' "${failed[*]}" >&2
  exit 1
fi

printf 'Bootstrap complete. Next: pnpm dev\n'
