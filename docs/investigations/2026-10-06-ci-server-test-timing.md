# server テストの所要時間の偏り（Issue #219）

`pnpm --filter @live-mindmap/server test` が CI（macos-26）で 73〜81 秒かかる原因を、ファイル別・テスト別に測った（map #217）。結論は次のとおり。

- **時間はほぼ `test/server.test.ts` の 1 ファイルで決まる。** 手元 80〜87 秒、CI 72〜80 秒で、server テスト全体の所要（手元 81〜88 秒、CI 72〜80 秒）とほぼ同じ。ほかのファイルは並行に走って、その陰に隠れている。
- **`vitest --shard` では何分割しても 30 秒にならない。** vitest のシャードはファイル単位で、ファイルの中のテストは分けない。`server.test.ts` を含むシャードは、何分割でも 73〜81 秒のまま残る。
- **2 番目は `test/eval.test.ts`（手元 25〜28 秒、CI 29〜53 秒）。** この時間はほぼ全部 Chromium の起動にかかっている。`play` に偽の撮影を渡していないので、`runCli` が実物の `captureMap` を使う。Chromium が無い環境では撮影の失敗を警告として流し、47 件すべて通って 0.8 秒で終わる。
- **30 秒程度に収めるには、`server.test.ts` をテスト単位で分けるしかない。** 分け方は 2 つ。describe ごとに `-t` で分けると、各ジョブは 44 秒と 35 秒になる（30 秒には届かない）。ファイルを 3 つに分けると、各 27 秒程度にできる見込み（1 件で最大のテストは 10.5 秒）。
- **重いグループは同じジョブに入れず、ジョブ（ランナー）を分ける。** 手元で 3 つの vitest を同時に走らせると、`server.test.ts` の半分が 44 秒から 77 秒に延びた（`eval` と `capture` の Chromium と競合したため）。
- vitest の起動と collect のオーバーヘッドは約 1 秒で、無視できる。

## 測り方

- 手元: Apple M4（10 コア）、Node 26.9、vitest 5.0.3。origin/main（`4919de6`）で `pnpm install --frozen-lockfile` を実行してから、`server/` で `pnpm exec vitest run --reporter=json --reporter=default --outputFile.json=…` を 3 回続けて実行した。設定は `vitest.config.ts` のまま（`testTimeout: 20_000`、pool の既定値）。
- ファイルの所要は JSON の `testResults[].endTime - startTime` で、テストの所要は `assertionResults[].duration` で取った。表の値は 3 回の中央値（ファイル別は最小/中央値/最大も示す）。
- CI: main の push の 3 回（run 37435208768・37436755505・37439277597、いずれも success）を `gh run view --log` で取得した。既定のレポーターが出すファイル別の行（`✓ test/x.test.ts (n tests) NNNNms`）と、300 ms 以上かかったテストの行を読んだ。
- シャードの割り当ては vitest 5.0.3 の `BaseSequencer.shard` の実装（`node_modules/vitest/dist/chunks/index.DpLw24bj.js`）から計算した。各ファイルを `/test/x.test.ts` の sha1 で並べ、`calculateShardRange` で順に均等な件数ずつ切る。計算した 1/3 の中身を、`vitest run --shard=1/3` の実際の中身と照合して一致を確かめた。

## ファイル別

| ファイル | テスト数 | 手元 最小/中央/最大（秒） | CI 3 回（秒） | Chromium |
|---|---|---|---|---|
| `server.test.ts` | 51 | 80.0 / 80.6 / 87.0 | 72.2 / 79.7 / 73.8 | 1 件だけ実物の撮影 |
| `eval.test.ts` | 47 | 24.7 / 27.6 / 27.9 | 29.1 / 52.6 / 35.5 | 使う（暗黙。下記） |
| `capture.test.ts` | 7 | 6.4 / 6.9 / 7.9 | 5.5 / 9.1 / 5.5 | 使う（全件） |
| `ws.test.ts` | 21 | 0.7 / 0.8 / 0.8 | 0.7 / 0.7 / 0.7 | — |
| `cli.test.ts` | 22 | 0.5 / 0.5 / 0.6 | 0.4 / 0.6 / 0.5 | —（偽の撮影） |
| `session.test.ts` | 54 | 0.2 | 0.2 | — |
| `helperSocket.test.ts` | 2 | 0.1 | 0.1 | — |
| 残り 12 ファイル | 186 | 各 0.1 未満 | 各 0.1 未満 | — |
| **vitest の Duration（全体）** | 386 | 81.3 / 87.6 / 81.0 | 72.5 / 80.1 / 74.2 | |

