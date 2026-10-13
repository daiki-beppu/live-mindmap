#!/bin/bash
# PROTOTYPE（#880）— 候補を交互に流す（途中で止めても回数がそろう）。サブスクの枠で流す
set -u
D=~/live-mindmap-samples/runs/variance-878
O=~/live-mindmap-samples/runs/call-policy-880
mkdir -p $O
cd "$(dirname "$0")/../.."
for i in ${ROUNDS:-1 2 3}; do
  for c in b c a; do
    case $c in
      a) env=(P880_BATCH=1 P880_QUIET_MS=1500 P880_SHORT=0) ;;
      b) env=(P880_BATCH=1 P880_QUIET_MS=3000 P880_SHORT=8) ;;
      c) env=(P880_BATCH=2 P880_QUIET_MS=3000 P880_SHORT=0) ;;
    esac
    out=$O/$c.$i.out.json
    [ -f $out ] && continue
    echo "$(date +%T) start $c.$i"
    env -u ANTHROPIC_API_KEY "${env[@]}" node bench/_proto880/m761.ts $D/punct50.items.json $D/screen.lines.json $out ~/live-mindmap-samples/synth/screen/truth.json > $O/$c.$i.log 2>&1 || echo "failed $c.$i"
  done
done
node bench/_proto880/analyze.mjs $D/punct50.*.out.json $O/*.out.json
