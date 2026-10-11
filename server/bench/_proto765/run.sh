#!/bin/bash
# PROTOTYPE（#765）— 3 案を同時に 1 回ずつ等速で流す。bash run.sh <screen|facilitators> <回> <入出力の dir>
set -u
cd "$(dirname "$0")"
m=$1; n=$2; S=$3
truth=~/live-mindmap-samples/synth/$m/truth.json
for mode in sonnet jev kw; do
  env -u ANTHROPIC_API_KEY op run --env-file=.env.op -- node m765.ts $mode $S/in/$m.items.json $S/in/$m.lines.json $S/out/$m.$mode.$n.json $truth > $S/out/$m.$mode.$n.log 2>&1 &
done
wait