- 手元と CI の差は小さい。`server.test.ts` は CI の方がやや速いこともある。偽のヘルパーの起動、`QUIET_MS`（1.5 秒）、`HELPER_STOP_TIMEOUT_MS`（5 秒）など固定の待ちが大半を占めるからである。CPU の差が効くのは Chromium を起動する `eval` と `capture` で、CI の `eval` は 29〜53 秒と大きくばらついた。
- ファイル単位の合計（中央値）は約 117 秒。並行に走るので、全体はいちばん長い `server.test.ts` で決まる。
- 起動と collect: 1 ファイルだけ（`sessionStats.test.ts`）を実行すると Duration 0.33 秒、プロセス全体で 1.3 秒だった。全体の実行でも、最初のファイルが始まるのは開始から 0.5〜0.8 秒後。Duration の内訳は tests 96〜99%、transform と import が 1〜2% である。

### `server.test.ts` の describe 別

| describe | テスト数 | 単独で `-t` 実行（手元、秒） | テストの合計（全体の実行、中央値） |
|---|---|---|---|
| `ライブのセッション`（`録音` を含む） | 35 | 44.2 / 44.7 | 48.0 |
| `ヘルパーが予期せず終わったときの、起動し直し・諦め・resume（Issue #161）` | 16 | 37.2 / 34.4 | 32.5 |

- この 2 つを同時に（別プロセスで）実行しても、所要は 44.7 秒と 34.4 秒で、互いにほぼ干渉しなかった。
- ここに「`server.test.ts` 以外の全部」（`eval` と `capture` で Chromium を起動する）を 3 つ目のプロセスとして加えると、77.1 秒と 66.2 秒に延びた。3 つ目自体も 57.3 秒かかった（単独なら `eval` の 27 秒程度）。

## 遅いテスト（上位。秒は手元 3 回の中央値 / CI 3 回の中央値）

| 秒（手元 / CI） | ファイル | テスト |
|---|---|---|
| 10.48 / 10.51 | server | ヘルパーが SIGTERM で終わらなくても、stop は時間内に戻り、それまでの発言でマップを確定して 4 つのファイルを書き、SIGKILL に切り替えたことを標準エラーに残す。同じサーバーで次のセッションも開始・終了できる |
| 6.23 / 6.14 | server | 起動し直した後に SIGTERM で終わらないヘルパーを SIGKILL で止めると、警告はその起動回（attempt 2）の録音ファイル名を示す（SCN-U-C-P1） |
| 5.21 / 5.24 | server | ヘルパーが SIGTERM で終わらなくても、サーバーの close は時間内に戻り、子プロセスを残さない |
| 3.25 / 3.07 | server | 確定結果が来なくても、相手の途中結果は 1 秒更新されなければ、最後の本文・区間で発言が 1 件、差分更新に渡る… |
| 3.02 / 2.93 | server | 予期せず終了すると、同じセッション（同じフォルダ・同じ log.jsonl・同じマップ）へ起動し直す… |
| 2.96 / 2.77 | server | 出した後に届いた確定結果は捨てる。発言は増えず、次の発言の ID は r2 で番号が飛ばない |
| 2.45 / 2.26 | server | 止まった状態から resume すると、失敗の数を 0 から数え直してヘルパーを起動し直し… |
| 2.45 / 2.22 | server | 1 回目の名前（相手.m4a・自分.m4a）は変えず、2 回目以降は -2・-3 の番号が付き… |
| 2.26 / 2.05 | server | stop の前に発言が 1 件だけ届き QUIET_MS 新しい発言が来ないとき… |
| 2.21 / 2.81 | server | ブラウザ（WebSocket のクライアント）を 1 つも開いていなくても、stop で map.png が書き出される（実物の撮影） |
| 1.91 / 2.63 | eval | ルートを除くノード数、ルートの子を 1 とする深さ、6 種別ごとの数… |
| 1.78 / 2.74 | eval | 全角・半角と空白の違いで外れない… |

- 上位 3 件は、SIGTERM を無視するヘルパーを `HELPER_STOP_TIMEOUT_MS`（5 秒）待ってから SIGKILL するテストで、合計約 22 秒になる。
- 分布（手元の中央値）: 2 秒以上が 10 件で 40.5 秒、1 秒以上が 35 件で 78.4 秒、0.5 秒以上が 67 件で 100.9 秒。386 件のうち残り約 320 件は、合わせて十数秒にしかならない。
- 一覧は記録のためのもので、テストを速くする改修は map #217 の範囲外。

## Chromium（playwright）を使うテスト

