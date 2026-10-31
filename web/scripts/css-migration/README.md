# CSS移行の表示を照合する

Issue #1830・後続の移行と撤去で使う一時的な手動の道具。移行が終わったら、このディレクトリとfallowの除外を撤去する。CI・package scripts・typecheckには追加しない。新しい依存は不要。

## 採取して比較する

Node 24以上、lockfileどおりの依存とmanaged Chromiumを用意する。

```sh
pnpm install --frozen-lockfile
pnpm --filter @live-mindmap/server deps:install chromium
git fetch origin main
git rev-parse origin/main
```

表示されたSHAを記録し、そのコミットの別チェックアウトを用意する。そのチェックアウトにも同じlockfileの依存を導入する。以降はこのブランチのrepo rootで実行する。比較元は実際のmainのソースからビルドする。古いCSSをブランチのDOMへ当てる方式は使わない。

```sh
node web/scripts/css-migration/capture.mjs /path/to/main-checkout MAIN_SHA /path/to/before.json
node web/scripts/css-migration/capture.mjs . BRANCH_SHA /path/to/after.json
node web/scripts/css-migration/compare.mjs /path/to/before.json /path/to/after.json /path/to/diff.json
```

同じMacで続けて実行する。同じスクリプト・依存・managed Chromiumを使う。各JSONはrevision、対象ソースのSHA-256、ブラウザと実行環境、場面ごとの全要素のcomputed style・矩形を持つ。変更中の採取ではrevisionの引数にSHAと作業コピーであることを記す。

採取は場面ごとに新しいbrowser contextを作る。幅と高さは1280×800と390×844。localeはja-JP、timezoneはAsia/Tokyo、color schemeはlight。画面・context・サーバー・一時HTMLは終了時に閉じ、採取JSONは残す。

## 場面と操作

全行を両方の幅で採取する。見返しは対象チェックアウトの `buildReviewTemplateHtml` でビルドし、既存の `prepareReviewPages`・`openReviewPage` で音声なしページを開く。入力は `web/test/fixtures/sampleMeeting.log.jsonl`。

| 場面名 | データ・操作と採取する状態 |
|--------|--------------------------|
| review/initial | 開いた直後。狭幅の側面板は初期状態のまま隠す |
| review/rate | 「再生の速さ」を押し、速さメニューの表示を待つ |
| review/keys | ?を押し、キー一覧の表示を待つ |
| review/folded | 初期ログの「開く」ボタンがある畳んだノード |
| review/opened | 最初の「開く」を押し、「畳む」ボタンの出現を待つ |
| review/side | 画面内の最初のノードを選び、「右の列」が隠れていればボタンで開いて根拠を表示する |
| meeting/captions | `meetingFrames().first`、Cで必要なら字幕を表示し、`spokenFrame`の確定済み字幕を投入する |
| meeting/notices | 字幕ありの状態に `intake: interrupted` と `NOTICE_FRAMES.screen/tap` を投入し、3つの知らせを待つ |
| meeting/side | `meetingFrames().first`で開き、画面内の最初のノードを選ぶ。狭幅では根拠シートになる |
| meeting/todo | capture.mjsの固定snapshotを投入して論点を選ぶ。根拠の種別・状態・発言、TODOの時刻・担当・期限・長い本文、変更一覧を広幅で観測する。狭幅では既存CSSにより根拠シートだけが見える |

会議中は既存の `startMeetingServer`・`openMeetingPage`・WebSocket frame投入を使う。サーバーのrootには対象チェックアウトのwebを渡す。補助・入力・操作は両採取で共通とし、対象のアプリとCSSだけを替える。

## 採取条件と差分を読む

`document.fonts.ready`、カメラの安定、フォーカス解除、`document.getAnimations().length === 0`の順に待つ。ポインタは0,0へ移す。フォントとアニメーションはそれぞれ10秒の期限を持ち、条件を満たさなければ条件名を出して非0で終了する。アニメーションを無効化したりfinishしたりせず、字幕には無限カーソルのない確定済み入力を使う。

全要素をDOMの順序・パス・タグで対応させる。クラス文字列は対応キーにしない。computed styleはカスタムプロパティを含めて全件を厳密比較し、矩形だけ0.5px以内を許容する。要素や場面の欠落、表示テキストの差も報告する。script・styleのソース文字列は表示テキストに含めないが、その要素のcomputed styleと矩形は採取する。

`compare.mjs`は差分0で終了コード0、差分あり・入力エラーで非0を返す。diff.jsonに場面・要素・プロパティ・両値が出る。環境差も差分になる。差分を除外せず、理由を実装報告へ記録する。

比較処理の手動確認では、矩形100と100.4を差分0、100と100.6を差分ありとする。同じ100pxと100.4pxのcomputed styleは差分ありにする。待機の失敗確認では、読取前のページでfonts.readyを未解決Promiseにする場合と、無限アニメーションを作る場合を別々に実行し、条件名と終了状態を確認する。
