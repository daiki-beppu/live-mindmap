#!/bin/bash
# PROTOTYPE（#881）— facilitators で、いま（いまの区切り・いまの呼び方）と最終候補（文の終わり 50ms＋引き継ぎ・B1）を 1 回ずつ流す。サブスクの枠で流す
set -u
W=~/live-mindmap-samples/runs/final-881
T=~/live-mindmap-samples/synth/facilitators/truth.json
cd "$(dirname "$0")/../.."
for c in ${CANDS:-cand base}; do
  case $c in
    cand) env=(P880_BATCH=1 P880_QUIET_MS=1500 P880_SHORT=0); items=$W/fac.punct50.items.json ;;
    base) env=(P880_BATCH=2 P880_QUIET_MS=1500 P880_SHORT=0); items=$W/fac.quiet.items.json ;;
  esac
  out=$W/fac.$c.${ROUND:-1}.out.json
  [ -f $out ] && continue
  echo "$(date +%T) start $c"
  env -u ANTHROPIC_API_KEY "${env[@]}" node bench/_proto880/m761.ts $items $W/fac.lines.json $out $T > $W/fac.$c.${ROUND:-1}.log 2>&1 || echo "$(date +%T) failed $c"
  echo "$(date +%T) end $c"
done
