# nyaucast の Effect 4 の書き方から手本にするもの（Issue #199）

map #193（server を Effect 4 へ全面的に置き換える）のための調査。利用者の別プロジェクト nyaucast（`~/ghq/github.com/daiki-beppu/nyaucast`、調べた時点の HEAD は `43ca1e2`）のコードと、そこに入っている `effect@4.0.0`・`@effect/platform-node@4.0.0`（実体は `@effect/platform-node-shared@4.0.0`）の配布物を読んだ。行番号はその時点のもの。nyaucast には手を入れていない。

## 結論

- **nyaucast は Bun だけで配っていない。** ADR-0003 はファイル名（`0003-bun-only-distribution.md`）が昔のままなだけで、2026-08-26 の改訂で「実行は Node、開発時は Node 24 の type stripping で `.ts` を直接実行、テストは vitest（Node）、配布は tsc の emit」に変わった（`docs/adr/0003-bun-only-distribution.md:7`、`:25`、`:27`）。`src/` では `Bun` グローバルと `bun:*` の import を lint で禁じている（`vite.config.ts:29-33`）。つまり**実行環境は live-mindmap と同じ**（Node 24・strip-types・TS 7・vitest 5）で、Bun のせいで持ち込めない書き方は見つからなかった。
- **そのまま手本にできる**: `Context.Service` と `static layer` での service の切り方、Layer を組んで `runMain` を呼ぶのは entry point の 1 か所だけ、`Schema.TaggedError` を失敗のチャネルに載せて境界で変換する、外から来る JSON を `Schema.fromJsonString` で検証する、`effect/process` の `ChildProcessSpawner` を Scope で持つ子プロセス、偽の `ChildProcessSpawner` を Layer で差し替えるテスト、`@effect/vitest` と `TestClock`、`effect-tsgo diagnostics` を検査に入れ「v3 の API を書くと落ちる」まで確かめる、の 7 つ。
- **手本が無いもの**: nyaucast は HTTP サーバーも WebSocket サーバーも持たない（MCP の stdio と CLI と HTTP クライアントだけ）。`NodeHttpServer`・`NodeSocketServer` の使い心地は nyaucast からは分からない。WebSocket のクライアントは `effect/socket` を使わず、Node の組み込みの `WebSocket` を `Effect.callback` と `acquireRelease` で包んでいる（`src/lib/cdp.ts:34-52`）。
- **map の前提の訂正 2 つ**:
  - `Schema.TaggedErrorClass` は `effect@4.0.0` に無い。名前は `Schema.TaggedError`（`node_modules/effect/dist/Schema.d.ts:10457`。`TaggedErrorClass` の出現は 0 件）。
  - `effect/unstable/*` というパスは 4.0.0 の配布物に無い。unstable なモジュールは `effect/http`・`effect/socket`・`effect/process`・`effect/cli`・`effect/ai`・`effect/sql` などの直下のパスで、JSDoc の `@stability unstable` で印が付いている（`effect/package.json` の `exports`、`dist/socket/Socket.d.ts:11`）。
- **SIGTERM → SIGKILL を TestClock で確かめる、は spawner の機能ではできない。** `ChildProcess` の `forceKillAfter` で SIGKILL への切り替えは書けるが、待ちは実時間の `Date.now()` と `setTimeout`（`NodeChildProcessSpawner.js:318-352`）で、`TestClock` では進まない。仮想時間で確かめたいなら、切り替えを自前で `Effect.sleep` と `handle.kill` で書き、テストでは偽の spawner を使う。

## 1. Service と Layer の切り方、エントリポイントでの実行

