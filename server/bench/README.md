# bench: eval の道具

eval は、本物のモデル・音声認識の出力を数字で測るもので、合否は出さず、手で回す。CI のチェックには含まれない。ここには `cli eval`・`edgeJudge`・`siblingJudge`・`mapShape`・`sttAccuracy`・`sttLatency`・`sttReplay`・`speechEnds`・`speakerReplay` の手順と入出力の形を書く。使い方の細部（フラグの説明）は各コマンドの `--help` が正本。

実会議の録音・文字起こしなどの素材はリポジトリの外にある。置き場所と中身は `~/live-mindmap-samples/README.md` を参照。リポジトリ内には `server/bench/meetings/`（正解・文字起こしの JSON と `lecture.timeline.tsv`）がある。

実行するディレクトリは、`cli`・`bench/*.ts` が `server/`、`stt-bench` が `helper/`。

## cli eval（マップの質）

素材 → `play` → `eval`。

```sh
cd server
node src/cli.ts play <文字起こし.transcript.json> [--model <設定名>] [--local] [--realtime] [--screen <slides.tsv>]   # pnpm cli play ... でも同じ
node src/cli.ts eval [--model <設定名>] [--truth <正解.json>] [--screen-truth <画面の正解.json>] <セッションのフォルダ>...
```

