#!/usr/bin/env bash
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
events=${1:-4}
port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
run="$repo/e2e/.e2e/verify/$(date +%Y%m%d-%H%M%S)-$port"
mkdir -p "$run/shots" "$run/cli"
cd "$repo/e2e"
nohup node scripts/serve.ts --web-port "$port" --events "$events" >"$run/serve.log" 2>&1 &
echo $! >"$run/pid"
echo "$port" >"$run/web-port"
for _ in $(seq 1 120); do
  if ! kill -0 "$(cat "$run/pid")" 2>/dev/null; then echo "serve.ts が終わった。$run/serve.log を見る" >&2; exit 1; fi
  if [ -f "$repo/e2e/.run/$port.json" ] && curl -fs -o /dev/null "http://127.0.0.1:$port/" \
    && bash "$repo/.agents/skills/verify-live-mindmap/scripts/cli.sh" "$run" status >/dev/null 2>&1; then
    cp "$repo/e2e/.run/${port}.json" "$run/run-info.json"
    node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sessionsDir)' "$run/run-info.json" >"$run/sessions-dir"
    echo "ready: web http://127.0.0.1:$port/  events=$events" >&2
    echo "$run"
    exit 0
  fi
  sleep 0.5
done
echo "60 秒たっても準備できない。$run/serve.log を見る" >&2
exit 1
