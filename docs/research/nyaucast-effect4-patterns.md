# nyaucast の Effect 4 の書き方から手本にするもの

issue [#199](https://github.com/daiki-beppu/live-mindmap/issues/199)（マップ [#193](https://github.com/daiki-beppu/live-mindmap/issues/193)）の調査。2026-10-06 時点。

- 調べたもの: nyaucast のローカルの checkout（`~/ghq/github.com/daiki-beppu/nyaucast`、origin/main と同じ `43ca1e2`）。以下、nyaucast のパスはこのリポジトリのルートからの相対パス
- 版: `effect@4.0.0`・`@effect/platform-node@4.0.0`・`@effect/sql-libsql@4.0.0`・`@effect/vitest@4.0.0`・`@effect/tsgo@0.47.2`・`typescript@7.0.2`・`vite-plus@1.0.0`（同梱の vitest は 5.0.1）。すべて exact pin（`package.json`）
- npm の最新は `effect@4.0.1`・`@effect/vitest@4.0.1`（peer は `vitest >=5.0.0 <6.0.0`）。`pnpm view` で確認
- このリポジトリの側は `server/src/`（`server.ts` 629 行、`core/` は純粋な関数）、`server/tsconfig.json`、`server/vitest.config.ts` を読んだ

判定は 3 つに分ける。**採る**（そのまま手本にする）、**変えて採る**（考え方は採るが形を合わせる）、**採らない**。

## 先に結論: Node 24 strip-types・TS 7・vitest 5 で Effect 4 は動く

nyaucast には Effect のための特別な設定や回避策はほとんど無い。このリポジトリの `server/tsconfig.json` と同じ設定（`module: nodenext`・`erasableSyntaxOnly: true`・`verbatimModuleSyntax: true`・`allowImportingTsExtensions: true`）で、nyaucast の `node_modules` を借りて小さな試験を組み、次を確かめた（試験の置き場はセッションの一時ディレクトリで、リポジトリには残していない）。

| 確かめたこと | 結果 |
| --- | --- |
| `node src/main.ts`（Node 24.15.0 と 26.9.0）。`Context.Service`・`Schema.TaggedError`・`Effect.fn`・`NodeRuntime.runMain` を使う | 動く。フラグ不要、警告も出ない |
| `tsc -p tsconfig.json`（TS 7.0.2、`nodenext` + `erasableSyntaxOnly`） | エラー 0 |
| `effect-tsgo diagnostics --project tsconfig.json` | エラー 0 |
| わざと v3 の `Effect.catchAll` を書く | `tsc` は `TS2339`（存在しないプロパティ）で落ちる。`effect-tsgo` は `effect(outdatedApi)` で落ち、「Renamed to catch.」と直し方まで出す。どちらも終了コード 1 |
| vitest 5.0.1 + `@effect/vitest@4.0.0` で `it.effect`・`it.layer`・`TestClock.adjust` | 通る（Node 24.15.0 でも） |

試験に使ったコードの要点:

```ts
export class TooLate extends Schema.TaggedError<TooLate>()("TooLate", { at: Schema.Finite }) {}

export class Deadline extends Context.Service<Deadline, { readonly limit: number }>()("e4/Deadline") {
  static readonly layer = (limit: number) => Layer.succeed(this, this.of({ limit }));
}
```

`class ... extends 式 {}` と `static readonly` は消去可能な構文なので、`erasableSyntaxOnly` にも Node の type stripping にも引っかからない。nyaucast のコードにも `enum`・`namespace`・コンストラクタの引数プロパティは 1 つも無い（`grep` で確認）。effect は `dist/*.js` と `.d.ts` を出荷していて、`node_modules` の `.ts` を Node が拒む件（nyaucast ADR 0003 が記録した `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）にも当たらない。

nyaucast 側で関係する設定は次の 4 つだけ。

1. **tsconfig の plugin 欄で Effect の診断を設定する**（`tsconfig.json`）。TS 7（ネイティブの tsc）は言語サービスの plugin を読まないので、この欄を読むのは `effect-tsgo` だけ

   ```json
   "plugins": [
     {
       "name": "@effect/language-service",
       "diagnosticSeverity": { "outdatedApi": "error", "unstableApiUsage": "off" }
     }
   ]
   ```

   `outdatedApi` は既定では error にならないので、明示しないと検査が落ちない（nyaucast `docs/knowledge/2026-10-03.md` の「古い API を『わざと書いて落ちる』ことまでゲートの検証に含める」）。`unstableApiUsage` を切るのは、`effect/http`・`effect/cli`・`effect/ai`・`effect/sql`・`effect/process` が JSDoc で `@stability unstable` と表示されていて、使うたびに警告が出るから（ADR 0001 決定 9）

2. **型検査は `tsc` と `effect-tsgo diagnostics` の 2 本を別に走らせる**（`package.json` の `effect:check` と `check`）。`@effect/tsgo` は TypeScript-Go の wrapper で、`typescript >= 7` を別に入れる必要がある（`node_modules/@effect/tsgo/README.md`。0.47.2 が対応するのは TS `7.0.2` と `7.1.0-dev`）

   ```json
   "effect:check": "effect-tsgo diagnostics --project tsconfig.json"
   ```

3. **開発時の実行は `--conditions` で `src/*.ts` を指す**（`package.json` の `imports`、`bin/nyaucast.js`）。npm に出すので dist を作る都合で、このリポジトリ（`bin` が `./src/cli.ts` を直接指す、private）には要らない

   ```json
   "imports": {
     "#nyaucast-entry": { "nyaucast-source": "./src/index.ts", "types": "./src/index.ts", "default": "./dist/index.js" }
   }
   ```

   子プロセスで起動する契約テストは `node --conditions=nyaucast-source --experimental-strip-types bin/nyaucast.js mcp`（`test/mcp-cli.test.ts`）。`--experimental-strip-types` は Node 24 では既定で有効なので、付けていても意味は無い

4. **vitest の設定に Effect のための項目は無い**（`vite.config.ts` の `test`）。契約テストの `testTimeout: 30_000` に「effect の読み込みを含めて 1 回に数秒かかる」と注記があるだけ。このリポジトリの `server/vitest.config.ts`（`testTimeout: 20_000`）でも、子プロセスを起動するテストは同じ理由で時間が延びうる

**判定: 採る。** `server/tsconfig.json` に plugin 欄を足し、`typecheck` に `effect-tsgo diagnostics` を加え、`outdatedApi: "error"` にする。わざと v3 の API を書いて落ちることを 1 度確かめる。このリポジトリの tsconfig は `nodenext` なので、nyaucast（`module: preserve`・`moduleResolution: bundler`）に合わせる必要は無い。`tsconfig.core.json`（`types: []` で core を Node から切り離す）も、effect の型は Node の型に依らないのでそのまま使える。

## 1. Service と Layer の切り方、エントリポイントでの実行

**nyaucast の形**: service は `Context.Service` のクラスで、実装は static の `layer`（引数が要れば関数）に置く。

```ts
// src/collections/collection-ids.ts
export class CollectionIds extends Context.Service<
  CollectionIds,
  { readonly next: Effect.Effect<string> }
>()("nyaucast/CollectionIds") {
  static readonly layer = Layer.succeed(this, this.of({ next: Effect.sync(() => randomUUID()) }));
}
```

- 識別子は `"nyaucast/<名前>"`（`src/lib/chrome.ts` は `"nyaucast/lib/Chrome"`）
- 本番と偽物で中身が違う service は `layerProduction` のように名前を分ける（`YouTubeAuth.layerProduction` など、`src/index.ts`）
- 資源を持つ Layer は `Layer.unwrap(Effect.gen(...))` で、開くときの準備（ディレクトリ作成・バックアップ）をしてから Layer を返す（`src/db/local-store.ts` の `LocalStore.layer(url)`）
- 外部の資源（ソケット、子プロセス）は `Effect.acquireRelease` と `Scope` で閉じる（`src/lib/cdp.ts` の `connectCdp`、`src/lib/chrome.ts` の `Chrome.openPage: Effect<ChromePage, ChromeUnavailable, Scope.Scope>`）

**エントリポイント**: Layer を組んで実行するのは `src/index.ts` の 1 か所だけ。場所の解決（`process.cwd()`、`homedir()`、`process.stdin.isTTY`）もここで 1 回だけ行い、値として各 Layer に渡す。

```ts
// src/index.ts（末尾）
Stdio.Stdio.use(({ args }) =>
  Effect.flatMap(args, nyaucastCli({ auth: authServices, mcpServer, post, video })),
).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

`disableErrorReporting: true` は、失敗の表示を CLI の境界（後述の `describeFailure`）に任せ、runMain が cause を丸ごと出さないようにするため。これが「1 か所だけ」であることは、テストで機械的に守っている。

```ts
// test/effect-migration.test.ts
it("calls an Effect runner (runMain, runPromise, runSync, runFork) only from the entry point", () => {
  const runners = filesMatching(production(sources), /\brun(?:Main|Promise|Sync|Fork)\b/u);
  assert.deepStrictEqual(runners, ["src/index.ts"]);
  expect(contents("src/index.ts").match(/\bNodeRuntime\.runMain\b/gu)).toHaveLength(1);
});
```

サブコマンドごとに要る Layer だけを組むため、CLI は Layer を引数で受け取り `Command.provide` で各サブコマンドに付ける（`src/cli.ts` の `CliEnvironment`）。テストはここに「組まれたら死ぬ」Layer を渡す（`test/helpers.ts` の `unusedAuthLayer`）。

**判定**

- `Context.Service` + static `layer`、識別子の名前空間、`Scope` で資源を閉じる形: **採る**。ヘルパーの子プロセス・WebSocket・listen・updater（`claude.ts`）は、どれも `acquireRelease` に載る。ヘルパーの起動し直し（#161）は「ヘルパーごとの Scope を閉じて開き直す」と書ける
- `runMain` は entry point の 1 か所だけ、をテストで守る: **変えて採る**。live-mindmap の entry point は `server.ts`（常駐サーバー）と `cli.ts` の 2 本なので、許すファイルを 2 つにする。置き換えの途中で `runPromise` の境界を置く場合は、その一時的な場所もこのテストの許可リストに書き、混ざる期間がどこにあるかを見えるようにする
- 場所や環境の解決を entry point で 1 回だけ行う: **採る**。`LIVE_MINDMAP_PORT`・`defaultSessionsDir` などは entry point で読み、Layer の引数にする（Effect の `Config` を使うかは別に決める）
- `Layer.unwrap` で起動時に分岐する（nyaucast はチャンネルの種類で tool 一覧を選ぶ）: live-mindmap には今のところ同じ要件が無い。**採らない**（要るときに使う）

## 2. エラーの型と、境界での変換

**エラーの定義**: すべて `Schema.TaggedError`。事実（URL、HTTP status、パス）だけを field に持ち、message や認証情報は持たない。外に見せない失敗は export せず、union の型だけを export する。

```ts
// src/youtube/client.ts
// 失敗は、タグと事実（URL・HTTP status・Google の reason）だけを持つ。認証情報は持たない。
class YouTubeHttpFailure extends Schema.TaggedError<YouTubeHttpFailure>()("YouTubeHttpFailure", {
  reason: Schema.optionalKey(Schema.String),
  status: Schema.Finite,
}) {}
export type YouTubeClientFailure = UntrustedYouTubeUrl | YouTubeAuthFailure | YouTubeHttpBoundaryFailed | YouTubeHttpFailure | YouTubeResponseInvalid;
```

失敗させるときは `return yield* new X({...})`（`src/tools/collection/video.checkTitle.ts`）。

issue 本文の `TaggedErrorClass` は beta の頃の名前で、4.0.0 の正式版にあるのは `Schema.TaggedError`（`node_modules/effect/dist/Schema.d.ts`、同梱の `node_modules/effect/AGENTS.md` の例も `Schema.TaggedError`）。`Data.TaggedError` は nyaucast では使っていない。`Schema.TaggedError` は field が Schema なので、境界で失敗をそのまま JSON にできる（MCP の tool の `failure` に渡している）。

**MCP の境界**: tool の `failure` に失敗の Schema の union を宣言すると、`effect/ai` の MCP サーバーがツールエラーとして返す。入力の Schema に合わない呼び出しは JSON-RPC の -32602 になる（ADR 0001 決定 3）。業務の判定で落ちるもの（タイトルが長すぎる）は、入力の Schema で弾かずに宣言した失敗にしている。

```ts
// src/tools/collection/video.checkTitle.ts
// 文字数の超過はこの tool の業務そのものなので、パラメータ不正（-32602）ではなく宣言した失敗にする。
export const CollectionVideoCheckTitleTool = Tool.make("video_check_title", {
  failure: Schema.Union([TitleTooLong, TitleAlreadyInUse]),
  parameters: Schema.Struct({ title: Schema.String.annotate({ description: titleDescription }) }),
  success: Schema.Struct({ ok: Schema.Literal(true) }),
}).annotate(Tool.Strict, true);
```

**CLI の境界**: `Effect.tapCause` で cause から最初の失敗を取り出し、タグと事実の 1 行だけを stderr に出す。stack・cause・message は出さない。タグの無い値は `UnexpectedFailure` にまとめる。`effect/cli` 自身の引数の誤り（`CliError`）は二重に出さない。

```ts
// src/failure-report.ts
export function describeFailure(failure: unknown): string {
  if (!Predicate.hasProperty(failure, "_tag") || typeof failure._tag !== "string") {
    return "UnexpectedFailure";
  }
  const facts = Object.fromEntries(Object.entries(failure).filter(([key]) => key !== "_tag"));
  return Object.keys(facts).length === 0 ? failure._tag : `${failure._tag} ${JSON.stringify(facts)}`;
}
```

```ts
// src/cli.ts
const reportFailure = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.findFail(cause);
  if (Result.isSuccess(failure) && CliError.isCliError(failure.success.error)) {
    return Effect.void;
  }
  return Console.error(Result.isSuccess(failure) ? describeFailure(failure.success.error) : "UnexpectedFailure");
};
```

**Promise の境界でのつまずき**: `Effect.promise` は reject を失敗ではなく defect にする。`Effect.result` で捕まらず、実行全体が落ちる。外部ライブラリの Promise は `Effect.tryPromise({ try, catch: () => new X() })` で型付きの失敗に変えている（`src/youtube/resumable-upload.ts` の `ChunkReadFailed` の注記、`src/youtube/post-adapter.ts`）。`src/` に `throw` が無いこともテストで守っている（`test/effect-migration.test.ts` の「has no throw statement」）。

**判定**

- `Schema.TaggedError` で事実だけを持つ失敗、外に見せないクラスは export しない: **採る**。`server.ts` の `RequestError extends Error`（status と message を持つ）をやめ、「状態に合わない」「入力が不正」「ヘルパーが起動しない」などをタグで分ける
- 境界で 1 か所だけ変換する: **変えて採る**。live-mindmap の境界は HTTP（`/session/start` など）と CLI。HTTP では「タグ → ステータス」の対応を 1 か所に置く（nyaucast には HTTP の受け口が無いので手本は無い）。CLI は `describeFailure` の形（タグ + 事実の 1 行、想定外は固定の名前）をそのまま使える
- `Effect.promise` ではなく `Effect.tryPromise`: **採る**。Agent SDK の `query()`（`claude.ts`）や `ws` のイベントを包むときに効く
- `throw` が無いことをテストで守る: **採る**。ただし置き換えが終わってから入れる（途中で入れると落ち続ける）

## 3. Schema の使い方

**外から来るデータ**: JSON は `Schema.fromJsonString` と `Schema.decodeUnknownEffect` で、文字列から一度に検証する。

```ts
// src/narration/timing-table.ts
const decodeTimingTable = Schema.decodeUnknownEffect(Schema.fromJsonString(TimingTableSchema));
```

外部 API の応答も Schema で decode し、合わなければ `YouTubeResponseInvalid` のような失敗にする（`src/youtube/client.ts` の `GoogleError`）。

**ドメインの型**: `Schema.Struct` を定義し、型は `typeof X.Type` で取り出す。制約は `.check(...)` で足す。既定値は `Schema.withDecodingDefaultKey`。

```ts
// src/channel/channel-settings.ts
const PositiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const ThumbnailType = Schema.Struct({
  candidates: PositiveInteger.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  provider: Schema.Literals(["gemini", "codex"]),
  // ...
});
export type ThumbnailType = typeof ThumbnailType.Type;
```

数の field には `Schema.Number` ではなく `Schema.Finite` を使っている（NaN・Infinity を通さない）。`Schema.Class`・`Schema.brand` は使っていない。使っている数は `Schema.Struct` 152 か所、`Schema.decodeUnknownEffect` 24 か所、`Schema.fromJsonString` 14 か所（`src/` と `test/` の grep）。

**判定**

- 外から来るもの（ヘルパーの WebSocket のメッセージ、HTTP の本文、保存したセッションの `map.json`）を `Schema.fromJsonString` + `decodeUnknownEffect` で検証する: **採る**。今の `core/intake.ts` の `remarkFromHelper` などが手で形を確かめている所が置き換え先
- ドメインの型を `Schema.Struct` + `typeof X.Type` で持つ: **変えて採る**。core の型（`Session`・`Track`・map の木）をすべて Schema にすると、純粋な関数の中まで Schema の型が広がる。外と出入りする型（保存する・受け取る）だけを Schema にし、内部だけで使う型は TS の型のままにするかを、core をどこまで寄せるかのチケットで決める

## 4. `@effect/platform-node` と `effect/unstable/*`

**4.0.0 には `effect/unstable/*` というパスは無い**。beta の頃の `effect/unstable/http` などは、正式版では `effect/http`・`effect/cli`・`effect/ai`・`effect/sql`・`effect/socket`・`effect/process` などに移っている（`node_modules/effect/package.json` の `exports`。`import("effect/unstable/http")` は `ERR_MODULE_NOT_FOUND`）。4.0.1 の `exports` も同じ。ただし中身は JSDoc で `@stability unstable` のままで、minor でも壊れうる。

nyaucast が使っているもの（`src/` と `test/` の import の数）:

| モジュール | 用途 | 数 |
| --- | --- | --- |
| `effect/sql`（+ `@effect/sql-libsql`） | local store。Migrator は手書きの `<id>_<name>` | 46 |
| `effect/ai` | MCP の stdio サーバー（`McpServer`・`Tool`・`Toolkit`） | 23 |
| `effect/http` | 外への HTTP（`HttpClient`）。テストでは `HttpClient.make` で偽物 | 18 |
| `effect/cli` | CLI の引数解析とサブコマンド | 15 |
| `effect/testing` | `TestClock`・`TestConsole` | 11 |
| `effect/process` | 子プロセス（`ChildProcess`・`ChildProcessSpawner`）。chrome の起動 | 7 |

`@effect/platform-node` から使っているのは `NodeRuntime`・`NodeServices`（FileSystem・Path・ChildProcessSpawner などをまとめた Layer）・`NodeHttpClient.layerUndici`・`NodeStdio`。HTTP サーバー（`NodeHttpServer`）と `NodeSocket` は使っていない。CDP の WebSocket は `effect/socket` ではなく、Node の組み込みの `WebSocket` を `Effect.callback` と `acquireRelease` で包んでいる（`src/lib/cdp.ts`）。

使い心地の記録（nyaucast `docs/knowledge/2026-10-03.md`）:

- 一括移行は 51 ファイル +4665 / −4345 で、混在の期間を作らなかった
- Effect の定型（`Schema.TaggedError` の宣言、`Effect.gen` の書き出し）がコピペ検出（fallow）に重複として拾われた。主な原因は識別子を同一視する検出モードだった
- unstable のモジュールの破壊的変更は「pin を上げる差分の中で受け止める」と決めている（ADR 0001 決定 9）

**判定**

- 子プロセスは `effect/process` の `ChildProcess` にする: **採る**（検討の価値が高い）。`KillOptions` に `killSignal`（既定 `SIGTERM`）と `forceKillAfter`（この時間の後に `SIGKILL`）があり（`node_modules/effect/dist/process/ChildProcess.d.ts`）、`server.ts` の「SIGTERM から 5 秒後に SIGKILL」（`HELPER_STOP_TIMEOUT_MS`）をそのまま表せる。#197 の試作で、Scope の終了と組み合わせたときの挙動と TestClock で進められるかを確かめる
- HTTP の受け口と WebSocket（`effect/http` のサーバー・`NodeHttpServer`・`effect/socket`・`NodeSocketServer`）: nyaucast に使用例が無いので、**手本は無い**。`ws` を `Effect.callback` と `acquireRelease` で包む nyaucast の `cdp.ts` の形なら、unstable のモジュールに乗らずに済む。どちらにするかは #193 の未決の項目として残る
- CLI を `effect/cli` にする: **変えて採る**。`Command.provide` でサブコマンドごとに Layer を付ける形は使える。ただし nyaucast も CLI のテストを子プロセスから in-process に移すのを後回しにしている（nyaucast issue #561）
- `@effect/platform-node` の `NodeRuntime`・`NodeServices`: **採る**
- unstable の警告を切る（`unstableApiUsage: "off"`）と exact pin: **採る**。今の `server/package.json` は `^` の範囲指定なので、effect と `@effect/*` だけは exact にする

## 5. テスト

nyaucast のテストは `@effect/vitest` の `it.effect` がほぼすべて（1003 か所）。`it.layer` は使わず、テストごとに `Effect.provide` で Layer を付ける。

**TestClock**: 時刻は `Clock` から取り、テストで `TestClock.setTime` と `TestClock.adjust` で決める。sleep を含む処理は別の fiber で走らせてから時計を進める。

```ts
// src/youtube/client.test.ts
// 再試行の待ちは Effect.sleep なので、request を別 fiber で走らせ TestClock を進めて完了させる。
const requestWith = (fixture: Fixture, request: Request) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    const fiber = yield* Effect.forkChild(Effect.result(client.request(request)));
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(fixture.layer));
```

`src/` に `Date.now()` と引数なしの `new Date()` が無いことはテストで守っている（`test/effect-migration.test.ts`）。

**Layer の差し替え**: 本物の Layer に、偽の依存を `Layer.succeed` で渡す。偽物は `Service.of({...})` で作り、呼ばれた回数は `vi.fn` で見る。偽の HTTP は `HttpClient.make` で応答を順に返す。

```ts
// src/youtube/client.test.ts
const auth = YouTubeAuth.of({
  authorize: () => Effect.die("authorize is not part of the request client"),
  getAccessToken,
  refreshAccessToken,
});
const layer = YouTubeClient.layer.pipe(
  Layer.provide(Layer.succeed(YouTubeAuth, auth)),
  Layer.provide(youtube.http),
);
```

使わないはずの依存には「組まれたら死ぬ」Layer を渡す。

```ts
// test/helpers.ts
const notUsed = Effect.die("このテストでは使わないサブコマンドの Layer が組まれた");
export const unusedAuthLayer = Layer.mergeAll(Layer.effect(ChannelAccounts, notUsed), /* ... */);
```

CLI の出力は `TestConsole` で in-process に取る（`test/helpers.ts` の `runProgram`）。DB は一時ディレクトリの実ファイルの libSQL を使う（`channelLayer`）。

**判定**

- `it.effect` + `TestClock`、時刻は `Clock` から: **採る**。#193 の目安「TestClock で SIGKILL まで確かめる」に直接使える。`forkChild` → `TestClock.adjust` → `Fiber.join` の順番が手本になる
- `Service.of` の偽物を `Layer.succeed` で渡す、使わない依存は `Effect.die` の Layer: **採る**。今の `ServerOptions` の `openUpdater`・`capture`・`helper` は、そのまま service の差し替えになる
- `TestConsole` で CLI の出力を取る: **採る**（CLI を Effect にするなら）
- 偽のヘルパーを子プロセスで起動する今の契約テスト: 残す。nyaucast も MCP の stdio と entry point の配線だけは子プロセスで確かめている（`test/mcp-cli.test.ts`）

## 6. `@effect/tsgo` の検査と CI、TS 7 との関係

- 検査のゲートは `pnpm run check` の 1 本で、その中に `effect:check`（`effect-tsgo diagnostics --project tsconfig.json`）がある。CI（`.github/workflows/ci.yml`）は `pnpm run check` を呼ぶだけで、ゲートを workflow 側に書き写さない
- `@effect/tsgo` は TypeScript-Go（TS 7）の wrapper。TS 7 のネイティブの tsc は tsconfig の言語サービスの plugin を読まないので、Effect の診断は `effect-tsgo` を別に走らせて出す。README は `effect-tsgo patch` で tsc に診断を組み込む方法も挙げているが、nyaucast は使っていない
- 通常の型検査は vite-plus の `vp check`（lint の `typeAware: true`・`typeCheck: true`）で行う。`effect-tsgo` は型検査をもう一度行うので、検査が 2 回走る
- `check` の中に `effect-tsgo diagnostics` が 1 本だけあることもテストで守っている（`test/effect-migration.test.ts` の「runs the @effect/tsgo diagnostics inside check」）

**判定: 採る。** このリポジトリの CI（`.github/workflows/check.yml`）は `pnpm typecheck` を呼び、server の `typecheck` は `tsc --noEmit` を 2 回（全体と `tsconfig.core.json`）走らせる。ここに `effect-tsgo diagnostics --project tsconfig.json` を足せば、CI の側は変えずに済む。`@effect/tsgo` は対応する TS の版が決まっているので（0.47.2 は `7.0.2`）、`typescript` の `^7.0.2` を上げるときは `@effect/tsgo` の対応表も見る。

## 7. ADR・AGENTS.md に書かれた方針と、つまずき

nyaucast の ADR 0001 決定 9（2026-10-02 / nyaucast #475）が Effect の組み立て方をまとめている。要点:

- service は `Context.Service` + static `layer`。Layer を組み、`NodeRuntime.runMain` を呼ぶのは entry point の 1 か所だけ。tool と core は `run*` を呼ばない
- MCP は `effect/ai`、CLI は `effect/cli`、外への HTTP は `effect/http` の `HttpClient`。公式 MCP SDK・自前の引数解析・素の `fetch` は使わない（例外は `google-auth-library` の OAuth）
- `effect` と `@effect/*` は exact pin。unstable のモジュールの破壊的変更は pin を上げる差分で受け止める
- テストは `@effect/vitest`。現在時刻は `Clock`、テストでは `TestClock`
- `@effect/tsgo` の診断（`outdatedApi` を含む）を検査ゲートに入れる。unstable の警告は対象外

AGENTS.md（nyaucast は `CLAUDE.md` を置かない）の該当箇所:

> Effect の API は v3 と大きく違うので、書く前に `node_modules/effect/AGENTS.md` を読む

effect の npm パッケージには `AGENTS.md`・`CLAUDE.md`・`ai-docs/` が同梱されていて、中身は 4.0 の API で書かれている（`node_modules/effect/`）。

つまずきの記録（nyaucast `docs/knowledge/2026-10-01.md`・`2026-10-03.md`）:

1. エージェントは学習データの多い v3 の書き方で書きがち。型検査だけでは防げないので `outdatedApi` を error にし、わざと v3 の API を書いて落ちること・消して通ることを確かめた
2. `@effect/vitest@4.0.0` は vitest 5 を要求する。当時の vite-plus 0.3.0 は vitest 4.1.11 だったので、vite-plus を 1.0 に上げた（このリポジトリは vitest `^5.0.3` なので当たらない）
3. 一時期「`@effect/vitest` が使えないので TestClock の利点は得られない」と言ったが、`TestClock.layer()` を手で注入すれば素の vitest でも使える。ラッパが無いことと機能が使えないことは別
4. Effect の定型がコピペ検出に重複として拾われた
5. `Effect.promise` は reject を defect にする（上の 2 節）

**判定**

- `node_modules/effect/AGENTS.md` を書く前に読む、の一文を AGENTS.md に置く: **採る**
- 方針を ADR に 1 本でまとめる（Service と Layer、runMain の場所、unstable の扱い、テスト、診断）: **採る**。#193 の Destination の「方針は ADR に残す」の雛形にできる
- 「混在の期間を作らない一括移行」: **変えて採る**。nyaucast は takt に 1 本で任せた。live-mindmap も「中途半端に Effect 対応しない」と決めているが、`server.ts` の 629 行を先に #197 の試作で形を決めてから他を合わせる順番になっている。順番の決め方は #193 のチケットに任せる
- 1 MCP tool = 1 ファイル、registry を置かない（ADR 0001 決定 1・2）: live-mindmap には MCP tool が無い。**採らない**

## 採るものの一覧

| 項目 | 判定 | このリポジトリでの置き場 |
| --- | --- | --- |
| tsconfig の plugin 欄で `outdatedApi: "error"`・`unstableApiUsage: "off"` | 採る | `server/tsconfig.json` |
| `effect-tsgo diagnostics` を型検査に足す | 採る | `server/package.json` の `typecheck` |
| effect と `@effect/*` の exact pin | 採る | `server/package.json` |
| `Context.Service` + static `layer`、`Scope` で資源を閉じる | 採る | `server.ts`・`claude.ts`・`helperSocket.ts`・`ws.ts` |
| `runMain` は entry point だけ（テストで守る） | 変えて採る | `server.ts` と `cli.ts` の 2 本を許す |
| `Schema.TaggedError` で事実だけを持つ失敗 | 採る | `RequestError` の置き換え |
| 境界で 1 か所だけ変換（CLI は `describeFailure` の形） | 変えて採る | HTTP は「タグ → ステータス」を 1 か所に |
| `Effect.tryPromise`（`Effect.promise` を使わない） | 採る | Agent SDK・`ws` を包む所 |
| `Schema.fromJsonString` + `decodeUnknownEffect` で外のデータを検証 | 採る | `core/intake.ts` など |
| ドメインの型をすべて Schema に | 変えて採る | 外と出入りする型から |
| `effect/process` の `ChildProcess`（`forceKillAfter`） | 採る（#197 で確かめる） | ヘルパーの起動と停止 |
| `effect/http` サーバー・`effect/socket` | 手本なし | #193 の未決のまま |
| `effect/cli` + `Command.provide` | 変えて採る | `cli.ts` |
| `it.effect` + `TestClock`、`forkChild` → `adjust` → `join` | 採る | 起動し直し・SIGKILL のテスト |
| `Service.of` の偽物、使わない依存は `Effect.die` の Layer | 採る | `ServerOptions` の差し替え |
| `throw`・`Date.now()` が無いことをテストで守る | 採る（置き換えの後） | `server/test/` |
| `node_modules/effect/AGENTS.md` を読む指示 | 採る | `AGENTS.md` |
| `--conditions` で src と dist を切り替える | 採らない | npm に出さないので不要 |
| 1 tool = 1 ファイル、registry を置かない | 採らない | MCP tool が無い |
