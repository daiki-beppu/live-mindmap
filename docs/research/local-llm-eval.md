# ローカルの候補モデルを 16GB の M4 で回帰評価にかけた結果（issue #380）

2026-10-08 に計測。発言の本文は載せず、数字と置き場所だけを書く。

## 条件

- 機械: Apple M4・16GB・macOS 27。Orca・Chrome・複数の Claude Code のセッションを動かしたままの普段の状態。計測中のメモリの空きは 12〜29%、スワップは 4〜10GB 使われていた
- 素材: `~/live-mindmap-samples/synth/screen/`（23 分・78 発言・スライド 8 枚・正解は決定 5・TODO 7）を全候補で。Claude だけ `synth/facilitators/`（55 分）も流した
- 流し方: `play`（待ち時間なし。1 発言ごとに差分更新の終わりを待つ）→ `eval`。待ち時間なしなので、呼び出しは 2 発言ごとに 1 回で、詰まらない。等速で流したときの遅れは、呼び出しの時間を元の会議の時刻に当てて計算した（`server/bench/callTimes.py`）
- 仮の接続: `server/src/openaiCompat.ts`（OpenAI 互換の chat completions。SYSTEM と `buildPrompt` は Claude と同じものを使い、messages を足していく。`response_format: json_schema` で今の `DiffOutput` のスキーマを渡す。失敗したら会話を捨てる）。環境変数 `LOCAL_LLM_URL` を置くと `play` がこちらを使う
- ローカルの実行環境
  - 内蔵の代わり: llama.cpp の `llama-server` b11490（node-llama-cpp と同じ llama.cpp。`--offline -c 32768 -np 1 -ngl 99 --reasoning off`、画像は `--mmproj`）
  - Apple Intelligence: `server/bench/afm/main.swift`（Foundation Models の `LanguageModelSession`。スキーマは Apple の方言に写して `GenerationSchema` に decode）を `server/bench/afmServer.ts` が localhost の互換の口で包む。**画像は捨てて文字だけを渡した**
- モデル: Qwen3.5-9B Q4_K_M（unsloth、5.7GB）、Gemma 4 12B QAT q4_0（google、7.0GB）、Qwen3.5-4B Q4_K_M（unsloth、2.7GB）

## 結果（screen の 23 分）

| ラン | 決定 | TODO | ノード | 話し中の兄弟の最多 | 適用できた操作 | 1 回の時間 中央 / p90 / 最大 | 生成 | 等速での遅れ（最後） | 失敗 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Sonnet 5.5 | 4/5 | 5/7 | 129 | 7 | — | 5.8 / 9.4 / 13.5 秒 | — | 2 秒 | 0/39 |
| Apple Intelligence（開き直し 3 回） | 0/5 | 0/7 | 6 | 5 | ほぼ 0（存在しない `root` への update が大半） | 14.2 / 22.4 / 26.3 秒 | — | 21 秒 | 1/39（文脈長 8192 超え） |
| Qwen3.5-9B | 0/5 | 0/7 | 0 | 0 | 0/144 | 61.3 / 122.5 / 255.8 秒 | 6.2 tok/s | 1529 秒 | 1/39 |
| Gemma 4 12B（最初の 6 回で止めた） | — | — | 0 | — | 0/20 | 96.1 / 104.6 / 131.3 秒 | 5.4 tok/s | — | 0/6 |
| Qwen3.5-9B＋仮 id の 1 行（最初の 8 回） | — | — | — | — | 14/41 | 80.0 / 119.4 / 119.4 秒 | 7.0 tok/s | — | 0/8 |
| **Qwen3.5-4B＋仮 id の 1 行** | **1/5** | **2/7** | 112 | **26** | 132/140 | 37.5 / 66.6 / 300（打ち切り） | 11.9 tok/s | 567 秒 | 1/39（300 秒で打ち切り） |

Claude の facilitators（55 分）: 決定 2/4・TODO 3/5、86 回、1 回 中央 6.8 秒・p90 11.7 秒、等速の遅れは最後 2 秒。過去の 2 回（3/4・4/5 と 2/4・3/5、`docs/knowledge/2026-10-05.md`）と同じ幅に入る。

