#!/usr/bin/env bash
# この run が立てたものだけを止める。止める前にセッションのフォルダ（一時）を <run>/sessions/ へ写す（serve.ts は終わるときに一時フォルダを消す）。
# 証拠（<run>/ の下）は消さない。
# 使い方: bash .agents/skills/verify-live-mindmap/scripts/stop.sh <run のフォルダ>
set -uo pipefail
run=$1
port=$(cat "$run/web-port"); pid=$(cat "$run/pid"); sessions=$(cat "$run/sessions-dir" 2>/dev/null)
if [ -n "${sessions}" ] && [ -d "${sessions}" ] && [ ! -e "$run/sessions" ]; then cp -R "${sessions}" "$run/sessions"; fi
playwright-cli -s="verify-${port}" close >/dev/null 2>&1 || true
if kill -0 "${pid}" 2>/dev/null; then
  kill -TERM "${pid}"
  for _ in $(seq 1 40); do kill -0 "${pid}" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "${pid}" 2>/dev/null; then echo "PID ${pid} が 10 秒で終わらない。kill -KILL ${pid} で止める" >&2; exit 1; fi
fi
if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then echo "ポート ${port} がまだ使われている" >&2; exit 1; fi
echo "stopped. 証拠: $run" >&2