| nyaucast の書き方 | 出典 | live-mindmap へ |
|---|---|---|
| service は `class X extends Context.Service<X, {…}>()("nyaucast/X") { static layer(options) { return Layer.effect(X, make(options)) } }`。作る関数は `Effect.fnUntraced(function* …)` に分ける | `src/auth/secrets.ts:23-82`、`src/lib/chrome.ts:132-158` | **持ち込める。** `HelperProcess`・`ClaudeUpdater`・`SnapshotServer`・`SessionStore` のように外側の資源ごとに 1 つ。`erasableSyntaxOnly` でも通る形（class・static メソッドだけで、enum や parameter property を使わない） |
| service の中で使う依存は、layer を作るときに `Effect.context<…>()` で取り、`openPage` の中で `Effect.provideContext` する。呼び出し側の型に依存が漏れない | `src/lib/chrome.ts:142-154` | 持ち込める。ヘルパーの起動に `ChildProcessSpawner` が要っても、`server.ts` の側の型には出ない |
| Layer を組み、`NodeRuntime.runMain` を呼ぶのは entry point の 1 か所だけ。tool と core は `run*` を呼ばない（ADR-0001 決定 9）。それをテストで静的に検査している | `docs/adr/0001-thin-architecture.md:27-28`、`src/index.ts:143-149`、`test/effect-migration.test.ts:136` | 持ち込める。live-mindmap は entry が 2 つ（`server.ts` と `cli.ts`）なので「各 entry の末尾だけ」とする |
| `process.cwd()`・`homedir()`・`process.stdin.isTTY` は entry で 1 回だけ読んで Layer の引数に渡す | `src/index.ts:37-42`、`:115-119` | 持ち込める。`CliDeps.sessionsDir`・ポート・ヘルパーのパスの解決を entry に寄せる |
| 起動時の設定で組む Layer を変えるのは `Layer.unwrap(Effect.gen(…))` | `src/index.ts:98-103` | 必要なら（`play` と `start` で updater を変える等） |
| 常駐する部分（MCP サーバー）は `Layer.launch(layer)` で起動する | `src/cli.ts:72` | **常駐サーバーの形の手本。** `server.ts` を「HTTP・WS・ヘルパー管理の Layer を `Layer.launch` して `runMain`」にすれば、`process.on("SIGINT"/"SIGTERM")`（`server/src/server.ts:618-`）は要らなくなる。`NodeRuntime.runMain` が SIGINT・SIGTERM で main の fiber を中断し、finalizer（ヘルパーを止める・updater を閉じる）を走らせる（`@effect/platform-node-shared/dist/NodeRuntime.js:16-29`） |
| `runMain({ disableErrorReporting: true })` と `Logger.LogToStderr` を entry で与え、失敗の表示は CLI の境界で自分で出す | `src/index.ts:146-148` | 持ち込める |

注意: nyaucast は排他に `Semaphore.makeUnsafe(1)` をモジュールの最上位に置いている箇所が多い（`src/tools/explainer/video.renderCut.ts:201` など）。テストの間で状態を持ち越すので、live-mindmap の「同時に 1 セッションだけ」はモジュールの変数ではなく service の中の `Ref`／`Semaphore` に置くほうがよい。鍵ごとの直列化は `Map<string, Semaphore>` と `Semaphore.withPermit`（`src/x/auth.ts:77-81`、`:175`）。

## 2. エラーの型と、境界での変換

- 失敗は `Schema.TaggedError` で、事実だけを field に持つ（`src/tools/collection/video.checkTitle.ts:14-20`）。`return yield* new TitleTooLong({…})` で失敗させる（`:41`）。原因の文言やスタックは持たない方針で、段階を `Schema.Literals` で持つ例もある（`src/lib/cdp.ts:4-7` の `ChromeUnavailable({ stage })`）。
- 手で Result 型を書かず、`throw` を `src/` から消す。それを grep 相当のテストで守る（`docs/adr/0001-thin-architecture.md:17`、`test/effect-migration.test.ts:116-117`）。
- 境界での変換:
  - MCP: tool 定義の `failure: Schema.Union([...])` に並べると、`effect/ai` が宣言した失敗として返す（`video.checkTitle.ts:23-33`）。
  - CLI: `Effect.tapCause` で `Cause.findFail` を取り、`_tag` と field だけの 1 行を stderr に出す。`effect/cli` 自身の引数エラーは二重に出さない（`src/cli.ts:57-66`、`src/failure-report.ts:7-15`）。終了コードは `runMain` に任せる。
- **live-mindmap へ**: 持ち込める。`RequestError(status, message)`（`server/src/server.ts:56`）を、`SessionAlreadyRunning`・`NoSession`・`IntakeNotStopped`・`InvalidBody` のような失敗に分け、`onRequest` の 1 か所で「`_tag` → HTTP のステータスと本文」の表に変える。nyaucast の `describeFailure` の「タグと事実だけを出す」をそのまま HTTP の JSON の本文にできる。HTTP の境界の手本は nyaucast に無い（決めるのは map の Not yet specified の項目）。
- 外のライブラリの Promise を包むのは境界の数か所だけ（`Effect.tryPromise`、`src/lib/chrome.ts:47-54`）。live-mindmap では Agent SDK の `query()` がこれにあたる。

## 3. Schema の使い方

