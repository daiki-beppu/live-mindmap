# 見返し用のマップを 1 ファイルの HTML にする方法とデータの持ち方（Issue #298）

見返し用のマップ（`map.html`。サーバーなしで開ける 1 ファイルの HTML）を、ライブと同じ画面の部品で作れるか、作れるならデータをどう持つかを調べた（地図は #297）。161 分の parnassus のログで重さを実測し、試しに 1 ファイルの HTML を作って `file://` で開いた。結論は次のとおり。

- **作れる。** Vite のビルドに `vite-plugin-singlefile`（2.3.3。Vite 8 に対応）を足すと、JS・CSS が HTML の中に入った 1 ファイルになる。試作の画面（`prototype-long-meeting`）をこれでビルドし、parnassus のログを差し込んだ HTML を Chromium の `file://` で開くと、エラーなしで描け、コマ送りで時刻も戻った。通常のビルド（JS・CSS が別ファイル）は、`file://` では CORS で読み込めず、何も描かれなかった。
- **データは (a) ログをそのまま埋め込むのがよい。** parnassus のログは **0.32 MB**（340,660 バイト）。画面の部品は 1 ファイルで **0.41 MB**（ライブの画面 417.0 KB・試作の画面 448.3 KB）。合わせて **約 0.75〜0.8 MB**（試しに作った HTML は 811,854 バイト）。圧縮は要らない。
- (b) 全反映のスナップショットを素直に並べると **41.45 MB**（`Snapshot` そのまま）、発言を 1 回にまとめても **9.01 MB**。ノードの版を共有する形に作り直すと **0.57 MB** まで縮むが、それでもログより重く、書き出しと読み込みの形を新しく作ることになる。
- ブラウザの中で core の `restoreSession` を動かせる（main の core を単体でビルドすると 74.5 KB）。全体の復元は約 40 ms、各時点を毎回先頭から作り直しても 1 時点あたり最大でも全体の復元と同程度（255 時点の合計 1.9 秒）。
- **音声の時刻に合わせられる。** 発言の `start` / `end` は会議の中の秒で、録音（`相手.m4a`・`自分.m4a`）の 0 秒と同じ起点。各反映の時刻は、渡した発言の `end` の最大値として core が導く（`ChangeEntry.at`）。ログの各行の `at`（壁時計）は、`play` では会議の時刻と一致しないので使わない。
- **書き出しへの組み込みは、`map.png` と同じく書き出しのときに Vite でビルドする案が手間が少ない。** ビルドは 1 回 0.3 秒ほどで、今の「ビルドの手順を持たない」前提（`server/src/capture.ts`）を崩さない。事前にビルドした HTML にデータを差し込む案は、書き出しは速いが、ビルドの手順と古いビルドの扱いが増える。

## 調べ方

- 素材: parnassus（161 分の会議）の試作の出力 `log.jsonl`（`start` 1・`remark` 510・`diff` 255 行。最後の発言の `end` は 9642 秒）。gitignore 済みの素材で、リポジトリには入れていない。中身の文字はこの文書に載せていない。
- 重さの計測: core の `restoreSession` で、`diff` ごとにその行までを復元し（試作の `frameAt` と同じ作り方）、各形の JSON のバイト数を Node の `zlib`（gzip level 9・brotli quality 11）で測った。core は main（`5785fe9`）と `prototype/camera-return` の両方で測り、値は全桁で同じだった。
- ビルド: Vite 8.3.2・`@vitejs/plugin-react`・`vite-plugin-singlefile` 2.3.3 で、`web/` の `index.html`（ライブの画面）と `prototype-long-meeting.html`（試作の画面）を、通常のビルドと single-file のビルドの両方で作った。プラグインはリポジトリに入れず、スクラッチの場所に入れて使った。
- 開いて確かめる: Playwright の Chromium 153（ヘッドレス）で `file://` から開き、コンソールのエラー・失敗した読み込み・描かれたノード数を見た。試作の画面は `fetch('/proto-long/...')` でログを読むので、試しに「`<script type="application/json">` があればそれを読む」2 行を一時的に足してビルドし、その HTML にログを差し込んだ（変更は commit していない）。
- Firefox・Safari は確かめていない（この環境に Playwright のそれらのブラウザが入っていない）。

