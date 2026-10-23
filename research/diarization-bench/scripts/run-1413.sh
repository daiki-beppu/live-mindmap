cd /private/tmp/claude-501/-Users-mba-ghq-github-com-daiki-beppu-live-mindmap/25bc8a46-f7a8-433a-8de3-157882c8bf7b/scratchpad/nemo/out
B=/Users/mba/orca/workspaces/live-mindmap/nemotron3-diar/research/diarization-bench/.build/release/bench
for m in overlap-1:高嶺 screen:大河内 facilitators:森川 silly:タカシ parnassus:ハル real1016:; do
  name=${m%%:*}; mute=${m#*:}
  for method in nemotron3-low sortformer-fast nemotron3-fast nemotron3-fast32; do
    p=$name.$method
    if [ ! -s $p.json ]; then $B $method /private/tmp/claude-501/-Users-mba-ghq-github-com-daiki-beppu-live-mindmap/25bc8a46-f7a8-433a-8de3-157882c8bf7b/scratchpad/nemo/audio/$name-other.wav $p > $p.log 2>&1 || { echo "$(date +%T) FAIL $p"; continue; }; fi
    if [ $name != real1016 ]; then
      echo "{\"meeting\":\"$name\",\"score\":$(uv run -q --with numpy --with scipy python -I /Users/mba/orca/workspaces/live-mindmap/nemotron3-diar/research/diarization-bench/scripts/score.py ~/live-mindmap-samples/synth/$name/timeline.tsv $p $mute)}" >> results.jsonl
    fi
    echo "$(date +%T) done $p"
  done
done
echo ALLDONE