- 外から来る JSON は `Schema.decodeUnknownEffect(Schema.fromJsonString(S))` か、`decodeUnknownOption` で検証する（設定ファイル `src/auth/secrets.ts:31-36`、CDP のメッセージ `src/lib/cdp.ts:10-17`、`:86-92`）。
- 値の制約は `Schema.String.check(Schema.isMaxLength(n))`、説明は `.annotate({ description })`（`video.checkTitle.ts:10-12`）。入力は strict（`Tool.Strict`）にして未知のキーを拒む（ADR-0001 決定 9、`docs/adr/0001-thin-architecture.md:30`）。
- **live-mindmap へ**: 持ち込める。当てはまる所は、HTTP の本文（今は `typeof` の手書き検査、`server/src/server.ts:546-548`）、ヘルパーから WebSocket で届くフレーム、Agent SDK の `structured_output`（今は `as { ops: Op[] }` のキャスト、`server/src/claude.ts` の `update`）、セッションのログの読み戻し。`core/` に Schema を置くときは、`tsconfig.core.json` が `types: []`（Node の型なし）なので、`effect` 本体の型が Node の型を要求しないことを #194 の確認に入れる（nyaucast は core を Node なしで型検査していないので前例が無い）。

## 4. `@effect/platform-node` と unstable モジュールの使い分け

nyaucast が import しているモジュールの数（`src`・`test` の import 文）: `effect` 176、`@effect/vitest` 69、`effect/sql` 46、`effect/ai` 23、`@effect/platform-node` 21、`effect/http` 18、`effect/cli` 15、`effect/testing` 11、`effect/process` 7、`@effect/sql-libsql` 1。

- `@effect/platform-node` から使うのは `NodeRuntime`・`NodeServices`（FileSystem・Path・ChildProcessSpawner などをまとめた Layer）・`NodeHttpClient.layerUndici`・`NodeStdio` だけ（`src/index.ts:5`、`:46`、`:146`）。テストでは `NodeServices.layer` を本物の FileSystem として与える（`src/auth/secrets.test.ts:3` ほか）。
- **`NodeHttpServer`・`NodeSocketServer`・`effect/socket` は使っていない。** 配布物を見ると、`NodeSocketServer.layerWebSocket` は `ws` パッケージで WebSocket サーバーを作る（`@effect/platform-node-shared/dist/NodeSocketServer.d.ts:63-80`、依存は `ws ^8.22.0`。live-mindmap と同じ線）。使い心地の記録は無い。
- 使い心地の記録（`docs/knowledge/2026-10-02.md:772-778`）: `effect/ai`・`cli`・`http`・`sql` はどれも `@stability unstable` なので exact pin にし、破壊的変更は pin を上げる差分で受ける（ADR-0001 決定 9、`docs/adr/0001-thin-architecture.md:31`。exact pin もテストで検査、`test/effect-migration.test.ts:75`）。
- **live-mindmap へ**: exact pin の方針は持ち込める。`node:http`・`ws` まで Effect のモジュールに置き換えるかは、nyaucast からは判断材料が出ない（前例なし）。nyaucast の CDP のように「`ws` は残し、`Effect.callback`＋`acquireRelease` で包む」が前例のある最小の形（`src/lib/cdp.ts:34-52`）。`helperSocket.ts` の「open の前に届いたフレームを取りこぼさない」工夫は、包むときにそのまま残る。

## 5. 子プロセス（Swift のヘルパーにあたるもの）

nyaucast は `op`（1Password）・`codex`・Chrome を `effect/process` で起動している。

- 起動は `spawner.spawn(ChildProcess.make(cmd, args, opts))`。返る handle は Scope に結び付き、Scope が閉じると止まる（`src/auth/secrets.ts:39-49`、`src/lib/chrome.ts:106-116`）。
- Chrome の起動は、stdout を `Effect.forkScoped` で読み捨て続け（パイプを詰まらせない）、stderr を行に分けて「DevTools listening on …」の行を `Deferred` に渡し、それを待つ（`src/lib/chrome.ts:90-116`）。stderr が終わっても見つからなければ `ChromeUnavailable({ stage: "launch" })`。**live-mindmap の `launchHelper` → `connectToHelper`（`server/src/server.ts:153-191`）とほぼ同じ形**で、手本になる。
- 配布物の振る舞い（`@effect/platform-node-shared/dist/NodeChildProcessSpawner.js`）:
  - Scope が閉じたときに生きていれば、`killSignal`（既定 SIGTERM）を送り、`forceKillAfter` を過ぎても生きていれば SIGKILL を送る（`:339-352`、`:390-405`、オプションは `effect/dist/process/ChildProcess.d.ts:150-167`）。`HELPER_STOP_TIMEOUT_MS` と `stopHelper` の役目は、これで置き換えられる。
  - **待ちは `Date.now()` と `setTimeout` の実時間**（`:318-337`）。`TestClock` では進まない。
  - **macOS では既定で `detached: true`**（`internal/nodeChildProcessSpawner.js:2`）で、プロセスグループごと signal を送る。端末の Ctrl-C はヘルパーに直接届かなくなり、Node が SIGKILL で落ちたときにヘルパーが残りうる。今の `spawn` は detached でないので、置き換えるときに `detached: false` にするかを決める。
