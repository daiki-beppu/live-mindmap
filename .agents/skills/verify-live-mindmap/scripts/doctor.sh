#!/usr/bin/env bash
# 読み取りだけの確認: この run の server・web は動かす価値があるか。何も変えない。
# 使い方: bash .agents/skills/verify-live-mindmap/scripts/doctor.sh <run のフォルダ>
set -uo pipefail
run=$1
repo=$(git rev-parse --show-toplevel)
ok=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "NG   $1"; ok=1; fi; }
pid=$(cat "$run/pid" 2>/dev/null); port=$(cat "$run/web-port" 2>/dev/null)
info="$repo/e2e/.run/$port.json"
check "serve.ts（PID ${pid}）が動いている" "kill -0 $pid"
check "run-info $info がある" "test -f $info"
check "web のポート $port を、この PID が持っている" "lsof -nP -a -p $pid -iTCP:$port -sTCP:LISTEN"
check "web が 200 を返す" "curl -fs -o /dev/null http://127.0.0.1:$port/"
check "server が CLI の status に答える" "LIVE_MINDMAP_PORT=\$(node -e 'console.log(require(\"$info\").port)') node $repo/server/src/cli.ts status"
check "serve.ts がこの worktree（HEAD $(git -C "$repo" rev-parse --short HEAD)）の e2e/ から立っている" "test \"\$(lsof -nP -a -p $pid -d cwd -Fn | sed -n 's/^n//p')\" = $repo/e2e"
check "playwright-cli がある" "command -v playwright-cli"
exit $ok
