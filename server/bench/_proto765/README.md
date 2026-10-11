# #765 の試作（使い捨て）

「発言の難しさを判定し、Haiku と Sonnet に振り分ける」の試作。結論は issue #765 のコメントが正本。main には入れない。

## 作り

- 差分更新の呼び出しごとに判定し、Haiku 5.5 と Sonnet 5.5 のどちらかへ回す。query はモデルごとに 1 本ずつ開き、それぞれ自分が前回送ったマップからの変更を受け取る（Q3 (a)）
- 「難しさ」は「新しい発言に決定・TODO（合意・依頼・期限）が含まれるか」だけ（Q1）。含むなら Sonnet
  - `sonnet`: 全部 Sonnet（基準）
  - `jev`: 新しい発言＋直前 6 発言（マップは渡さない）を Jev（`jev-latest`、`noul`）に渡し、確からしさ ≥0.3 なら Sonnet。失敗・1 秒の時間切れは Sonnet（Q7〜Q9）。判定の時間は差分更新の前に入り、遅れに含む
  - `kw`: 新しい発言に次の語のどれかがあれば Sonnet（Q2、モデルなしの規則）: 決め・決ま・決定・しましょう・しよう・やります・やる・までに・お願い・担当・TODO・宿題・確認します・進めます・にします・でいきましょう・合意
- Haiku は #656 のチューニング（effort low、SYSTEM の末尾に `research/haiku-ids` の append-decision.md）。Sonnet は effort medium・追記なし。両方に #697 の「前回の応答の仮 id」と「前回の応答で捨てた操作」を載せる（`research/haiku-ids` の eval-only.patch を今の main に移したもの。`src/claudePrompt.ts`・`src/core/map.ts`・`src/core/session.ts`・`src/claude.ts` の PROTOTYPE の行）。前回の応答の分は、その query 自身の前回の応答だけを渡す（もう一方のモデルの仮 id は通じない）
- 判定の記録（確からしさ・語の当たり・回した先・判定の ms）は出力の `calls[].judge` に残る。`analyze.mjs` は jev をしきい値 0.5・0.7 で振り分け直したときの Sonnet の割合も出す（③ と費用は、流した 0.3 でしか測れない）

## 道具

- `m765.ts <sonnet|jev|kw> <items.json> <lines.json> <out.json> <truth.json>`: #761 の m761.ts と同じ流し方（`replayByArrival`、等速）。先に `pnpm --filter @live-mindmap/server deps:install claude`。Jev の鍵は `op run --env-file=.env.op --`、Claude は Claude Code のサブスク（`env -u ANTHROPIC_API_KEY`）
- `run.sh <screen|facilitators> <回> <dir>`: 3 案を同時に 1 回ずつ流す
- `analyze.mjs <out.json>...`: 話し終わり → ノード p50/p90（判定を含む）、費用（usage × 定価。Sonnet 5.5 $2/$10、書き込み 5 分 $2.5、読み込み $0.20。Haiku 5.5 $0.10/$0.50、$0.125、$0.01。Jev 入力 $0.042）、再現率、Sonnet に回った割合、判定の ms、キャッシュの書き込み/読み込み
- 入力は #761 の計測で作った screen / facilitators の items（いまの規則 quiet）と lines（素材は ~/live-mindmap-samples/synth）。共有画面は添えない（#761・#763 と同じ）

## 結果（2026-10-11〜12、16GB の M4、3 案を同時に、各素材 2 回）

ランごとの表は [results.md](results.md)（`node analyze.mjs` の出力そのまま）。2 回の合計・平均:

| 素材 | 案 | 決定（2 本計） | TODO（2 本計） | → ノード p90（平均） | p50（平均） | 60 分あたり費用（平均） | Sonnet に回った |
| --- | --- | --- | --- | --- | --- | --- | --- |
| screen（23 分） | sonnet | 8/10 | 13/14 | 17.9 秒 | 8.5 秒 | $5.31 | 100% |
| | jev | 8/10 | 13/14 | 18.7 秒（+0.8） | 9.3 秒 | $3.00（−43%） | 44〜45% |
| | kw | 7/10 | 12/14 | 16.8 秒（−1.1） | 9.0 秒 | $1.79（−66%） | 24% |
| facilitators（55 分） | sonnet | 5/8 | 7/10 | 20.1 秒 | 9.8 秒 | $4.72 | 100% |
| | jev | 5/8 | 9/10 | 20.9 秒（+0.8） | 10.6 秒 | $1.35（−71%） | 15〜16% |
| | kw | 4/8 | 10/10 | 20.4 秒（+0.3） | 10.4 秒 | $1.40（−70%） | 16% |

- 失敗・不正な出力は 12 本とも 0。Jev の時間切れ・失敗も 0（判定 p50 約 0.2 秒・p90 約 0.26 秒）
- 1 回の差分更新の秒数は Haiku（low）と Sonnet（medium）でほぼ同じ（p50 2.5〜3.0 秒・p90 4〜5 秒）。#686 の「Haiku は p90 が延びる」は、この流し方（1 回に渡す発言が少ない）では出なかった
- jev をしきい値 0.5・0.7 にすると、Sonnet の割合は screen 36%・27〜29%、facilitators 9%・5%
- 費用の内訳: Haiku の分は 1 本 $0.08〜0.34 で、残りはほぼ Sonnet の分。キャッシュの書き込みは、query を 2 本持つ分で Sonnet だけの 1.3〜1.7 倍に増えるが、増えた分は大半が Haiku の安い単価で、費用は下がる
- 1 本の query で `setModel` する (b) の見積もり: モデルが替わる回（1 本 38〜65 回）ごとに、その回の読み込みが書き込みに替わるとして、1 本あたり +$1.4〜2.3。jev・kw の節約（screen $0.8〜1.4、facilitators $2.8〜3.4）の大半が消え、screen では Sonnet だけより高くなる
- Haiku の 1 回の入力は最大 8.8 万トークンで、10 万を超える高い表には入らなかった

### 注意

- 素材ごと 2 本ずつで、決定・TODO の 1 件の差は揺れと区別できない（Sonnet だけの 2 本でも facilitators の TODO は 4 と 3）
- 3 案を同時に流したので、Claude の混み具合は 3 案で同じ条件だが、単独で流したときと遅れが違う可能性がある
- 費用は Claude Code のサブスクで流した usage に定価を掛けた値。Sonnet の読み込みは $0.20 で数えた（`research/haiku-ids` の cost.mjs は $0.10 だった）