「仮 id の 1 行」は SYSTEM の末尾に足した次の文（環境変数 `LOCAL_LLM_SYSTEM_SUFFIX`）:

> add の ref には a1, a2 … のような、この応答で新しく付ける仮 id を書く。root や既存ノードの id（n1 など）を ref にしない。最初の議題は parent に root を書いて add する。

## 分かったこと

1. **今のプロンプトのままでは、ローカルの 3 候補はどれもマップを作れない。** スキーマ違反は無く（`json_schema` の制約はどれも効いた）、崩れ方は id の扱い。Qwen3.5-9B と Gemma 4 12B は、最初の add の仮 id（`ref`）に `root` を書いて弾かれ、議題ができないので以後の add がすべて「親が存在しない」で捨てられる。マップが空のまま変わらないので、立て直せない。Apple Intelligence は存在しない `root` への update を繰り返した
2. **1 行の指示で崩れ方は変わるが、9B でも直り切らない。** Qwen3.5-9B は仮 id に発言の id（`r2`）を使ったり同じ仮 id を何度も付けたりして、41 操作のうち 14 しか当たらなかった。4B は同じ指示で 140 操作中 132 が当たった。ローカルのモデルには、プロンプト（または出力の形）をモデルに合わせて作り直す必要がある
3. **品質は Claude に遠く及ばない。** 唯一マップになった Qwen3.5-4B でも決定 1/5・TODO 2/7（Claude は 4/5・5/7）。要点が 91（Claude は 70）に膨らみ、話し中の兄弟が最多 26 になった（目安は 5）。兄弟の上限の指示がほとんど効いていない
4. **速さ: 16GB の普段使いの Mac では、9B 以上は会議に追いつけない。** メモリに余裕がある最初の数回は Qwen3.5-9B で読み込み 139 tok/s・生成 15.6 tok/s（調査の見込みどおり）だったが、ほかのアプリとメモリを取り合うと 46〜57 tok/s・6〜8 tok/s に落ちた。出力は 1 回 250〜450 トークンと長く、生成だけで 30 秒を超える。この会議の 2 発言の間隔は中央 35 秒で、9B（中央 61 秒）・12B（96 秒）は遅れが溜まり続ける。4B（37.5 秒）でも等速では会議の終わりに 9 分半遅れた
5. **開き直した直後の呼び出しが特に遅い。** Qwen3.5-9B で全体を送り直した 15 回目は 240 秒（3.3k トークンを 32 tok/s）。プレフィックスキャッシュは効いていて（`cache_n` が前回までに当たる）、2 回目以降は新しい 500〜1,800 トークンだけを読む
6. **Apple Intelligence は速いが、文脈長 8192 が会話の形に合わない。** 最初の呼び出しが約 4,000 トークン（SYSTEM とスキーマとマップ）で、1 往復ごとに約 1.4k トークン増える。開き直す回数 14 のままだと 4 回目で `Content contains 8387 tokens` で失敗する。3 回にしても長い呼び出しで 1 回失敗した。1 回の時間は中央 14 秒で、#379 で見込んだ 3〜5 秒（短い指示での実測）より遅い
7. **ディスク**: 16GB の Mac では、モデル（9B で 5.7GB＋画像用 0.9GB）に加えてスワップが 10GB 近くまで増えた。計測の途中で空きが 155MB まで落ち、計測を止めた。ローカルモードの案内には、モデルの大きさだけでなく、空き容量の目安も要る

## 置き場所

- 仮の接続とスクリプト: このブランチ（`research/local-llm-eval`）の `server/src/openaiCompat.ts`・`server/src/diffUpdater.ts`（`LOCAL_LLM_URL` で切り替え）・`server/bench/afm/main.swift`・`server/bench/afmServer.ts`・`server/bench/callTimes.py`・`server/bench/dumpSchema.ts`
- ランのセッション（log.jsonl・export.json・map.*）・1 回ごとの計測（`*.metrics.jsonl`。時間・トークン・操作の種別だけ）・サーバーのログ・`run.sh`: `~/live-mindmap-samples/runs/local-llm/`（`aborted/` はメモリが逼迫して途中で止めた最初の Qwen3.5-9B のラン。21 回で適用 0）
- モデルと llama.cpp: `~/.cache/live-mindmap-eval/`