- 素材は `*.transcript.json`（kanary transcribe の JSON）と、`*.truth.json`（`server/bench/meetings/` に例がある）。
- `play` の認証・準備は選んだ経路による。ClaudeはAPIキー、ChatGPTは `login chatgpt`、AppleはこのMacの可用性、互換モデルは外部ランタイムの準備が要る。[README](../../README.md#差分更新のモデルを選ぶ) の設定・選択順を参照。`--local` はAppleを選ぶ（ほかの `--model` と併用しない）。セッションは `LIVE_MINDMAP_SESSIONS` の下に作られる（既定 `~/.live-mindmap/sessions`）。待受けのポートは `LIVE_MINDMAP_PORT`（既定 4319）。
- `play` は終わると、`map.md`・`map.json`・`map.drawnix`・`map.png`・`map.html` のパスを 1 行ずつ出す。
- `--screen` は共有画面の `slides.tsv`（1 行目は見出し、列は `start end slide image`）。
- `eval` の入力: セッションのフォルダを 1 つ以上。各フォルダの `export.json` は必須、`log.jsonl` は任意。
- `eval` は `--model` なしでは、環境変数や設定のdefaultに関係なく保存済み結果を集計するだけで、モデルを呼ばない。`--model` を明示すると、元の `log.jsonl`（共有画面があれば `screens/` も）をそのモデルで待ち時間なしに再生し、新しいランを作って評価する。`eval --model apple` は使えるが `eval --local` は無い。この再評価は等速再生の遅れの測定には使わない。
- 正解ファイルの形の正本は `server/src/core/evaluate.ts` の `Truth`（キーは `決定`・`TODO`）と `ScreenTruth`（キーは `指す発言`・`話だけ`・`出てはいけない`）。
- `eval` の出力: 1 ラン 1 行の Markdown の表。
  - 基本の列: ラン・会議・ノード・深さ・種別ごとの数・ログの指標（`log.jsonl` が無いランは `-`）。
  - 差分更新のトークン数の合計の列（入力・キャッシュ書き込み・キャッシュ読み出し・出力。`log.jsonl` の `diff` の行の `usage` を足す。`usage` が 1 行も無いランは `-`）。金額は出さないので、費用は公式の単価を掛けて出す。
  - 手元で Claude まで流す計測は、`ANTHROPIC_API_KEY` を置かずにログイン中のサブスクの枠で動く。単価を掛けた金額は API の定価に換算した値で、実際の請求ではない。計測の予算は金額ではなく、流す回数（合成会議 screen 1 回を単位とした換算）で決める。
  - `--truth` を渡すと、決定・TODO の再現率の列と、その直後に決定・TODO の種別違いの列が加わる。種別違いは、取りこぼした正解のうち、時刻と keywords が合う別の種別のノード（要点など）として出た数（1 つのノードは 1 件の正解にしか数えない）。
  - `--screen-truth` を渡すと、共有画面の列（指す発言・話だけ・出てはいけないなど）が加わる。

### Apple Intelligence の「試験的」を外す条件

合成会議 **2〜3本**で、同じ素材・同じ正解をClaudeとAppleに使い、次をすべて確認する。eval自体は合否を出さないので、結果を手で比較して記録する。

| 観測対象 | 下限・上限 |
|----------|-------------|
| 正解の決定の再現 | Claudeの3/4以上 |
| 正解のTODOの再現 | Claudeの3/4以上（決定と合算しない） |
| 生成数 | 正解の2倍以内。決定・TODOの種別ごとの数を正解と比較する |
| 等速再生での遅れ | `play --realtime` のp90が45秒以内 |

素材は `~/live-mindmap-samples/README.md` を入口に、合成会議の `*.transcript.json` と対応する `*.truth.json` を2〜3組選ぶ。リポジトリの `server/bench/meetings/` には文字起こし・正解JSONの例があり、合成用台本は `helper/bench/scenarios/` にある。画面を含む素材には同じ `slides.tsv` を両方の再生へ渡すが、Apple初版は画像をモデルへ入力しない。実会議の素材へ置き換えない。

リポジトリルートから、各素材について次を実行する。`pnpm dev` が同時に動く場合は、再生側の `LIVE_MINDMAP_PORT` を空いている別の値にする。

```sh
pnpm cli play <合成会議.transcript.json> --model claude --realtime
pnpm cli play <同じ合成会議.transcript.json> --model apple --realtime
pnpm cli eval --truth <対応する正解.truth.json> <Claudeのラン> <Appleのラン>
```

`play` の出力パスからそれぞれのランのフォルダを控え、`eval` の決定・TODO再現率と種別ごとの数を比較する。素材ごとの結果と、同じ2〜3本での集計を残す。正解・入力・モデル名・失敗数を併記し、未測定の会議へ品質を保証しない。

**遅れは別途集計する。** 現在の `cli eval` に遅れp90の列は無い。等速再生で作った各ランの `log.jsonl` の実時刻 `at` を使い、発言を受け渡した `remark` 行から、その発言を成功して反映した `diff` 行までの秒数を測る。会議内の秒である `remark.start` / `end` や、モデル1回の応答時間、`sttLatency` の遅れで代用しない。

集計は次の手順で行う（遅れを現行ログから測る方法であり、別の受入条件を追加するものではない）。

1. 各 `remark` 行の `remark.id` と実時刻 `at` を対応付ける。`duplicate` / `noContent` の発言は差分更新対象と分けて数える。
2. `error` の無い成功 `diff` 行の `input.fresh` を読む。`processedRemarks` があればその先頭件数だけ、無ければ全件がその回で処理された発言。各IDの受け渡し時刻と、この `diff.at` の差を秒へ換算する。操作が空でも正常な「なし」の分類は成功として数える。
3. 成功反映された発言の遅れを昇順に並べ、件数をNとして `ceil(0.9 × N)` 番目（1始まり）をp90とする。ランごとの件数とp90、2〜3本を合わせた件数とp90を記録する。Nが0なら測定不能であり、45秒以内と判定しない。
4. `diff.error`、一時停止・停止、最後まで未反映だった対象発言の件数を別に記録する。失敗した回の時刻を成功反映時刻にしたり、未反映を遅れ0秒にしたりしない。`diff` の記録時刻はサーバーでの反映の観測点であり、ブラウザでの描画完了時間を測ったものではない。

現状のAppleは合成会議1本・更新7回中4回が出力上限などで失敗した実測があり、上の条件を達成したとは扱わない。新たな評価結果は、同じ素材でのClaude/Appleの再現率・生成数・等速再生の遅れp90・失敗/未反映数を比較表にして残す。

## edgeJudge（親子の意味のつながり）

差分更新のプロンプトを変えたら、形の物差しも回し、親子の意味が崩れていないか同じ合成素材の変更前後で比較する。辺の意味は `edgeJudge` の「なし」の件数・割合で測る。形の数は下の `mapShape` で数え、兄弟の意味は下の `siblingJudge` で測る。ここでは辺判定の手順を示す。

**合成会議だけに使う。** 保存済みの `log.jsonl` から最終マップを復元し、親子の本文をモデルへ渡す。実会議の録音・文字起こし・ログには使わない。合成素材の入口は `~/live-mindmap-samples/README.md`。

リポジトリルートから、`log.jsonl` がある合成セッションのフォルダを1つ以上指定する。

```sh
pnpm --filter @live-mindmap/server exec node bench/edgeJudge.ts <合成セッションのフォルダ>...
pnpm --filter @live-mindmap/server exec node bench/edgeJudge.ts --help
```

既定判定器は認証済みのClaude CLIを使い、`claude -p --model claude-sonnet-5-5` を呼ぶ。子プロセスへ `ANTHROPIC_API_KEY` を継承しない。指定の外部スクリプトと同じプロンプト・行形式で40辺ずつ判定し、各バッチの番号は1から始める。ルート直下（会議→議題）の辺は除き、済みのノードも含む最終状態を判定する。

| ラベル | 意味 |
| --- | --- |
| 具体化 | 親の中身の例・数字・手順・経緯・内訳 |
| 答え | 親の問い・論点・質問への答え、または答えの候補 |
| 派生 | 親から派生し、親との関係を一言で言える別の主張 |
| なし | 親との意味のつながりを言えない |

標準出力は、セッションのフォルダ名・判定した辺数・4ラベルの件数・「なし」の件数と割合のMarkdown表。割合の分母は判定対象の辺数で、対象0辺では件数0・割合0%となりモデルを呼ばない。不正な応答は同じバッチを最大3回判定し、それでも件数・ラベルが合わなければ失敗する。不正応答を「なし」に置き換えない。

各フォルダの全バッチが成功した後に `edgeJudge.json` を書く。形は `[{ "id": "n2", "parent": "n1", "label": "なし" }]` で、本文・生応答は保存しない。失敗時にも本文を表示しない。後のバッチが失敗したフォルダには今回の結果を保存せず、既存の結果があればそのまま残る。複数フォルダは順次処理し、先に成功したフォルダの結果は残る。

目標は親子の関係を一言で言えることであり、「なし」の増減を同じ素材で比較する。数値の合格閾値は設けない。テストとTAKTでは偽判定器だけを使い、実モデルの判断品質は証明しない。マージ後に人が合成セッション1つをClaudeで判定し、出力が数だけであることを確認して、数をPRに記録する。

辺判定の `judgeEdges(events, judge)` は `edges`（id・parent・label）、`total`、`counts`、`none`、`noneRatio`（0〜1）を返す。`createEdgeJudgeCommand(judge)` はCLIへの注入入口であり、既定判定器は実行入口で渡す。判定器の型は `Judge<E, R> = (prompt: string) => Effect.Effect<string, E, R>`（`claudeJudge.ts`）で、ラベルの検証・集計は判定処理側が所有する。

## siblingJudge（兄弟の意味）

差分更新のプロンプトを変えたら、形と意味の物差し（`mapShape`・`edgeJudge`・`siblingJudge`）も回し、同じ素材（合成会議・実会議の再生）の変更前後で比べる。ただし `edgeJudge` は合成会議だけに使う。兄弟の意味は、同じ親の下に並んだ子が「同じ親についての別々の中身」かで測る。

**合成会議・実会議の再生のどちらにも使える。** 保存済みの `log.jsonl` から最終マップを復元し、親子の本文をモデルへ渡す。本文と生の応答はファイル・標準出力・エラーに出さず、id・ラベル・数だけを出す。

```sh
pnpm --filter @live-mindmap/server exec node bench/siblingJudge.ts [--parent <ノード id>] <セッションのフォルダ>...
pnpm --filter @live-mindmap/server exec node bench/siblingJudge.ts --help
```

既定判定器は `edgeJudge` と同じ（`claude -p --model claude-sonnet-5-5`、`ANTHROPIC_API_KEY` は継承しない）。プロンプトとラベルは指定の外部スクリプト `siblingJudge.ts` と同じ。

- 全体: ルートでない親のうち、直下の子（済みを含む）が5以上のものごとに、各子を1つずつ判定する。ルートの子は判定しない。
- `--parent`: 指定した親の直下を、子が5未満でも別に判定する。全体の件数・割合には加えない。全体の対象にも入る親は、全体のラベルを使い回す。ルートや存在しない id はエラー。

| ラベル | 意味 |
| --- | --- |
| 別 | 親について、ほかの兄弟とは別の中身を述べている |
| 具体化 | ほかの兄弟のどれかを具体化している |
| 重なり | ほかの兄弟のどれかとほぼ同じ中身の言い換え・繰り返し |
| 外れ | 親についての中身ではない |

「別でない」は 具体化・重なり・外れ の合計で、割合の分母は判定した子の数（対象0件なら割合は0）。

**合否の補助。** 最大のまとまり（`mapShape` の「最大のまとまり」と同じ数え方。議題・論点・案・課題・要点が対象）が40を超えた回だけ、その直下の全子（5未満でも）を5回独立に判定し、各回の「別でない」の件数の中央値（昇順の3番目）を求める。40以下なら5回の判定はしない（合否は「不要」）。

```
中央値 ≤ 全体の割合 × 直下の子の数 + 1       （等号は通す）
全体の判定対象が0件のときは  中央値 ≤ 1
```

コードは浮動小数の誤差を避け、整数（`中央値 × 全体の判定数 ≤ 別でない × 直下の子の数 + 全体の判定数`）で比べる。

**変更前後の読み方。** 「main から悪くならない」は、前後それぞれ 2 回の全体の「別でない」の件数と判定した子の数を合算した割合で比べ、後が前より 10 ポイントを超えて高いときだけ悪化とする。1 回の判定は数十〜百件ほどなので、同じ規則でも 1 回ごとに 10 ポイントほど揺れる（#970 では前の 2 回が 14.8% と 25.0%）。「後の 2 回とも前の 2 回の幅に収まる」では、変わっていなくても外れやすい。

```
後の合算の割合 > 前の合算の割合 + 0.10   なら悪化
（整数で: 10 × 後の別でない × 前の判定数 > 10 × 前の別でない × 後の判定数 + 前の判定数 × 後の判定数）
```

標準出力は、セッションごとのMarkdown表の1行（子が5以上の親の数・判定した子・4ラベルの件数・「別でない」の件数と割合・指定した親・最大のまとまりの id と大きさ・5回の件数・中央値と閾値・合否）。各フォルダの全判定が成功した後に `siblingJudge.json` を書く。形は `parents`（`[{ parent, children: [{ id, label }] }]`）・`total`・`counts`・`notSeparate`・`notSeparateRatio`・`target`・`maxGroup`（`parent`・`size`・`check`）で、id・ラベル・数だけを持ち、本文・生応答は保存しない。不正な応答は同じ親を最大5回判定し、それでも合わなければ失敗する。失敗時は結果を保存せず、本文も表示しない。

テストとTAKTでは偽判定器だけを使い、実モデルの判断品質は証明しない。マージ後に人が実験のセッション1つをClaudeで判定し、出力が数だけであることを確認して、数をPRに記録する。

## stt-bench（sttAccuracy・sttLatency 共通の素材づくり）

```sh
bash helper/scripts/build-webrtc-apm.sh     # 事前に 1 回
cd helper
swift run -c release stt-bench synth <台本.json> <出力フォルダ> [--only <名前>] [--gap <秒>]
swift run -c release stt-bench variants
swift run -c release stt-bench run --variant <名前> <音声.wav> [--load <音声2.wav>] [--vocab <語彙.txt>] [--vocab-at <秒>] > <results>.jsonl
swift run -c release stt-bench tracks <会議フォルダ> <出力フォルダ> --self <話者>
swift run -c release stt-bench run --variant baseline <相手.wav> --events [--self <自分.wav>] > <events>.jsonl
```

- `synth` は `<名前>.wav`・`<名前>.lines.json`（行の時刻）・`<名前>.truth.json` を書く。台本は `helper/bench/scenarios/`。
- `variants` は候補の設定の一覧を出す。
- `run` は 1 行 1 結果の JSONL を標準出力に出す。キーは `arrival`・`end`・`isFinal`・`start`・`text`・`track`。
- `tracks` は合成会議のフォルダ（`timeline.tsv`・`voices.json`・`lines/`）を、`--self` の話者の行だけの `自分.wav` と、残りの `相手.wav` に分ける（speakerAccuracy 用）。各行は `lines/<sha1(声 + 改行 + 文)の先頭 16 桁>.wav`（1 行 1 本）を読み、`synth.mjs` と同じ末尾の雑音の無音化をして、`timeline.tsv` の `start` の位置に置く。2 本の長さは最後の行の `end` + 3 秒で同じ。`meeting.m4a` は使わない。標準出力は行数と秒数だけ。lines/ が無い・`--self` が台本にいない・声が `voices.json` にないときは、行番号と数だけを出して失敗する（本文は出さない）。
- `run --events` は、既定の出力（上の ResultLine）の代わりに、ヘルパーのイベントに届いた時刻 `arrival`（流し始めからの秒）を足した 1 行 1 JSON を出す。相手の `remark`・`partial`（`words`・`wordTimes` つき）と、同じ音声に Sortformer を掛けた `speaker`・`speaker-settled`・`speaker-mixed`・`speaker-centroid`。`--self <自分.wav>` があれば、自分の `remark`・`partial`（`track: "自分"`）も同じ起点から並行して流す。認識はライブと同じ `SilenceFilteringTranscriber` で包む。話者分離を準備できなければ失敗する（話者なしで続けない）。`--vocab`・`--load`・`--diarize` とは併用しない。事前に `bash helper/scripts/fetch-speaker-models.sh`。出力は `speakerReplay --offline` と `speakerAccuracy` がそのまま読める。
- 合成した音声と計測の出力は、リポジトリの外（`/tmp` など）に置く。

## sttLatency（確定の遅れ）

素材 → `stt-bench synth`／`run` → `sttLatency`。

```sh
cd server
node bench/sttLatency.ts <results> [--quiet <秒>] [--emit final|discard] [--lines <lines.json>]
```

- `<results>`: `stt-bench run` の JSONL。
- `--quiet`: 本番の区切り方（`core` の `createRemarkSettler`）が、途中結果が変わらなければ発言にする秒数。本番の定数（`SETTLE_QUIET_MS`）を差し替える。既定は本番と同じ 1。
- `--lines`: `synth` の `<名前>.lines.json`。渡すと、確定結果の `end` ではなく各文の話し終わりから数えた遅れを出す（`start`・`end` だけを読む）。実会議では `speechEnds` の出力を渡す。
- 出力: Markdown の表。列は 方式・件数・遅れ p50 (秒)・遅れ p90 (秒)。2 行目は、途中結果と確定結果を届いた時刻の順に本番の規則へ通して出た発言の遅れ（途中結果の届いた時刻を規則の時計として渡す）。
- `--emit` を付けると、表の代わりに、発言の JSON 配列（`sttReplay.ts` 用）を出す。`final` は確定結果だけ、`discard` は本番の区切り方で作る（後から届いた確定結果は流さない）。

## sttReplay（話し終わり → ノード）

素材 → `sttLatency --emit` → `sttReplay`。

```sh
cd server
node bench/sttReplay.ts <items.json> [--lines <lines.json>] [--truth <正解.json>] [--title <題名>]
```

- `<items.json>`: `sttLatency.ts --emit` の出力。
- 流し方: 流し始めを基準に、各発言を自分の `at` の時刻に本番のセッションへ届ける。等速で流し、最後に flush する。差分更新が混んで push が遅れても、後ろの発言に遅れを足さない。push が `at` を過ぎて終わったら、次の発言は待たずにすぐ流す。
- 出力の「話し終わり → ノード」は、別の道具で差し引かずに、そのまま PR 本文の表に書ける。遅れを差し引いて数えた過去の値（#878・#880・#881）と同じ物差しで並べられる。
- `--lines` を渡すと各文の話し終わりから、なければノードに反映された発言の `end` から数える。`--truth` を渡すと再現率を 1 行で出す。

## speechEnds（実会議の話し終わり）

録音 → `speechEnds` → `sttLatency --lines` / `sttReplay --lines`。

```sh
cd server
node bench/speechEnds.ts <録音> [--noise <dB>] [--min-silence <秒>] [--min-speech <秒>] > lines.json
```

- **ffmpeg が要る**。PATH 上のものを使う（リポジトリには入れない）。無い・録音の長さを読めないときは、空の配列で成功せず失敗する。
- 規則: 無音区間（silencedetect）の始まりを話し終わり（`end`）、終わりを次の話し始め（`start`）とする。先頭の無音の前と末尾の無音の後ろには行を作らない。`--min-speech` より短い話している区間は捨てる。既定は `--noise -30`・`--min-silence 0.5`・`--min-speech 0.2`。
- 出力は `[{"start":…,"end":…}]` で、`sttLatency.ts --lines` と `sttReplay.ts --lines` にそのまま渡せる。
- 合成会議で確かめる手順: `stt-bench synth` の `<名前>.wav` から `speechEnds` で行の時刻を作り、`<名前>.lines.json` と並べて差を見る（それぞれを `sttLatency --lines` に渡して p50・p90 を比べてもよい）。試作では 0.5 秒以内で合った。

## sttAccuracy（認識の正確さ）

素材 → `stt-bench run`（または kanary transcribe）→ `sttAccuracy`。

```sh
cd server
node bench/sttAccuracy.ts <timeline.tsv> <remarks> [--terms <語彙.txt>] [--window <秒>] [--settle]
node bench/sttAccuracy.ts bench/meetings/lecture.timeline.tsv bench/meetings/lecture.transcript.json   # リポジトリ内の素材で動く例
```

- `<timeline.tsv>`: 台本の行と時刻（正解）。タブ区切りの 4 列 `speaker start end text`。`#` で始まる行は飛ばす。`stt-bench synth` は出さない。
- `<remarks>`: 拡張子が `.json` なら kanary transcribe の JSON、それ以外は `stt-bench run` の JSONL（`--settle` が無ければ確定結果だけを使う）。
- `--terms`: 固有名詞・略語の正しい表記を 1 行 1 語で並べたファイル。
- `--window`: 突き合わせる区切りの最短の秒数（既定 30）。
- `--settle`: JSONL の途中結果と確定結果を、本番と同じ `createRemarkSettler()`（関所つき）へ `arrival` の順に通し（時計は結果の `end` の最大値。`arrival` は並び順だけに使う）、出た発言で採点する。付けなければ確定結果だけで採点する。`.json` に付けると失敗する（途中結果も到着の時刻もないため）。
- 出力:
  - CER の表（台本の文字数・CER・置換・脱落・挿入）。
  - `--terms` を渡したときは、正解率の行と、語ごとの表（語・正解・かな違い・出現・崩れ方）。
  - 最後に「多い食い違い」の一覧。

## mapShape（マップの形の物差し）

差分更新のプロンプトを変えたら、同じ素材の変更前後のセッションで形も比べる。合否は出さず、最大のまとまりなどの数を判断材料にする。兄弟や辺の意味を判定する道具（`siblingJudge`・`edgeJudge`）は、この CLI には含まれない。

リポジトリルートで実行する。モデル認証や常駐サーバーは不要。

```sh
pnpm --filter @live-mindmap/server exec node bench/mapShape.ts <セッションフォルダ>...
```

各フォルダの `log.jsonl` を既存の復元処理で最終マップへ戻し、セッションごとに Markdown 表の 1 行を出す。本文（会議タイトル・発言・ノードの text）は出さず、結果ファイルも作らない。不正 JSON・不正な既知イベント・復元できないログは非ゼロ終了する。診断に JSON 原文や復元例外の実値は含めない。

| 列 | 数え方 |
| --- | --- |
| セッション | 入力フォルダの末尾 2 要素 |
| 分 | 全 remark の最大 end / 60（小数 0 桁） |
| ノード | ルートを含む最終ノード数 |
| 議題（入れ子） | 議題総数（直接の親が議題である議題数） |
| 議題/時 | 議題総数 / 会議時間（小数 1 桁。時間 0 なら 0） |
| 最大の議題 | 議題の大きさの最大値 |
| 最大のまとまり | 議題・論点・案・課題・要点の大きさの最大値 |
| 派生の論点 | 直接の親が論点である論点数 |
| 子が 1 つ | 子が 1 つのノード数と、ルートを含む全ノード数に対する割合（整数 %） |
| 鎖の最長 | 子が 1 つで続く辺の数の最大値 |
| 同じ種別の鎖の最長 | 親子の種別も一致する、子が 1 つで続く辺の数の最大値 |
| 最大の深さ | ルートを 0 とした深さの最大値 |
| 子の数の分布（0/1/2/3/4/5/6+） | 子の数ごとのノード数。6 以上は最後へまとめる |

大きさはプロンプトと共通の core の `groupSize` で数える。起点自身は含めない。議題・案・課題・要点では論点を 1 と数え、その配下は除く。論点では派生の論点自身を 1 と数えて配下は除き、済みの論点を起点にした大きさは 0。どの起点でも子の議題自身とその配下は除く。決定済みと済みは別の状態であり、決定を持つだけでは計測を打ち切らない。一番近い祖先の議題は親から探索し、なければルートを返す。

## speakerReplay（話者の結び付けの流し直し）

録音からやり直さずに、発言への話者の結び付けを測り直す（Issue #1030）。入力を届いた順に、本番の中核（`createRemarkSettling` → `createSpeakerAttribution`）へ流し直す。規則は中核だけが持ち、この道具は写さない。`cli play`（締めた後の発言を流す）とは別の経路。認証・サーバー・モデルは不要。

```sh
cd server
node bench/speakerReplay.ts [旗] <セッションフォルダ か log.jsonl>
node bench/speakerReplay.ts --offline [旗] <オフライン出力の JSONL>
```

入力は 2 通り。

- `log.jsonl`（既定）: ライブが残した `remark` 行（話者の段を通った後の断片）と、話者のイベント 5 種、`intake-restarted`。行の順を届いた順として、`remark` 行は話者の段へ直接入れる。`remark.speaker` は使わず、流し直しで決め直す。話者を持たない古いログも流せる（相手の発言は話者なし）。
- `--offline`: ヘルパーのイベント（helper/README の「イベントの形」）に、届いた時刻 `arrival`（秒）を足した 1 行 1 JSON。ファイル上の順は問わず、`arrival` の順（同じ値はファイルの順）に `partial`・`remark`・話者のイベントを settler から流す。知らない種類と使わない種類（`origin`・`screen` など）は読み飛ばす。`stt-bench run`（既定の出力）と `--diarize` の出力は `speaker-settled`・`wordTimes`・重心を持たないので、そのままは流せない。`stt-bench run --events` の出力はそのまま流せる。

旗:

| 旗 | 外す規則 |
| --- | --- |
| `--without-longest-overlap` | 最も長い重なり。代わりに、重なる区間のうち `start` が最も早い枠（同じなら小さい枠） |
| `--without-fill` | 誰もいない語を前後に寄せる。その語は話者なし |
| `--without-min-run` | 0.5 秒の下限（短い区間を長い隣へ寄せる） |
| `--without-wait` | 3 秒の待ち。揃う・`speaker-off`・起動し直し・最後まで待つ（「すぐ出す」ではない） |
| `--restart-at <秒>` | 届いた時刻（最初の入力からの秒）以降の最初の入力の直前で、話者分離の枠の状態を捨てて重心でつなぎ直す。ラベルと重心は残す。ログの `intake-restarted` は旗がなくても起動し直しとして扱う |

出力は標準出力に JSON 1 つ。発言の本文・`raw`・`words` は出さない。

- `remarks`: 出した順の `{ source, track, start, end, speaker? }`。`source` は log では元の `remark.id`、offline では出した順の `r1…`
- `labels`: 振ったラベル
- `mixed`: 混入（`speaker-mixed`）の記録 `{ slot, label? }`
- `links`: 起動し直し後のつなぎ直しの判定 `{ slot, result: "linked" | "new" | "reverted", label? }`。迷って決まらなかった判定は出ない
- `restarts`: 起動し直した届いた時刻 `{ at, source: "flag" | "log" }`
- `cuts`: 話者の替わり目で発言を切った数（断片の数 − 1 の合計）。0 でも出す
- `timeouts`: 区間が揃わないまま 3 秒の時間切れで話者なしになった発言の数。0 でも出す

不正な行は行番号だけを診断にして非ゼロ終了する（JSON の原文は出さない）。

`log.jsonl` には、締める前の `partial` と確定結果が残っていない。そのため log の入力では、次の 2 点は測り直せない。測るには `--offline` を使う。

- 断片をまたぐ切り方の変化（0.5 秒の下限による寄せなど）
- 3 秒の待ちの長さそのもの（待ちを外すことはできる）。各 `remark` 行は、ライブがその発言を出した時点にあるとみなす。入れた直後に時計を 3 秒進め、揃っていればその場で規則を当て、揃っていなければ話者なしで出す

## speakerAccuracy（話者分離の精度）

話者分離のモデル・発言への対応付けの規則・基準値を変えたときに、合成会議で発言ごとの 正解 / 取り違え / 話者なし の割合を測る（Issue #1031）。手で回し、合否は出さない。PR には同じ素材での before/after の表を載せる。

素材 → `stt-bench tracks` → `stt-bench run --events` → `speakerAccuracy`（中の流し直しは `speakerReplay --offline` と同じ `replayOffline`）。

```sh
bash helper/scripts/build-webrtc-apm.sh && bash helper/scripts/fetch-speaker-models.sh   # 事前に 1 回
M=~/live-mindmap-samples/synth/facilitators       # lines/ を Drive から戻してある会議のフォルダ
cd helper
swift run -c release stt-bench tracks $M /tmp/sa --self 森川
swift run -c release stt-bench run --variant baseline /tmp/sa/相手.wav --self /tmp/sa/自分.wav --events > /tmp/sa/events.jsonl
cd ../server
node bench/speakerAccuracy.ts --self 森川 [旗] $M/timeline.tsv /tmp/sa/events.jsonl
```

- 素材は今ある合成会議 4 本（基準値を選んだ素材）。`--self` は、台本（`cast.json`）で進行役の人。

  | 会議 | `--self` | 長さ |
  | --- | --- | --- |
  | `synth/facilitators/` | 森川（ファシリテーター） | 55 分 |
  | `synth/silly/` | マキ（司会） | 75 分 |
  | `synth/parnassus/` | ハル（進行役） | 約 161 分 |
  | `synth/screen/` | 大河内（進行役） | 約 23 分 |

- 素材の `lines/` は Drive へ退避してある。流す前に、`~/live-mindmap-samples/README.md` の手順で、Drive の同じ相対パスからそのフォルダへ戻す（`tracks` は `lines/` の 1 行 1 本の音声を読む）。
- `run --events` は実時間で流すので、会議の長さと同じ時間がかかる（parnassus は約 161 分）。会議ごとの実行は、別々のプロセスで並べて流せる（認識の採点は、4 本を同時に流した結果が単独で流し直した結果と一致した。`docs/devlog/2026-10-08.md` の「実時間で流す計測を並べるなら」。話者分離を並べたときの違いは未確認）。
- `自分` の発言は中核が常に「自分」にするので、話者分離の物差しにならない。採点は 相手 の発言だけ。`--self` の行は正解の人にも DER の参照にも入れない。
- 旗は speakerReplay と同じ（`--without-longest-overlap`・`--without-fill`・`--without-min-run`・`--without-wait`・`--restart-at <秒>`）。規則を 1 つずつ外して、同じ events で結果を比べる。旗は発言への対応付けにだけ効く。DER は確定区間（話者分離のモデルの出力）の物差しなので、旗では変わらない。

出力は標準出力に Markdown の表 1 つ（見出し 1 行 + 値 1 行）。数とラベルだけで、発言の本文は出さない。

| 列 | 定義 |
| --- | --- |
| 発言数 | 採点した 相手 の発言（中核が出した断片）の数 |
| 正解 | 話者のラベルが付き、そのラベルに対応する人が正解の人である発言の割合 |
| 取り違え | 話者のラベルが付いたが、対応する人が正解の人でない発言の割合。人と対応できなかったラベルもここに入る |
| 話者なし | ラベルを付けなかった発言の割合。取り違えとは別に数える（意図してラベルなしにした分を悪化と取り違えないため） |
| 採点対象外 | 正解の人がいない発言の数（`--self` の行にしか重ならない・どの行にも重ならない）。割合の分母に入れない |
| DER | collar 0.25 秒の DER。参照は `--self` を除く台本の行、仮説は確定した区間 |
| 仮→確定 | 仮のラベル（字幕に見えていたラベル）が、発言に付いた確定のラベルへ替わった発言の割合 |
| 切った | 話者の替わり目で切った数（断片の数 − 1 の合計） |
| 3秒で話者なし | 区間が揃わないまま 3 秒の時間切れで話者なしになった数 |
| 切れなかった | 正解では `--self` 以外の 2 人以上と重なるのに、1 つの発言として出た数（重なりの長さに下限は設けない。本番の 0.5 秒の下限が短い交替を潰した影響も数える） |

- 正解の人: 発言の区間と最も長く重なる人（同じ人の複数の行は重なりを足す）。`timeline.tsv` の話者（列 0）を使う。
- 推定のラベルと正解の人: 会議全体で 1 対 1 に、重なり（ラベルが付いた発言の区間と、その人の行の区間の重なりの合計）が最大になるように対応させる（ハンガリアン法）。重なりが 0 のラベルは、人と対応しない。
- DER: 参照の区間の境の前後 0.25 秒を採点から外し、取りこぼし・余計な検出・付け間違いの合計を、参照の長さで割る。枠と人の対応も同じ 1 対 1 で取る。
- 仮→確定: 各発言について、仮のラベルと確定のラベル（出た発言の話者）を比べる（枠ではなくラベルで比べる）。区間（中核の `preview` の確定区間と仮の区間）は、`speaker-settled` の後と起動し直しの後にだけ写す。ラベルは、写した区間に現れる枠について、入力の 1 行ごとに `preview` で解き直す（発言を出すと振られたラベルが増え、残る枠の予想が変わるため）。仮のラベルは、発言を出した行を適用する直前の写しで、発言の区間と最も長く重なる枠のラベル。まだラベルを振っていない枠は、区間に初めて現れた順の予想になる。1 つ前の更新が無い・区間が発言と重ならない・話者なしで出た発言は、両方が決まっていないので分母に入れない。
- 不正な行・台本にない `--self`・無いファイルは、行番号やパスだけを診断にして非ゼロ終了する。

## eval ではないもの

- `sessionStats.ts` は数えるだけで、eval ではない。
- `mapShape.ts` も形を数えるだけで、モデルを呼ばない。
- `server/test/eval.it.test.ts` はモデルを呼ばない決定的なテストで、普通のテストとして層に入る。