## 1. 1 ファイルの HTML にする方法

### Vite だけでは 1 ファイルにならない

Vite のビルドの設定には、JS を HTML に入れる設定はない。`build.assetsInlineLimit` は、しきい値より小さい画像などを base64 の URL にするもので、`build.cssCodeSplit: false` は CSS を 1 つのファイルにまとめるもの（[Vite: Build Options](https://vite.dev/config/build-options)）。

### vite-plugin-singlefile

[vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) は、ビルドの後に JS・CSS を `index.html` の中へ入れ、「1 つの HTML ファイルだけを作り、他のファイルは作らない」。制約は README のとおり、入口は 1 つだけ・History API のルーティング不可・cookie 不可・ソースマップは使えない。見返しの画面はどれにも当たらない。

既定（`useRecommendedBuildConfig: true`）で、次の設定を Vite に足す（インストールした 2.3.3 の `dist/esm/index.js` で確認）。

- `build.assetsInlineLimit = () => true`（画像などもすべて data URL に）
- `build.cssCodeSplit = false`
- `base = "./"`
- Vite 8（Rolldown）では `codeSplitting: false`、それより前は `inlineDynamicImports: true`（動的 import も 1 つにまとめる）

peerDependencies は `vite: ^5.4.21 || ^6 || ^7 || ^8`。このリポジトリの Vite 8.3.2 で、警告なくビルドできた。

| ビルド | 出力 | 素のまま | gzip |
|---|---|---|---|
| ライブの画面・通常 | `index.html` + JS 398.4 KB + CSS 18.2 KB | 417.0 KB（3 ファイルの合計） | 128.4 KB |
| ライブの画面・single-file | `index.html` 1 つ | 417.0 KB | 128.2 KB |
| 試作の画面・通常 | `prototype-long-meeting.html` + JS 427.2 KB + CSS 20.7 KB | 448.3 KB（3 ファイルの合計） | 139.0 KB |
| 試作の画面・single-file | HTML 1 つ | 448.3 KB | 138.9 KB |
| core の `restoreSession` だけ（main） | HTML 1 つ | 74.5 KB | 25.2 KB |

ライブの画面は main（`5785fe9`）、試作の画面は `prototype/camera-return`（`c82e13f`）でビルドした。ほとんどは React・React DOM・React Flow で、試作の画面には core（`restoreSession` を含む）も入っている。main の core は `effect` の `Schema` を使うようになったが、`restoreSession` を単体でビルドしても 74.5 KB だった。single-file にすると、JS は `<script type="module" crossorigin>` の中身として HTML の `<head>` に入る。

### file:// で開いて動くか

| 開いたもの | 結果（Chromium 153） |
|---|---|
| 通常のビルドの `index.html` | 何も描かれない。`Access to script at 'file:///assets/index-….js' from origin 'null' has been blocked by CORS policy`（CSS も同じ） |
| single-file のビルド + ログを差し込んだ HTML | エラーなし。最初のノードが出るまで 161 ms。`[` を 2 回押すと時刻が 89:50 → 87:55 に戻り、描くノードも変わった |
| どちらのページでも `fetch(location.href)` | `TypeError: Failed to fetch`（`Fetch API cannot load file:///…. URL scheme "file" is not supported`） |

- 外のファイルの module script は、HTML の仕様で CORS つきで読み込まれる。`file://` のページの origin は `null` で、`file:` の URL の取得は Fetch の仕様で実装に任されている（「For now, unfortunate as it is, file: URLs are left as an exercise for the reader.」[Fetch Standard: scheme fetch](https://fetch.spec.whatwg.org/#scheme-fetch)）。Chromium は上のとおり断る。中身を HTML に入れた module script は取得をしないので、この制約に当たらない。
- **データも `fetch` では読めない。** HTML の中に入れる。試作の `loadMeeting` の `fetch` は、HTML の中のデータを読む形に変える必要がある。
- Worker は今の `web/src/` で使っていないので確かめていない。

### データを HTML に入れる形

`<script type="application/json" id="…">` に入れ、`JSON.parse(el.textContent)` で読む。`type` が JavaScript でも `module` でもない `<script>` は「データブロック」で、ブラウザは実行せず、ページのスクリプトが読む（[HTML Standard: the script element](https://html.spec.whatwg.org/multipage/scripting.html#the-script-element)）。中身に `</script` や `<!--` があると HTML のパーサーが誤読するので、`<` を `<` に置き換えて入れる（JSON の文字列としてそのまま読める。仕様の勧めは `\x3C` への置き換え: [Restrictions for contents of script elements](https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements)）。発言の全文は人の発話なので、この置き換えは必ず要る。試しに作った HTML もこの形で入れた。

## 2. データの持ち方と重さ（parnassus・161 分）

| 形 | 素のまま | gzip | gzip を base64 にしたもの |
|---|---|---|---|
| (a) `log.jsonl` そのまま | **0.32 MB**（340,660） | 82 KB | 109 KB |
| (a') ログから壁時計の `at`・`recent`・`nodeCount`・`dropped` を除く | 0.29 MB（300,606） | 75 KB | 100 KB |
| 　うち発言だけ（510 件、全文） | 0.17 MB（181,524） | 53 KB | 70 KB |
| (b1) 全反映（255 時点）の `Snapshot` をそのまま並べる | **41.45 MB**（43,468,365） | 11.3 MB | 15.1 MB |
| (b2) 発言は 1 回だけ + 各時点の `nodes` 全体 + その回の `changes` | **9.01 MB**（9,446,809） | 1.95 MB | 2.6 MB |
| (b3) 発言は 1 回だけ + ノードの版の表（581 版）+ 各時点は版の番号の並び | **0.57 MB**（594,906） | 104 KB | 139 KB |
| 　(b3) のうち発言を除く | 0.39 MB | 52 KB | 69 KB |
| 参考: 最後の時点の `Snapshot` 1 つ | 0.33 MB | 92 KB | 122 KB |

（括弧内はバイト数。MB は 1,048,576 バイト。最後の時点はノード 474・`changes` 580・根拠の発言 494。）

- (b1) が重いのは、`Snapshot` の `changes`（反映の履歴）と `remarks`（根拠の発言）が時点ごとに積み上がって、毎回まるごと入るため。(b2) でも、各時点がノード全体を持つので、時点の数 × ノードの数で重くなる（会議が長いほど 2 乗に近く増える）。ログは発言と反映の数に比例して増える（parnassus で 1 分あたり約 2.1 KB。3 時間で約 0.4 MB）。
- gzip は窓が 32 KB なので、時点をまたぐ繰り返し（数百 KB 離れた同じノード）を縮められない（b1 は 11.3 MB にしか縮まない）。brotli は (b1) を 85 KB まで縮めたが、ブラウザの中で解くには `DecompressionStream("brotli")` が要る。Compression Streams の仕様には 2026-04-20 の版で `brotli` が載っている（[Compression Streams](https://compression.spec.whatwg.org/)）が、Chromium 153 では `new DecompressionStream("brotli")` が `TypeError` だった（`gzip`・`deflate`・`deflate-raw` は通る）。今は gzip しか当てにできない。
- (a) を gzip + base64 で入れると 0.32 MB → 109 KB になるが、HTML 全体は 0.75 MB → 0.53 MB ほどにしかならない（画面の部品が 0.41 MB ある）。読み込みが非同期になり、HTML を開いて中を見ることもできなくなる。この重さでは割に合わない。

### (a) をブラウザの中で動かす速さ

main の core の `restoreSession` を単体でビルドし、ログを差し込んだ HTML を Chromium の `file://` で開いて測った（各 1 回）。

| 処理 | 時間 |
|---|---|
| 埋め込んだログを `JSON.parse` で読む | 1.2 ms |
| 最後の時点まで 1 回で復元 | 41.6 ms |
| 255 時点をそれぞれ先頭から復元し直す（試作の `frameAt` と同じ） | 合計 1,884 ms（1 時点あたり最大でも 1 回の復元と同程度） |

開いた直後は最後の時点を出すので、1 回の復元（約 40 ms）で済む。シークやコマ送りで 1 時点ずつ先頭から作り直しても 1 回あたり数十 ms で、試作の画面でも引っかかりは見えなかった。全時点を前もって作るなら、`restoreSession` を 255 回呼ぶより、ログを 1 回なめながら各 `diff` の後の状態を取る方が速い（core に手を入れる話なので、実装で決める）。

### (a) を推す理由

- 一番軽い（(b3) より 0.25 MB 軽く、(b1)・(b2) とは桁が違う）。
- ログはすでにセッションの正本で、`restore` も評価もこれを読む。新しいデータの形を作らずに済み、`export.json` との食い違いも起きない。
- 書き出しのときに画面ごとビルドするなら、HTML に入る core と、ログを書いた core は同じ版になる。過去のセッションから作り直す場合も、今の core が古いログを読めればよい（`restore` と同じ前提。`LogEvent` は余分なキーを厳格にしない）。
- 済み（閉じる）は main では差分操作としてログに入るので、ログだけで畳むところまで再現できる（ADR 0005「ログには閉じるだけを残せば復元・再生できる」）。parnassus のログは試作の頃のもので、済みは別のファイル（`closes.jsonl`、約 12 KB）にあった。

(b) が有利になるのは、HTML の中で core を動かしたくない場合（画面の部品だけで描きたい、復元の計算を見る側に持たせたくない）だけ。そのときは (b3) の形にする。

## 3. 音声の時刻に合わせられるか

合わせられる。新しい項目は要らない。

- 発言の `start` / `end` は会議の中の秒（`server/src/core/session.ts` の `Remark`）。録音の 0 秒は、発言の `start` / `end` の 0 秒（音声取得を始める直前）と同じ（`helper/README.md` の `--audio-dir`）。
- 各反映の時刻は、core が「その反映に渡した新しい発言の `end` の最大値」として導き、`ChangeEntry.at` に載せる（`session.ts` の `recordRound`）。ログの `diff` 行はこの時刻を持たないが、`input.fresh` の ID から発言の `end` を引けば同じ値になる（試作の `loadMeeting` の `diffAt` もこの作り方）。
- ログの各行の `at` は、書いたときの壁時計（`server/src/cli.ts` の `startRecordedSession`）。ライブでは会議の時刻とほぼ並ぶが、`play` では速く流すので一致しない。parnassus は 161 分の会議が壁時計で約 20 分に収まっていた。シークバーの時刻には使わない。
- 反映が画面に出た時刻（AI の呼び出しの遅れを含む）を再現したい場合だけ、ライブのセッションに限って壁時計の `at` から開始の `at` を引く手がある。録音の 0 秒と開始の行の `at` がどれだけずれるかは測っていない。

## 4. 書き出しの手順への組み込み

今の書き出しは `server/src/cli.ts` の `writeSessionExports` が md・json・drawnix を書き、`map.png` は `server/src/capture.ts` がその場で web の Vite を立て、Playwright で撮っている（「常に今のソースで描くため、web の Vite をここで起動する（ビルドの手順を持たない）」）。呼ぶのは `stop`（`server/src/server.ts`）と `play`（`cli.ts`）。

| 案 | すること | 書き出しの時間 | 手間 |
|---|---|---|---|
| A. 書き出しのときにビルドする | Vite の `build()` を single-file の設定で呼び、出てきた HTML にログを差し込んで `map.html` に書く | ビルド 0.27〜0.37 秒（3 回、Node から `build()` を呼んだ全体の時間） | 小。`capture.ts` と同じ前提（web のソースと Vite が実行時にある）のまま。依存に `vite-plugin-singlefile` を足すか、同じことをする小さなプラグイン（JS・CSS のタグを中身で置き換える）を持つ |
| B. 事前にビルドした HTML に差し込む | `pnpm -C web build` などで、データの場所を空けた HTML を作っておき、書き出しでは文字列を差し込むだけ | ほぼ 0（ファイルの読み書きだけ） | 中。ビルドの手順が増え、web を変えた後にビルドし忘れると古い画面で書き出す。ビルドの結果は生成物なので commit しない前提で、無いときの扱いも要る |
| C. A の結果をとっておく | A でビルドした HTML を、web のソースのハッシュをキーに置いておき、次からは差し込むだけ | 初回 0.3 秒・2 回目から ほぼ 0 | A より少し多い。0.3 秒のために作る理由は今は無い |

- A を勧める。0.3 秒は Playwright で `map.png` を撮る時間より十分短く、ビルドの手順を増やさない。`map.png` と違ってブラウザは要らないので、Chromium が無くて png が書けない環境でも `map.html` は書ける。
- 入口は今の `index.html`（`main.tsx` がグローバル変数の有無で `CaptureView` と `App` を切り替えている）に足すか、見返し用の HTML を別に作るか。single-file は入口 1 つの HTML しか作らないので、見返し用の入口を別にするなら、その HTML を `build.rollupOptions.input` に指定して 1 回ビルドする（今回の試しも試作の HTML をこうしてビルドした）。
- 過去のセッションから作り直すときも、そのフォルダの `log.jsonl` を読んで同じ手順で書ける。`restore` が `log.jsonl` から `export.json` を作り直すのと同じ形。

## 5. 試した条件と、確かめていないもの

- 計測は各 1 回。サイズは決定的（同じ入力で同じ値）。時間はこの Mac（Apple Silicon、Node 26.9.0）でのもの。
- 開いて確かめたのは Chromium 153（ヘッドレス）だけ。Firefox・Safari の `file://` は確かめていない。中身を入れた module script とデータブロックは取得をしないので動くはずだが、未確認。
- ライブの画面（`index.html`）を single-file にしたものは、`file://` でサイズを測っただけで、データを入れて描いてはいない（入口の `App` は WebSocket につなぐ作りで、見返し用の入口がまだ無い）。描けることは、同じ部品を使う試作の画面で確かめた。
- 試作の画面は parnassus の試作の頃のログ（済みが別ファイル）で確かめた。main の core と、閉じるが入った今のログの組み合わせで描いてはいない（main の core の `restoreSession` が、このログを Chromium の中で復元できることは確かめた）。
- 録音の 0 秒と、ログの開始の行の壁時計の `at` のずれは測っていない。

## 出典

- Vite: [Build Options](https://vite.dev/config/build-options)（`build.assetsInlineLimit`・`build.cssCodeSplit`）
- [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile)（README。設定の中身は npm の 2.3.3 の `dist/esm/index.js`）
- HTML Standard: [the script element](https://html.spec.whatwg.org/multipage/scripting.html#the-script-element)（データブロック）・[Restrictions for contents of script elements](https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements)
- Fetch Standard: [scheme fetch](https://fetch.spec.whatwg.org/#scheme-fetch)（`file:` の扱いは実装に任される）
- Compression Streams: [Compression Streams Standard](https://compression.spec.whatwg.org/)（`CompressionFormat`）
- このリポジトリ: `server/src/cli.ts`（`writeSessionExports`・`startRecordedSession`）、`server/src/capture.ts`、`server/src/core/session.ts`（`restoreSession`・`recordRound`・`LogEvent`）、`helper/README.md`（`--audio-dir`）、`docs/adr/0005-close-topics-instead-of-splitting-map.md`、`web/src/main.tsx`、`prototype/camera-return` の `web/src/prototype-long-meeting/data.ts`
