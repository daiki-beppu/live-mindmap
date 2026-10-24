#!/usr/bin/env bash
# 差分更新の呼び出しの段取りのモデル（DiffUpdateScheduler.tla）を、TLC で性質ごとに調べる。
# 使い方: bash server/formal/check.sh [性質の名前 ...]（省略するとすべて）。--spec <file.tla> で別のモデル（壊した版）を調べる
# 終了コード: 既知の発見（known）のほかに破れた性質が無ければ 0、新しく破れた性質があれば 1、TLC が調べ切れなければ 2
# TLC（tla2tools.jar）は版を固定して server/formal/.tla/ に一度だけ取る。Java 11 以上が要る
set -euo pipefail

FORMAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JAR="$FORMAL_DIR/.tla/tla2tools-$TLA_VERSION.jar"

spec="$FORMAL_DIR/DiffUpdateScheduler.tla"
names=()
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) spec="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    *) names+=("$1"); shift ;;
  esac
done

if [ ! -f "$JAR" ]; then
  mkdir -p "$FORMAL_DIR/.tla"
  curl -fsSL -o "$JAR.part" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  echo "$TLA_SHA256  $JAR.part" | shasum -a 256 -c --quiet
  mv "$JAR.part" "$JAR"
fi

# 性質と、それを調べる構成（cloud: 一時停止と再試行、apple: 子プロセスの再起動と停止）
checks=(
  "InvOneCallAtATime cloud apple"
  "InvNoStaleInFlight cloud apple"
  "InvRemarksConserved cloud apple"
  "InvQuietAfterFlush cloud apple"
  "PropStoppedStays apple"
  "PropFlushReturns cloud apple"
)

# 既知の発見（.agents/skills/verify-diff-update-scheduler/SKILL.md の「既知の発見」）。破れても KNOWN と出し、終了コードを 1 にしない。
# 通るようになったら PASS? と出すので、ここから外して、スキルの節も消す
known=(InvQuietAfterFlush)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
module="$(basename "$spec" .tla)"
cp "$spec" "$work/$module.tla"

status=0
for entry in "${checks[@]}"; do
  read -r name kinds <<<"$entry"
  if [ ${#names[@]} -gt 0 ] && [[ ! " ${names[*]} " =~ " $name " ]]; then continue; fi
  for kind in $kinds; do
    { sed -n '/^CONSTANTS/,/^  CatchUp/p' "$FORMAL_DIR/$kind.cfg"
      echo "SPECIFICATION Spec"
      echo "CHECK_DEADLOCK FALSE"
      echo "INVARIANT TypeOK"
      case "$name" in
        Inv*) echo "INVARIANT $name" ;;
        Prop*) echo "PROPERTY $name" ;;
      esac
    } >"$work/$name-$kind.cfg"
    out="$work/$name-$kind.out"
    set +e
    (cd "$work" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers auto -metadir "$work/states-$name-$kind" -config "$name-$kind.cfg" "$module.tla") >"$out" 2>&1
    set -e
    is_known=false
    [[ " ${known[*]} " =~ " $name " ]] && is_known=true
    if grep -q "No error has been found" "$out"; then
      if $is_known; then label="PASS?"; else label="pass "; fi
      echo "$label $name ($kind) $(grep -o '[0-9]* distinct states found' "$out" | tail -1)"
    elif grep -qE "is violated|Temporal properties were violated" "$out"; then
      mkdir -p "$FORMAL_DIR/.tla/traces"
      trace="$FORMAL_DIR/.tla/traces/$name-$kind.txt"
      sed -n '/^Error:/,/states generated/p' "$out" >"$trace"
      if $is_known; then
        echo "KNOWN $name ($kind) 反例の全文: $trace"
      else
        echo "FAIL  $name ($kind) 反例の全文: $trace"
        status=1
      fi
      # 反例の手順（遷移の名前）だけを並べる
      grep -oE '^State [0-9]+: <[A-Za-z]+' "$trace" | sed -E 's/^State ([0-9]+): <(.*)/      \1. \2/'

    else
      echo "ERROR $name ($kind)"
      sed 's/^/      /' "$out" | tail -20
      status=2
    fi
  done
done
exit "$status"
