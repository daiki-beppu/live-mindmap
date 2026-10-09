#!/bin/zsh
# 使い捨て（issue #614）。使い方: run.sh <名前> <素材 screen|facilitators> <model> <effort>
set -e
R=~/live-mindmap-samples/runs/haiku-eval
name=$1; sample=$2; model=$3; effort=$4; shift 4
S=~/live-mindmap-samples/synth/$sample
mkdir -p $R/sessions/$name
args=($S/meeting.transcript.json)
[ -f $S/slides.tsv ] && args+=(--screen $S/slides.tsv)
cd ~/orca/workspaces/live-mindmap/wayfinder-haiku-eval/server
start=$(date +%s)
env -u ANTHROPIC_API_KEY LM_EVAL_MODEL=$model LM_EVAL_EFFORT=$effort LM_EVAL_METRICS=$R/$name.metrics.jsonl LIVE_MINDMAP_SESSIONS=$R/sessions/$name LIVE_MINDMAP_PORT=0 node src/cli.ts play "$@" $args > $R/$name.out 2>&1
echo "wall $(( $(date +%s) - start ))s" >> $R/$name.out
