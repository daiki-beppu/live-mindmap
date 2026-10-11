# #763 の試作（使い捨て）

「発言にする区切りを判定で早め、差分更新を早く呼ぶ」の試作。結論は issue #763 のコメントが正本。

- `sim.mjs`: 途中結果（`stt-bench run` の JSONL）から発言を切る規則を差し替え、話し終わり → 発言の遅れ・発言の数・出した後の書き換えを出す。規則は `quiet`（いま）・`punct`（文の終わり）・`speaker`（正解の話者交代、#610 の後の見積もり）・`speaker+punct`・`speaker+jev`。本番の関所（`remarkGate`）を通す。Jev は `op run --env-file=.env.op --` で鍵を渡す。`--emit <規則> <out.json>` で `m761.ts` に渡す発言を書く
- `m761.ts`: #761 の計測の道具（research/761-latency-breakdown）を、いまの main（ManagedDeps）で動くように直したもの。`node m761.ts <items.json> <lines.json> <out.json> <truth.json>`。先に `pnpm --filter @live-mindmap/server deps:install claude`
- `analyze.mjs <out.json>...`: 行の話し終わり（end − 0.3 秒）から、発言・ノードまでの p50/p90、呼び出し、費用（Sonnet 5.5 の定価）、再現率
- 入力は #761 の計測で作った screen / facilitators の JSONL（素材は ~/live-mindmap-samples/synth）
