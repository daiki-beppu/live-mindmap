#!/usr/bin/env bash
# 確かめ用の server・web を 1 組立てる（e2e/scripts/serve.ts）。helper は fake-helper、差分更新は偽の updater。
# ポートは空きポート、セッションのフォルダは一時フォルダ。開発中の server（4319）や ~/.live-mindmap には触れない。
# 使い方: bash .agents/skills/verify-live-mindmap/scripts/launch.sh [台本の先頭から流す発言の件数（既定 4）]
# 標準出力の最後の行が run のフォルダ（証拠の置き場）。以降の doctor.sh・cli.sh・stop.sh にそのまま渡す。
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
# 準備できた = run-info があり、web が 200 を返し、server が CLI の status に答える
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
