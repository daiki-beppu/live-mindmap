#!/usr/bin/env bash
set -uo pipefail
run=$1; shift
repo=$(git rev-parse --show-toplevel)
info="$repo/e2e/.run/$(cat "$run/web-port").json"
read -r port sessions < <(node -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(i.port,i.sessionsDir)' "$info")
n=$(printf '%02d' "$(ls "$run/cli" | grep -c '\.code$')")
base="$run/cli/$n-${1:-help}"
LIVE_MINDMAP_CONFIG="$sessions/absent.config.json" LIVE_MINDMAP_MODEL="" LIVE_MINDMAP_PORT="$port" LIVE_MINDMAP_SESSIONS="$sessions" \
  node "$repo/server/src/cli.ts" "$@" > >(tee "$base.out") 2> >(tee "$base.err" >&2)
code=$?
echo "$code" >"$base.code"
exit "$code"
