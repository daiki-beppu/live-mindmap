# #881 の試作（使い捨て）

「最終候補を長い合成会議と実会議で確かめる」の計測の道具。結論は issue #881 のコメントが正本。

- `run.sh`: facilitators で、いま（1 秒の区切り・B2 Q1.5）と最終候補（文の終わり 50 ミリ秒＋引き継ぎ・B1）を流す。`CANDS=cand ROUND=2` で候補だけを 2 回目として流す。`_proto880/m761.ts` と `session.ts` の `P880_*` を使う
- `callsim.mjs <items> <lines> <batch> <quiet秒>`: `_proto880/callsim.mjs` の simulate を任意の素材で回す（Claude なし）
- `vadTimeline.mjs <audio> <tsv> <lines.json>`: 台本の無い実会議で、無音区間（ffmpeg silencedetect）の始まりを話し終わりとみなす。screen で台本の正解と比べ、話し終わり → 発言・→ ノードとも 0.5 秒以内で合った
- `finalsTimeline.mjs`: 確定結果の end を話し終わりとみなす版。いまの規則の遅れが見えなくなる（screen で p50 3.1 → 0.6 秒）ので使わない
- `missDiag.mjs <truth> <export.json>...`: 合成会議の正解ごとに、当たり・種別違い・時刻外を数える
- 発言は `_proto763/sim.mjs --emit quiet`（いま）と `_proto879/sim.mjs --emit 50`（候補）で作る。入力と出力は `~/live-mindmap-samples/runs/final-881/`
