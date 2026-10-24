# 会議中の流れ

利用者が CLI で会議の取り込みを始めると、相手と自分の発言が画面の下に字幕の吹き出しで出て、確定した発言がマップのノードになります。`stop` で終えると、セッションのフォルダに `map.md`・`map.json`・`map.drawnix`・`map.html` が書き出されます。

## Sub-features

- `live-start`: `start` がセッションのフォルダを出し、画面のルートがその名前になる。
- `live-captions`: 途中結果が字幕の吹き出しに残る。相手は左の行で名前の欄（`相手 B`、約 3 秒後に `相手`）、自分は右の行で名前の欄が空。
- `live-nodes`: 確定した発言がノード（`button "<発言>"`）になる。
- `live-stop`: `stop` が書き出したファイルのパスを出し、状態が `セッションなし` に戻る。
- `live-export-files`: 書き出したファイルが残り、形式の目印を含む。

## How to get to it (user POV)

- ブラウザで `http://127.0.0.1:<ポート>/` を開いておく。
- ターミナルで `cli start --app <会議アプリ>` を流す。
- 終えるときにターミナルで `cli stop` を流す。

## Driving it with browser.sh / cli.sh

Preconditions:

- `bash $S/launch.sh`（4 件）で立てた run。セッションなし。

- **画面を開く.** `bash $S/browser.sh "$RUN" open "http://127.0.0.1:$P/"`、`bash $S/browser.sh "$RUN" screenshot --filename shots/live-01-before.png`。マップは空。
- **始める.** `D=$(bash $S/cli.sh "$RUN" start --app us.zoom.xos | tail -1)`。終了コード 0、`$D` がセッションのフォルダ（`.../sessions/<ISO 時刻>`）。
- **字幕とノード.** `sleep 3; bash $S/browser.sh "$RUN" snapshot`。次がすべてある:
  - `button "<セッション名>"`（ルート）
  - `button "来月の新機能の進め方を相談したいです"`・`button "まず優先順位を決めましょう"`（ノード）
  - 字幕の `担当を分け`（自分の行。名前の欄なし）と、`相手 B` か `相手` の名前の欄つきの `検索の改善を先にやりた`
  `bash $S/browser.sh "$RUN" screenshot --filename shots/live-02-running.png`。
- **状態.** `bash $S/cli.sh "$RUN" status`。1 行目が `動いている`、2 行目が `セッションのフォルダ: <start が出したフォルダ>`。
- **終える.** `bash $S/cli.sh "$RUN" stop`。終了コード 0、標準出力に `map.md`・`map.json`・`map.drawnix`・`map.html`・`map-audio.html` のパス。標準エラーに Chromium が無い警告（`map.png` を作らない）が出るのは想定どおり。
- **書き出しの中身.** `grep -c '## アウトライン' "$D/map.md"`（1）、`grep -c '"root"' "$D/map.json"`（1 以上）、`grep -c '"speaker": "相手 A"' "$D/map.json"`（1 以上）、`grep -c '"type": "drawnix"' "$D/map.drawnix"`（1 以上）。
- **戻った状態.** `bash $S/cli.sh "$RUN" status` の 1 行目が `セッションなし`。

## Gotchas

- 全件（`launch.sh 14`）では最後が相手の途中結果「来週のリリースは金曜に」で、字幕には発言になった分を除いた `金曜に` だけが出て、`来週のリリースは` はノードになります（Issue #1222）。4 件の手順の字幕の判定は、そのままでは通りません。
- 偽の updater はすぐ返すので、確定した発言が字幕に見えている間は捉えられません。確定した発言はノードで見ます。
- 同時に動かせるセッションは 1 つです。`start` を 2 回流すと、2 回目は終了コード 1 で `セッションが進行中です（先に stop）`。
- `$D` は一時フォルダです。`stop.sh` の後は消えるので、証拠は `$RUN/sessions/<セッション名>/` で見ます。