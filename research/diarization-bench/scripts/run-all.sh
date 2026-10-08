#!/bin/bash
# 全組み合わせを直列で流して採点する。結果は results.jsonl に 1 行ずつ
S=$1; R=$2; B=$R/.build/release/bench; cd $S/out
declare -A MUTE=([screen]=大河内 [facilitators]=森川 [silly]=タカシ [parnassus]=ハル)
for m in screen facilitators silly parnassus; do
  for v in other full; do
    wav=$S/audio/$m.wav; [ $v = other ] && wav=$S/audio/$m-other.wav
    for method in sortformer-fast sortformer-balanced lseend-dihard3-100 lseend-callhome-100 pyannote10; do
      p=$m-$v.$method
      if [ ! -s $p.json ]; then $B $method $wav $p > $p.log 2>&1 || { echo "FAIL $p"; continue; }; fi
      mute=""; [ $v = other ] && mute=${MUTE[$m]}
      echo "{\"meeting\":\"$m\",\"audio\":\"$v\",\"score\":$(uv run -q --with numpy --with scipy python -I $R/scripts/score.py ~/live-mindmap-samples/synth/$m/timeline.tsv $p $mute)}" >> results.jsonl
      echo "done $p"
    done
  done
done
echo ALLDONE
