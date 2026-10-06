# CLI の引数は effect/cli で読み、引数の誤りの出力は effect/cli の既定に任せる

server を Effect 4 へ置き換える（[#193](https://github.com/daiki-beppu/live-mindmap/issues/193)）にあたって、`cli.ts` と bench のスクリプトの引数を次の形で読む（[#212](https://github.com/daiki-beppu/live-mindmap/issues/212)）。

- **`effect/cli` の `Command`・`Flag`・`Argument` でサブコマンドの木を作り**、`runCli` は `Command.runWith` を包む。`node:util` の `parseArgs` と `throw new Error("usage: ...")` はやめる。bench の 3 つのスクリプト（`sttReplay.ts`・`sttLatency.ts`・`sessionStats.ts`）も同じ書き方に揃える
- **使い方の説明は `withDescription` を正本にし**、`--help` で読む。`cli.ts` の先頭の使い方のコメントは消す（README のコマンド一覧は人の入口として残す）
- **正解ファイルは `Flag.FileSchema` で読み**、Schema での検証を引数の定義に入れる
- **引数の誤りの出力は、既定の `Formatter` のまま**にする。help（英語の見出し）が stdout、`ERROR ...` が stderr に出て exit 1。`--help`・`--version`・`--wizard`・`--completions`・`--log-level` も増える。正しく呼んだときの stdout は変えない
- **サブコマンドの中身の失敗は、タグ付きの失敗**にし、入口の表 1 つで今と同じ日本語の 1 行に変えて stderr に出し、exit 1 にする。`CliError` は effect/cli が出力済みなので二重に出さない
- 差し替えるもの（差分更新・撮影）は Service と Layer、セッションのフォルダとポートの環境変数は `Config` で受ける。`cli.test.ts` は argv を入れて stdout と失敗を見る形を保つ

## Considered Options

- **`parseArgs` を残し、中身だけ Effect で動かす**: 外から見た振る舞いは 1 文字も変わらない。ただし使い方の誤りが例外のまま残り、エラーを型で表すという置き換えの理由に反する
- **`Formatter` を自前で書き、今の見た目（stderr に 1 行、stdout は空）に寄せる**: 呼ぶのは AI エージェントで、exit code と stderr で失敗に気付ける。保守するコードが増えるだけ

## Consequences

- `effect/cli` も `@stability unstable`。ADR 0008・0009 と同じく exact pin にし、上げるときは `effect/cli` の変更も確かめる
- 引数を間違えたときの出力（stdout に help・英語のメッセージ）と、増えるグローバルフラグは、置き換えの間に認める振る舞いの変化に加える
- `Flag.Boolean` は `withDefault(false)` を付けないと必須になる（`--no-audio` など）