- `capture.test.ts`: 全 7 件が実物の `captureMap` と `withCapturePage` を使う。
- `server.test.ts`: 「ブラウザ…を 1 つも開いていなくても、stop で map.png が書き出される」の 1 件だけが、実物の `captureMap` を渡す（`server/test/server.test.ts` 245 行付近）。ほかのテストは `fakeCapture` を使う。
- `eval.test.ts`: 暗黙に使う。`play()`（`server/test/eval.test.ts` 35 行）は `runCli(["play", …])` に `capture` を渡していない。このため `server/src/cli.ts` 161 行の `deps.capture ?? (await import("./capture.ts")).captureMap` で、実物の撮影に落ちる。`play` を呼ぶ箇所は 17 か所ある。
  - 確認: `PLAYWRIGHT_BROWSERS_PATH` を空のディレクトリにして `vitest run test/eval.test.ts` を実行すると、「map.png を書き出せませんでした: Chromium を起動できません」という警告が出る。それでも 47 件すべて通り、Duration は 0.78 秒だった（Chromium がある場合は 25〜28 秒）。
- `cli.test.ts` は偽の撮影を使っていて、Chromium は要らない。

## シャード数の検討

### `vitest --shard=i/N`（ファイル単位、sha1 順）の場合

| N | `server.test.ts` のシャード（手元 / CI） | `eval.test.ts` のシャード | ほか |
|---|---|---|---|
| 2 | 80.6 / 73.8（`capture` と同居） | 27.6 / 35.5（`cli` と同居） | — |
| 3 | 80.6 / 73.8（`capture` と同居） | 27.6 / 35.5 | 1 本は 0.5 秒 |
| 4 | 80.6 / 73.8（`capture` と同居） | 27.6 / 35.5 | 2 本は 1 秒未満 |
| 5 | 80.6 / 73.8 | 27.6 / 35.5 | 3 本は 7 秒以下 |

- N を増やしても、いちばん遅いシャードは `server.test.ts` の 73〜81 秒から下がらない。
- 割り当てはファイル名の sha1 で決まるので、ファイルを足したり改名したりすると組み合わせが変わる。重さの釣り合いは取ってくれない。

### 試作（#223）で使うべき分け方

`--shard` ではなく、ジョブごとに対象を明示する（matrix にファイル名や `-t` を並べる）。

- **案 A（テストに手を入れない）: 4 ジョブ。**
  1. `vitest run test/server.test.ts -t "ライブのセッション"`: 約 44 秒。Chromium が要る（1 件）。
  2. `vitest run test/server.test.ts -t "Issue #161"`: 約 35 秒。Chromium は要らない。
  3. `vitest run test/capture.test.ts`: 6〜9 秒。Chromium が要る。
  4. `vitest run --exclude test/server.test.ts --exclude test/capture.test.ts`: `eval` を含む。Chromium を入れなければ 1〜2 秒。入れると 25〜53 秒。
  - いちばん遅いジョブはテスト部分だけで約 44 秒になり、30 秒には届かない。ジョブ全体を 1 分未満にできるかは、セットアップをどこまで縮められるか（#222）による。
  - `-t` は describe 名の部分一致なので、describe を改名すると対象から外れる。2 つのジョブの件数を足して 51 件になるかを確かめる仕組みがあると安全（例えば JSON の件数を集約ジョブで足す）。
- **案 B（ファイルの分割を許すなら）: `server.test.ts` を 3 ファイルに分ける。** テストの中身は変えず、置き場所だけを移す。ヘルパー関数（`setup`・`connect` など）は共通のモジュールに出す。テストの合計 81 秒を約 27 秒ずつに分け、SIGKILL の 3 件（22 秒）は別々のファイルに散らす。`eval` と `capture` を 1 ジョブにまとめ、計 4 ジョブにする。各ジョブのテスト部分は 30 秒程度に収まる見込み。テストの改修にあたるかどうかは、#217 の範囲の判断になる。
- 重いグループ（`server` の各部分、Chromium を起動するもの）は、1 つのジョブの中で並べずにジョブを分ける。手元の測定では、同居させると 1.5〜1.8 倍に延びた。
- `playwright install chromium`（CI で約 10 秒）は、案 A の 1・3 のジョブだけに要る。4 のジョブで `eval` を速くしたいなら、Chromium を入れないか、`PLAYWRIGHT_BROWSERS_PATH` を空の場所に向ける。ただし、これは撮影の失敗が許される経路に頼った回避策である。本筋は、`eval.test.ts` の `play` に偽の撮影を渡すこと（テストの改修なので別 issue）。
- CI と手元の差はほぼ無い（待ちが主体）ので、手元で測った秒数を CI の見積もりにそのまま使ってよい。例外は Chromium を起動するテストで、CI では最大 2 倍程度ばらつく。

## 範囲外として書き残すこと（#217 の Out of scope）

- `eval.test.ts` が Chromium を暗黙に起動している（25〜53 秒）。`play` に `fakeCapture` を渡せば 1 秒未満になる。
- `server.test.ts` の SIGKILL 系の 3 件（10.5・6.2・5.2 秒）は、`HELPER_STOP_TIMEOUT_MS`（5 秒）をそのまま待っている。