- テスト: 偽の `ChildProcessSpawner` を `ChildProcessSpawner.make` と `makeHandle` で作り、`Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)` で差し替える（`test/codex-helpers.ts:78-102`、`:166-185`）。終了コードを `Deferred` で止めておけば「実行が重なるか」も観測できる（`:17-18`、`:90-92`）。
- **live-mindmap へ**: 持ち込める。今の server のテストは偽のヘルパーを本物の子プロセスで起動していて遅い（`server/vitest.config.ts` の `testTimeout: 20_000` のコメント）。起動し直し・SIGKILL への切り替えの判断は偽の spawner と `TestClock` で確かめ、本物の子プロセスでの確認は少数に絞れる。ただし SIGKILL への切り替えを仮想時間で確かめるなら、`forceKillAfter` に任せず、`handle.kill` と `Effect.sleep`（あるいは `Effect.timeout`）で自前に書く必要がある。

## 6. テスト

- テストの API は `@effect/vitest`（`it.effect`）から取り、`vite-plus/test` からは取らない。それをテストで検査（`test/effect-migration.test.ts:211-217`）。
- 時刻は `Clock` から取り、`Date.now()` と引数なしの `new Date()` を本番のコードから消す（検査は `test/effect-migration.test.ts:143-144`）。テストでは `TestClock.setTime` で絶対時刻を決める（`test/helpers.ts:125-126`）。
- 再試行の待ち（`Effect.sleep`）を含む処理は、`Effect.forkChild` で走らせて `TestClock.adjust("1 hour")` で進め、`Fiber.join` で結果を取る（`src/youtube/client.test.ts:100-117`）。
- Layer の差し替え: HTTP は `HttpClient.make` で偽を作る（`src/youtube/client.test.ts:52-60`）。標準出力は `TestConsole.layer` で拾う（`test/helpers.ts:105-113`）。使わない service は `unused*Layer` として固めて渡す（`test/helpers.ts:72-91`）。
- CLI のテストは子プロセスを起動せず、`nyaucastCli(environment)(argv)` を in-process で走らせる（`src/cli.ts:84-90`。経緯は `docs/knowledge/2026-10-03.md` の #561 の節）。entry の起動だけを確かめる契約テストは子プロセスで、1 回に数秒かかる（`vite.config.ts:53-54`）。
- **live-mindmap へ**: 持ち込める。`@effect/vitest@4.0.0` の peer は vitest 5 で、live-mindmap の `vitest ^5.0.3` で足りる（nyaucast は vite-plus 1.0 が同梱する vitest 5 で動かしている、`docs/knowledge/2026-10-02.md:785-787`）。今の `cli.ts` の `CliDeps`（`sleep`・`stdout` の差し込み）は、`Clock` と `Console` を Layer で差し替える形に置き換わる。

## 7. `@effect/tsgo` と TS 7

- `@effect/language-service` は TS 7 で動かないので、TypeScript-Go のフォークの `@effect/tsgo` を使う（`docs/knowledge/2026-10-02.md:778`。ネイティブバイナリで約 190 MB、OS ごとの optionalDependencies）。
- 型検査そのものは TS 7（`typescript 7.0.2`）で行い、`effect-tsgo diagnostics --project tsconfig.json` を別の script にして検査ゲートに入れている（`package.json:31`、`:38`。CI も同じ `pnpm run check`、`.github/workflows/ci.yml:58-59`）。
- 設定は `tsconfig.json` の `plugins` に `{"name": "@effect/language-service", "diagnosticSeverity": {"outdatedApi": "error", "unstableApiUsage": "off"}}`（`tsconfig.json:21-29`）。`outdatedApi` は warning のままだとゲートが落ちないので error にする。unstable の警告は全面採用なので切る。
- ゲートが効くことの確認: v3 の `Effect.catchAll` を一時ファイルに書いて終了コード 1、消して 0、を確かめた（`docs/knowledge/2026-10-03.md:359-365`）。名前が消えた v3 の API は素の型検査でも落ちるが、`outdatedApi` は改名先（`catchAll` → `catch`、`either` → `result`）まで出すので、エージェントが直しやすい（`docs/knowledge/2026-10-02.md:811-818`）。
- Effect 4 の書き方は、書く前に `node_modules/effect/AGENTS.md` を読ませる（nyaucast の `AGENTS.md:23`）。
- **live-mindmap へ**: 持ち込める。`server/package.json` の `typecheck` の後ろに `effect-tsgo diagnostics` を足す。`tsconfig.core.json` も対象にするか決める。

