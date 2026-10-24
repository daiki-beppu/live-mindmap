---
name: verify-live-mindmap
description: live-mindmap の実物（server・CLI・web の画面）を立てて、利用者と同じ操作で動きを確かめ、証拠（画面の写し・CLI の出力・書き出したファイル）を残す。会議中の流れ（start → 字幕とノード → stop → 書き出し）・ノードの根拠・見返しの map.html・CLI の status / export / restore を変えたとき、または変えた振る舞いを画面で示すときに使う。
---

# live-mindmap を立てて、利用者の操作で確かめる

確かめ用の 1 組は `e2e/scripts/serve.ts` が立てます。server は本体の `startup` / `realLayers` そのままで、境界の 2 つだけを差し替えます。

- helper（macOS の音声の取り込み）は `server/test/fixtures/fake-helper.ts`。台本 `e2e/fixtures/meeting.json`（架空の発言 14 件）を流します。
- 差分更新（モデル）は偽の updater。確定した発言 1 件ごとに、ルート直下へノードを 1 つ足し、文言は発言そのままです。

ポートは空きポート、セッションのフォルダは一時フォルダです。開発中の server（4319）・`~/.live-mindmap`・利用者のブラウザには触れないので、複数の run を並べて立てられます。他人が立てた server や `pnpm dev` を操作しないでください。

確かめられないもの: 実物の helper（会議アプリの音声・共有画面）、実物のモデルによるマップの中身、`map.png`（一時の管理依存に Chromium が無いので、stop は警告を出して作りません）、`share`・`publish`（外のネットワーク）。これらを変えたときは、`AGENTS.md` の Evals と実機の確認に回します。

ヘルパーはすべて `.agents/skills/verify-live-mindmap/scripts/` にあり、repo（worktree）のルートから呼びます。以下 `S=.agents/skills/verify-live-mindmap/scripts` とします。

## 1. 立てる

```sh
S=.agents/skills/verify-live-mindmap/scripts
RUN=$(bash $S/launch.sh)        # 台本の先頭 4 件。全件は bash $S/launch.sh 14
P=$(cat "$RUN/web-port")
```

`launch.sh` は、run-info（`e2e/.run/<ポート>.json`）ができ、web が 200 を返し、server が CLI の `status` に答えるまで待ちます（多くは 5 秒以内、上限 60 秒）。準備できると標準エラーに `ready: web http://127.0.0.1:<ポート>/` を出し、標準出力に run のフォルダ `e2e/.e2e/verify/<時刻>-<ポート>/` を出します。失敗したら `$RUN/serve.log` を読みます。前提は `pnpm install` 済みであることと、`playwright-cli` が PATH にあることです。

台本の件数は、`start` の後に helper が流す発言の数です。4 件は 2 件が確定してノードになり、2 件が途中結果として字幕に残ります。

## 2. Doctor

```sh
bash $S/doctor.sh "$RUN"
```

何も変えずに、PID が生きている・run-info がある・web のポートをその PID が持っている・web が 200・server が `status` に答える・serve.ts がこの worktree から立っている・`playwright-cli` がある、を `ok` / `NG` で出します。1 つでも `NG` なら終了コード 1 です。何かおかしいと思ったら最初にこれを流します。`NG` のまま操作を続けず、`stop.sh` で片付けて立て直します。

## 3. 操作する

- **画面:** `bash $S/browser.sh "$RUN" <playwright-cli のコマンド>`。セッション名 `verify-<ポート>` の headless の Chromium を使います。最初に `open "http://127.0.0.1:$P/"`、以降は `snapshot`・`click <ref>`・`press <key>`・`eval <式>`・`screenshot --filename shots/<名前>.png`。要素は `snapshot` の role と名前（例 `button "字幕"`、`slider "時刻"`）で探し、その `ref` を渡します。座標や並び順には頼りません。
- **CLI:** `bash $S/cli.sh "$RUN" <サブコマンド> [引数...]`。この run の server のポートとセッションのフォルダを環境変数で渡し、設定ファイルと既定のモデルは読ませません。会議アプリは台本にある `us.zoom.xos` だけです（`start --app us.zoom.xos`）。
- **セッションのフォルダ:** `cat "$RUN/sessions-dir"`。書き出しや `log.jsonl` はここにできます。画面からは `http://127.0.0.1:$P/session-files/<セッション名>/<ファイル>` で開けます（`.html` 以外は text/plain）。

機能ごとの手順は [`features/README.md`](features/README.md) から辿ります。変えた振る舞いに当たる機能の入り口は、地図に並ぶものをすべて通します。都合のよい 1 つだけを通した結果を、その機能を確かめたとは報告しません。

## 4. 証拠

run のフォルダ `e2e/.e2e/verify/<時刻>-<ポート>/`（gitignore 済み）に残ります。片付けても消えません。

| 中身 | 置き場 |
|---|---|
| CLI の標準出力・標準エラー・終了コード | `cli/<連番>-<サブコマンド>.{out,err,code}`（`cli.sh` が書く） |
| 画面の写し | `shots/`（`screenshot --filename shots/...` で自分で撮る） |
| 画面の構造（ARIA の snapshot）とコンソール | `.playwright-cli/page-*.yml`・`console-*.log`（`browser.sh` の `snapshot` が書く） |
| セッションのフォルダ（`log.jsonl`・`map.md`・`map.json`・`map.drawnix`・`map.html`・録音の代わりの小さなファイル） | `sessions/`（`stop.sh` が止める前に写す） |
| server と web のログ | `serve.log` |

証拠の基準:

- 利用者と同じ入り口を通します。CLI のサブコマンドと画面の操作だけを使い、server の内部や WebSocket に直接書き込みません。
- 操作の前と後の両方を残します。最後の画面だけでは足りません。
- 画面に出たことと、残ったもの（`sessions/` の `log.jsonl`・`map.*`）の両方を見ます。
- 差し替えてよいのは helper と差分更新の 2 つだけです（どちらも本番で別プロセス・外の API の向こうにある境界）。

## 5. 片付ける

```sh
bash $S/stop.sh "$RUN"
```

セッションのフォルダを `$RUN/sessions/` へ写してから、この run の playwright-cli のセッションを閉じ、`$RUN/pid` の PID だけに SIGTERM を送り、web のポートが空いたことを確かめます。serve.ts は終わるときに一時フォルダと run-info を消し、helper も止めます。プロセス名（`pkill node` など）では止めません。利用者の server やほかの run まで止まります。失敗した試みの後も、必ず `stop.sh` を流してから立て直します。

## 地図を保つ

画面・CLI・台本が変わって地図の手順が合わなくなったら、pstack の `/pstack:maintain-verification-skill` で `features/` を直します。
