# #761 いまの反映の遅れの内訳（計測の道具）

使い捨てのブランチ。結果は issue #761 のコメントが正本。

- `_m761.ts`: `server/bench/` に置いて動かす。`sttReplay` と同じ流し方で、差分更新の呼び出しの始まり・終わり・渡した発言を記録する。`node bench/_m761.ts <items.json> <lines.json> <out.json> [truth.json]`
- `analyze.mjs <out.json>`: 行ごとに 話し終わり → 発言 → 呼び出し開始 → 応答 → ノード の p50/p90
- `tail.mjs <items.json> <lines.json>`: 発言になるまでの遅れを、発言の最後の行と途中の行に分ける

手順: `afconvert -f WAVE -d LEI16@16000 -c 1 meeting.m4a x.wav` → `stt-bench run --variant baseline x.wav > x.jsonl` → `sttLatency.ts x.jsonl --quiet 1 --emit discard > items.json`。`lines.json` は `timeline.tsv` の start/end。