## 8. Node 24 の strip-types・TS 7・vitest で Effect 4 を動かすための設定（#194 へ）

nyaucast で、Effect 4 のために入れた回避策は見つからなかった。あるのは次の設定だけ。

- `tsconfig.json`: `module: "preserve"`、`moduleResolution: "bundler"`、`allowImportingTsExtensions`、`verbatimModuleSyntax`（`tsconfig.json:2-20`）。live-mindmap は `nodenext` で、`effect` の `exports` は `./dist/<名前>/index.js`（`type: module`、隣に `.d.ts`）なので、`nodenext` でも解決できるはず。#194 で実際に確かめる。
- 開発時はビルドしない。`.ts` の実行は Node の type stripping（v24 で Stable）。entry は `package.json` の `imports` の条件（`#nyaucast-entry` → `nyaucast-source` なら `./src/index.ts`）で src と dist を切り替える（`package.json:20-26`、`bin/nyaucast.js:3`）。契約テストは `--conditions=nyaucast-source --experimental-strip-types` を付けて node で起動する（`test/mcp-cli.test.ts:50-55`。Node 24 では strip-types は既定で有効なので、後者のフラグは無くても動くはず）。live-mindmap は配布しないので、この切り替えは要らない。
- pnpm の `allowBuilds` に Effect 関係のものは無い（`pnpm-workspace.yaml`）。`@effect/tsgo` のバイナリは optionalDependencies で入る。
- 移行の仕方: 「混在する期間を作らない」として一括で移し、移行を最初の 1 本にして残りの issue をすべてそれに blocked させた（`docs/adr/0001-thin-architecture.md:59`、`docs/knowledge/2026-10-03.md:291-293`）。takt で 49 分、51 ファイルの PR だった（`docs/knowledge/2026-10-03.md:339`）。

## 9. つまずきの記録（nyaucast の knowledge から）

- 制約は両側の最新版で確かめる: 「`@effect/vitest` は vitest 5 が必須で組めない」は、vite-plus 1.0（vitest 5 同梱）が出ていて古い前提だった（`docs/knowledge/2026-10-02.md:785-789`）。
- エージェントは v3 の API を書きがち（例: v3 の `Argument.Choice`、v4 では `Argument.Literals`）。型検査と `outdatedApi` で止める（`docs/knowledge/2026-10-02.md:811-813`）。
- Effect の定型（`Schema.TaggedError`、`Context.Service` と `static layer`、`Effect.gen`）は形が揃うので、重複検出（fallow の semantic モード）や関数の行数の lint が定型を拾う。閾値とモードを見直した（`docs/knowledge/2026-10-03.md:373`、`:583`、`:623`）。失敗のクラスを export しない書き方は `private-type-leaks` に当たる（`:627`）。live-mindmap に同じ種類のゲートを入れるときに効く。

## 持ち込めないもの・前例が無いもの

| 項目 | 理由 |
|---|---|
| HTTP サーバーと WebSocket サーバー（`NodeHttpServer`・`NodeSocketServer`・`HttpApi`） | nyaucast は使っていない。手本なし |
| 開いたままの Agent SDK の `query()` の包み方（ADR 0006 の使い回し） | nyaucast に同じ形の資源が無い。近いのは CDP の接続（`acquireRelease` で開き、待っている呼び出しを `Deferred` の表で持ち、閉じたら全部失敗させる、`src/lib/cdp.ts:46-111`）。開き直しの判断は自前で書くことになる |
| SIGKILL への切り替えを `TestClock` で確かめる | spawner の `forceKillAfter` は実時間（上の 5 節） |
| `effect/ai`・`effect/sql`・MCP の書き方 | live-mindmap の server に当たる部分が無い |
| `package.json` の `imports` での src と dist の切り替え | live-mindmap は配布しない |
