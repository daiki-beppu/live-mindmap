# 取り込みの状態とマップの取り出し

利用者はターミナルから、取り込みが動いているか（`status`）を見て、最新のセッションのマップを Markdown で取り出し（`export`）、終了の処理を通らなかったセッションのマップをログから戻せます（`restore`）。

## Sub-features

- `status-none`: セッションが無いとき `セッションなし` と `閲覧の共有: 無し`。
- `status-running`: 動いているとき `動いている`・`セッションのフォルダ: ...`・`起動し直した回数: 0`。
- `export-none`: `export.json` を持つセッションのフォルダが 1 つも無いとき、終了コード 1 で `セッションがありません: <フォルダ>`。
- `export-md`: 最新のセッションのマップを標準出力に Markdown で出す。ファイルは作らない。
- `restore-log`: `log.jsonl` を持つ最新のセッションから、差分更新を呼ばずにマップを戻して `export.json` と語彙の蓄えを書き直し、そのフォルダを出す。

## How to get to it (user POV)

- ターミナルで `cli status`、`cli export`、`cli restore` を流す。

## Driving it with browser.sh / cli.sh

Preconditions:

- `bash $S/launch.sh`（4 件）で立てた run。セッションなし。

- **セッションなし.** `bash $S/cli.sh "$RUN" status` が `セッションなし` と `閲覧の共有: 無し`。`bash $S/cli.sh "$RUN" export` が終了コード 1、標準エラーに `セッションがありません:`。
- **動いている.** `D=$(bash $S/cli.sh "$RUN" start --app us.zoom.xos | tail -1)` の後、`status` の 1 行目が `動いている`、`セッションのフォルダ: $D`、`起動し直した回数: 0`。
- **取り出す.** `sleep 3; bash $S/cli.sh "$RUN" export`。終了コード 0、`## 決定`・`## TODO`・`## 未決の論点`・`## アウトライン` の見出しと、アウトラインに `来月の新機能の進め方を相談したいです（00:00）`。`ls "$D"` に `map.md` がまだ無い（export はファイルを作らない）。
- **戻す.** `bash $S/cli.sh "$RUN" stop` の後、`mv "$D/export.json" "$RUN/export.before.json"; bash $S/cli.sh "$RUN" restore`。終了コード 0、標準出力の最後の行が `$D`、`$D/export.json` がまたある。

## Gotchas

- `cli.sh` は `LIVE_MINDMAP_CONFIG` を無いファイルに向けます。利用者の設定（`~/.live-mindmap`）の既定のモデルを読ませないためです。`LIVE_MINDMAP_MODEL` を空にするのは、外から受け継いだ値を消すためだけです（空は未設定と同じ扱い）。素の `pnpm cli` を流すと、`status` や `start` は開発中の server（4319）に繋がり、server を通らない `export`・`restore` は `~/.live-mindmap/sessions` を直接読みます。`restore` はそこにある実物の最新のセッションの `export.json` を書き直すので、必ず `cli.sh` から流します。
- `restore` は `export.json` と語彙の蓄えを書き直しますが、`stop` が書き出した `map.*` は消しません。
- 「最新」はフォルダ名の並びで決まり、見るファイルはサブコマンドごとに違います（`export` は `export.json`、`restore` は `log.jsonl`）。戻ったことは標準出力のフォルダと終了コードで見ます。英字の名前は ISO 時刻より後に並ぶので、同じ run に [見返し](./review.md) の `review` のようなフォルダを作ると、`restore` はそちらを選びます（`$D` になりません）。この手順は見返しより先に流すか、別の run で流します。
- `status` はメモリの状態で、`export` はディスクのフォルダを見ます。`stop` の後は `status` が `セッションなし` でも、`export` は終了コード 0 でそのセッションを出します。`export-none` を見るのは、立てた直後だけです。
