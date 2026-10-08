# bench: eval の道具

eval は、本物のモデル・音声認識の出力を数字で測るもので、合否は出さず、手で回す。CI のチェックには含まれない。ここには 3 つの eval の道具（`cli eval`・`sttAccuracy`・`sttLatency`）の手順と入出力の形を書く。使い方の細部（フラグの説明）は各コマンドの `--help` が正本。

実会議の録音・文字起こしなどの素材はリポジトリの外にある。置き場所と中身は `~/live-mindmap-samples/README.md` を参照。リポジトリ内には `server/bench/meetings/`（正解・文字起こしの JSON と `lecture.timeline.tsv`）がある。

実行するディレクトリは、`cli`・`bench/*.ts` が `server/`、`stt-bench` が `helper/`。

## cli eval（マップの質）

素材 → `play` → `eval`。

```sh
cd server
node src/cli.ts play <文字起こし.transcript.json> [--realtime] [--screen <slides.tsv>]   # pnpm cli play ... でも同じ
node src/cli.ts eval [--truth <正解.json>] [--screen-truth <画面の正解.json>] <セッションのフォルダ>...
```

- 素材は `*.transcript.json`（kanary transcribe の JSON）と、`*.truth.json`（`server/bench/meetings/` に例がある）。
- `play` は Claude の認証が要る。セッションは `LIVE_MINDMAP_SESSIONS` の下に作られる（既定 `~/.live-mindmap/sessions`）。待受けのポートは `LIVE_MINDMAP_PORT`（既定 4319）。
- `play` は終わると、`map.md`・`map.json`・`map.drawnix`・`map.png`・`map.html` のパスを 1 行ずつ出す。
- `--screen` は共有画面の `slides.tsv`（1 行目は見出し、列は `start end slide image`）。
- `eval` の入力: セッションのフォルダを 1 つ以上。各フォルダの `export.json` は必須、`log.jsonl` は任意。
- 正解ファイルの形の正本は `server/src/core/evaluate.ts` の `Truth`（キーは `決定`・`TODO`）と `ScreenTruth`（キーは `指す発言`・`話だけ`・`出てはいけない`）。
- `eval` の出力: 1 ラン 1 行の Markdown の表。
  - 基本の列: ラン・会議・ノード・深さ・種別ごとの数・ログの指標（`log.jsonl` が無いランは `-`）。
  - `--truth` を渡すと、決定・TODO の再現率の列が加わる。
  - `--screen-truth` を渡すと、共有画面の列（指す発言・話だけ・出てはいけないなど）が加わる。

## stt-bench（sttAccuracy・sttLatency 共通の素材づくり）

```sh
bash helper/scripts/build-webrtc-apm.sh     # 事前に 1 回
cd helper
swift run -c release stt-bench synth <台本.json> <出力フォルダ> [--only <名前>] [--gap <秒>]
swift run -c release stt-bench variants
swift run -c release stt-bench run --variant <名前> <音声.wav> [--load <音声2.wav>] [--vocab <語彙.txt>] [--vocab-at <秒>] > <results>.jsonl
```

- `synth` は `<名前>.wav`・`<名前>.lines.json`（行の時刻）・`<名前>.truth.json` を書く。台本は `helper/bench/scenarios/`。
- `variants` は候補の設定の一覧を出す。
- `run` は 1 行 1 結果の JSONL を標準出力に出す。キーは `arrival`・`end`・`isFinal`・`start`・`text`・`track`。
- 合成した音声と計測の出力は、リポジトリの外（`/tmp` など）に置く。

## sttLatency（確定の遅れ）

素材 → `stt-bench synth`／`run` → `sttLatency`。

```sh
cd server
node bench/sttLatency.ts <results> [--quiet <秒>] [--emit final|discard|correct] [--lines <lines.json>]
```

- `<results>`: `stt-bench run` の JSONL。
- `--quiet`: 途中結果が変わらなければ確定として扱う秒数（既定 2）。
- `--lines`: `synth` の `<名前>.lines.json`。渡すと、確定結果の `end` ではなく各文の話し終わりから数えた遅れを出す（`start`・`end` だけを読む）。
- 出力: Markdown の表。列は 方式・件数・遅れ p50 (秒)・遅れ p90 (秒)・上書き。
- `--emit` を付けると、表の代わりに、その規則の発言の JSON 配列（`sttReplay.ts` 用）を出す。

## sttAccuracy（認識の正確さ）

素材 → `stt-bench run`（または kanary transcribe）→ `sttAccuracy`。

```sh
cd server
node bench/sttAccuracy.ts <timeline.tsv> <remarks> [--terms <語彙.txt>] [--window <秒>]
node bench/sttAccuracy.ts bench/meetings/lecture.timeline.tsv bench/meetings/lecture.transcript.json   # リポジトリ内の素材で動く例
```

- `<timeline.tsv>`: 台本の行と時刻（正解）。タブ区切りの 4 列 `speaker start end text`。`#` で始まる行は飛ばす。`stt-bench synth` は出さない。
- `<remarks>`: 拡張子が `.json` なら kanary transcribe の JSON、それ以外は `stt-bench run` の JSONL（確定結果だけを使う）。
- `--terms`: 固有名詞・略語の正しい表記を 1 行 1 語で並べたファイル。
- `--window`: 突き合わせる区切りの最短の秒数（既定 30）。
- 出力:
  - CER の表（台本の文字数・CER・置換・脱落・挿入）。
  - `--terms` を渡したときは、正解率の行と、語ごとの表（語・正解・かな違い・出現・崩れ方）。
  - 最後に「多い食い違い」の一覧。

## eval ではないもの

- `sessionStats.ts` は数えるだけで、eval ではない。
- `server/test/eval.it.test.ts` はモデルを呼ばない決定的なテストで、普通のテストとして層に入る。
