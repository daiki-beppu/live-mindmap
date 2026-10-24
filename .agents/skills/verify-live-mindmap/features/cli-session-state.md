# 取り込みの状態とマップの取り出し

利用者はターミナルから、取り込みが動いているか（`status`）を見て、最新のセッションのマップを Markdown で取り出し（`export`）、終了の処理を通らなかったセッションのマップをログから戻せます（`restore`）。

## Sub-features

- `status-none`: セッションが無いとき `セッションなし` と `閲覧の共有: 無し`。
- `status-running`: 動いているとき `動いている`・`セッションのフォルダ: ...`・`起動し直した回数: 0`。
- `export-none`: セッションが 1 つも無いとき、終了コード 1 で `セッションがありません: <フォルダ>`。
- `export-md`: 最新のセッションのマップを標準出力に Markdown で出す。ファイルは作らない。
- `restore-log`: 最新のセッションのログから、差分更新を呼ばずにマップを戻し、そのフォルダを出す。

## How to get to it (user POV)

- ターミナルで `cli status`、`cli export`、`cli restore` を流す。

## Driving it with browser.sh / cli.sh

Preconditions:

- `bash $S/launch.sh`（4 件）で立てた run。セッションなし。

- **セッションなし.** `bash $S/cli.sh "$RUN" status` が `セッションなし`。`bash $S/cli.sh "$RUN" export` が終了コード 1、標準エラーに `セッションがありません:`。
- **動いている.** `D=$(bash $S/cli.sh "$RUN" start --app us.zoom.xos | tail -1)` の後、`status` の 1 行目が `動いている`、`起動し直した回数: 0`。
- **取り出す.** `sleep 3; bash $S/cli.sh "$RUN" export`。終了コード 0、`## 決定`・`## TODO`・`## 未決の論点`・`## アウトライン` の見出しと、アウトラインに `来月の新機能の進め方を相談したいです（00:00）`。`ls "$D"` に `map.md` がまだ無い（export はファイルを作らない）。
- **戻す.** `bash $S/cli.sh "$RUN" stop` の後、`bash $S/cli.sh "$RUN" restore`。終了コード 0、標準出力の最後の行が `$D`。

## Gotchas

- `cli.sh` は `LIVE_MINDMAP_CONFIG` を無いファイルに向け、`LIVE_MINDMAP_MODEL` を空にします。利用者の設定（`~/.live-mindmap`）の既定のモデルを読ませないためです。素の `pnpm cli` を流すと、開発中の server（4319）に繋がります。
- `restore` はログを読み直すだけで、`stop` が書き出した `map.*` を消しません。戻ったことは標準出力のフォルダと終了コードで見ます。
