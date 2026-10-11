# #764 の試作（使い捨て）

「途中結果から『いまどのノードの話か』を判定し、仮に光らせる」の試作。結論は issue #764 のコメントが正本。

- `measure.mjs`: 途中結果（#763 の試作が残した screen の JSONL）を時刻どおりに Jev に渡し、「いま話している途中の文字列は、現在のマップのどのノードの話か」を聞く。正解はその発言で Claude が触ったノード（追加なら親）。`TOPICS=1` で選択肢を議題・論点だけにする。`op run --env-file=.env.op --` で鍵を渡す
- `analyze.mjs`: ノード単位の当たり・近い・違う・光らない、発言になる直前の答え、反映より先に光った秒
- `topic.mjs`: 答えを議題（または論点）に読み替えたときの当たり
- `ahead.mjs`: Jev の議題が、Claude の反映で決まる「今の議題」と違う場面だけを数える
- `build-ui.mjs`: 見返し画面の試作のデータ（実測の反映時刻・途中結果・議題単位の答え）を `web/proto764/` に作る。画面は `web/src/_proto764.tsx`。`pnpm --filter @live-mindmap/web dev` で `/?proto764&variant=outline|dim|caption|dot|off`
