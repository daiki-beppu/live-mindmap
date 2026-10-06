# Effect 4 でヘルパーのライフサイクルを書くための API（Issue #195）

マップ #193（server を Effect 4 へ全面的に置き換える）の調査チケット。`server/src/server.ts`・`helperSocket.ts`・`ws.ts`・`claude.ts` が今やっていることを、Effect 4（`effect@4.0.1`）のどの API で書けるかを、**安定した API だけで書く場合**と、**`@stability unstable` の `effect/process`・`effect/socket`・`effect/http` と `@effect/platform-node` を使う場合**の両方について調べた。

出典はすべて一次資料: npm に公開された `effect@4.0.1`・`@effect/platform-node@4.0.1`・`@effect/platform-node-shared@4.0.1`・`@effect/vitest@4.0.1` の tarball に入っている `src/`（下のリンクは同じファイルの GitHub 上のタグ `effect@4.0.1`）と、同じタグの `MIGRATION.md`・`migration/*.md`。行番号は 4.0.1 の `src/` のもの。コード片は API の名前と形を 4.0.1 のソースで確かめたが、**型検査・実行はしていない**。

## 結論

- **前提の訂正 1: v4 の正本は `Effect-TS/effect-smol` ではなく `Effect-TS/effect`。** effect-smol は archive 済みで README に「Effect V4 Has Moved」とあり、最終 push は 2026-07-14（`4.0.0-beta.98`）。`effect@4.0.1` の npm の `repository` は `Effect-TS/effect` の `packages/effect`。4.0.x の MIGRATION.md もそちらを読む必要がある（effect-smol の MIGRATION.md は beta 時代の古い内容）。
- **前提の訂正 2: 4.0.0 から `effect/unstable/*` というパスは無い。** 4.0.1 の MIGRATION.md（40〜66 行）によると、unstable なモジュールは `effect/http`・`effect/socket`・`effect/process` などの**パスに移り**、JSDoc の `@stability unstable` で区別する。`effect/unstable/<module>` の互換 export は無い。「Moving these modules does not stabilize their APIs.」。`@stability unstable` は**マイナーで**壊れうる、`@stability experimental` はパッチで壊れうる、タグ無しは strict semver。マップと #195 の「`effect/unstable/*`」は「`@stability unstable` のモジュール」と読み替える。
- **安定した API だけで今の動きはすべて書ける。** Scope・`Effect.acquireRelease`・`Effect.addFinalizer`・`Effect.callback`・`Deferred`・`Effect.timeoutOption`・`Schedule`・`FiberHandle`・`Stream.callback`・`Layer.effect` はどれも `@stability` タグ無し（strict semver）。`child_process`・`ws`・`node:http` はそのまま使い、コールバックを `Effect.callback` / `Stream.callback` で包む。
- **unstable の側は、今の作りとずれる点が 3 つある。** (1) `NodeChildProcessSpawner` は子を**既定で `detached: true`（新しいプロセスグループ）** で起動し、終わらせるときは**グループごと**シグナルを送る。(2) 終了の待ち合わせは Node の `"exit"` で、`"close"`（#161 で stderr の末尾を取りこぼさないために選んだ）ではない。(3) `exitCode` はシグナルで終わると `PlatformError` で失敗し、シグナル名は文の中にしか残らない（今は `{ code, signal }` をログ・`decideIntakeRestart` に渡している）。一方、SIGTERM→時間切れで SIGKILL は `kill({ forceKillAfter })` がそのまま持っており、ヘルパーへの WebSocket の「開いた直後のメッセージの取りこぼし」は `Socket.fromWebSocket` が open を待つ前に listener を付けてためるので、`helperSocket.ts` の工夫は不要になる。
- **TestClock で SIGKILL への切り替えまで確かめられる。** `@effect/vitest` の `it.effect` は `TestClock`・`TestConsole` と Scope を自動で与える。待ち時間を `Effect.sleep` / `Effect.timeout*` / `Schedule` で書いておけば、`TestClock.adjust("5 seconds")` で進められる。ただし子プロセスの終了そのもの（Node のイベント）は TestClock では進まないので、テストでは「子プロセス」を Service にして偽物を差し込む必要がある（下の「テスト」）。

## 今のコードがやっていること（Effect に移す対象）

| 場所 | やっていること |
|---|---|
| `server.ts` `launchHelper` | `spawn(command, args, { stdio: ["ignore","ignore","pipe"] })`。stderr を親の stderr へ流しつつ文字列にためる。終了は `"close"`（stdio が全部閉じた後）で `{ code, signal }` を解決。`"error"` でも解決 |
| `server.ts` `stopHelper` | 終わっていなければ SIGTERM、`HELPER_STOP_TIMEOUT_MS`（5 秒）で `"close"` が来なければ SIGKILL して待つ。SIGKILL したかを返す |
| `server.ts` `freePort` | `net.createServer().listen(0)` で空きポートを得て閉じる |
| `server.ts` `connectToHelper` | 子が生きている間は 200ms ごとに WebSocket の接続を再試行（時間切れ無し）。子が終わったら失敗 |
| `server.ts` `runRestartLoop` / `watchForUnexpectedEnd` | 予期せぬ終了で同じセッションへ起動し直す（#161）。stop・close が `controller.aborted` / `closing` で割り込む。接続成功と中断が競合したら、届いた発言を取り込んでから止める |
| `server.ts` `start` / `stop` / `close` | 開始の失敗・stop・サーバーの終了で updater・speaking・settling を閉じる。`close` は SIGINT/SIGTERM から |
| `helperSocket.ts` | `new WebSocket(url)` の直後から `message` をためる（`ws` は open と同じ塊のフレームを `process.nextTick` で流すため）。`listen` で溜めた分を先に渡す |
| `ws.ts` | `node:http` の `createServer` に `WebSocketServer({ server, verifyClient })` を載せる。Origin がローカルのものだけ。最新のスナップショット・speaking・intake を新しい接続へ送り直す。`close` は全クライアントを terminate → `wss.close` → `http.close` + `closeAllConnections` |
| `claude.ts` | Agent SDK の `query()` を開いたまま使い回す（ADR 0006）。`Promise.race([next(), aborted])` で close に中断させる |

## 1. Scope と後始末（安定）

- `Effect.acquireRelease(acquire, release, options?)` — 取得に成功したら `release(a, exit)` を今の Scope に足す。**取得は既定で中断されない**（`uninterruptibleMask`）。`{ interruptible: true }` で中断可能にする（v3 の `acquireReleaseInterruptible` はこれに統合）。出典: [Effect.ts L13053](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Effect.ts#L13053)、実装 [internal/effect.ts L4134](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/internal/effect.ts#L4134)、[v3-to-v4.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/v3-to-v4.md)（`Effect.acquireReleaseInterruptible -> Effect.acquireRelease`）。
- `Effect.addFinalizer((exit) => ...)` — Scope が閉じるときに走る。`exit` で成功・失敗・中断を見分けられる。[Effect.ts L13237](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Effect.ts#L13237)
- **順番**: Scope の後始末は**足した逆順**（`for (let i = arr.length - 1; i >= 0; i--)`）。`Scope.make("sequential" | "parallel")` で直列・並列を選べ、既定は直列。[internal/effect.ts L3973-L3998](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/internal/effect.ts#L3973)、[Scope.ts L239](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Scope.ts#L239)
- **中断が後始末に届く保証**: `Scope.close` は呼んだファイバーを中断不可に入れてから後始末を走らせる（`fiberEnterUninterruptibleUnsafe`）。[internal/effect.ts L3929](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/internal/effect.ts#L3929)。`Effect.scoped` は `onExit` で Scope を閉じるので、成功・失敗・中断のどれでも閉じる。後始末の途中で例外を投げても `exitDie` にされ、他の後始末は続く。
- `Effect.ensuring` / `Effect.onExit` / `Effect.onInterrupt` も残っている（[Effect.ts L13279](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Effect.ts#L13279)、L13662、L14753）。
- **Layer**: v3 の `Layer.scoped` は `Layer.effect` に統合（Layer の Scope を与えて除く）。`Layer.scopedDiscard` → `Layer.effectDiscard`。Layer の後始末は Layer の Scope が閉じるときに逆順に走る。[v3-to-v4.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/v3-to-v4.md)（`Layer.scoped -> Layer.effect`）、[Layer.ts L1345](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Layer.ts#L1345)
- `Scope.extend` → `Scope.provide`（[migration/scope.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/scope.md)）。

この repo への当てはめ: 「セッションの寿命ぶんのもの」（session・updater・speaking・settling。今の `Live`）を**セッションの Scope**、「ヘルパーごとのもの」（子プロセス・WebSocket・listen・ポート・終了の監視。今の `Intake.running`）を**その子の Scope**（`Scope.fork(sessionScope)`）に置けば、`stop`・開始の失敗・サーバーの終了の 3 か所に散っている `updater.close()` / `speaking.stop()` / `settling.stop()` / `ws.terminate()` は、それぞれ取得したところの `acquireRelease` 1 回に集まる。逆順なので「ヘルパーを止める → WebSocket を閉じる → settling を drain → updater を閉じる」の順も、足した順で決まる。

## 2. Fiber・待ち合わせ・中断（安定）

v4 での名前（[migration/forking.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/forking.md)）:

| v3 | v4 |
|---|---|
| `Effect.fork` | `Effect.forkChild` |
| `Effect.forkDaemon` | `Effect.forkDetach` |
| `Effect.forkScoped` / `Effect.forkIn` | 同じ名前 |
| `Effect.forkAll` / `forkWithErrorHandler` | 削除（`Fiber.join` / `Fiber.await` で結果を見る） |

- fork 系はどれも `{ startImmediately?, uninterruptible? }` を取る。
- `Fiber.join` / `Fiber.await` / `Fiber.interrupt` はそのまま。
- `FiberHandle`（1 本だけ持つ。`FiberHandle.run` で新しいのを走らせると**前のファイバーを中断**、`onlyIfMissing` で抑止）と `FiberSet` があり、どちらも Scope に紐づき、閉じると中のファイバーを中断する。[FiberHandle.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/FiberHandle.ts)。「今のヘルパー」（`server.ts` の `current`）や「起動し直しのループ」（`intake.settled`）は FiberHandle に置くと、`controller.aborted` と `closing` の確認を `Fiber.interrupt` に置き換えられる。
- `Deferred`: `Deferred.make` / `succeed` / `await` / `isDone` はそのまま。**v4 で Deferred は Effect の部分型でなくなった**ので、`yield* deferred` ではなく `yield* Deferred.await(deferred)` と書く（[v3-to-v4.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/v3-to-v4.md)）。
- `Queue`: `Queue.make` / `bounded` / `unbounded` / `offer` / `take` / `end` / `shutdown` / `await`。Queue に**エラー型と完了（`Cause.Done`）**が入り、`Queue.end` で終わりを知らせる。v3 の `awaitShutdown` → `Queue.await`。Queue も Effect の部分型でなくなった（`Queue.take` を明示）。
- `PubSub`: `PubSub.unbounded` / `publish` / `subscribe`。Queue.Enqueue を継承しなくなった。
- `Latch`（`make` / `open` / `close` / `whenOpen`）がある。
- 構造化並行: v4 の `forkChild` は親が終わると子を中断する。`Effect.daemonChildren` → `Effect.awaitAllChildren`。
- **プロセスの寿命**: v4 では中断したファイバーがあるとランタイムが keep-alive のタイマーを持つ（[migration/fiber-keep-alive.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/fiber-keep-alive.md)）。それでも `NodeRuntime.runMain` が推奨で、**SIGINT・SIGTERM でルートのファイバーを中断**し、終了コードを決める（[platform-node-shared NodeRuntime.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/platform/node-shared/src/NodeRuntime.ts)、`@stability` タグ無し）。`server.ts` 末尾の `process.on(signal, () => server.close()...)` はこれに置き換わり、後始末は全部 Scope の逆順に乗る。

## 3. 時間（安定）

- `Effect.timeout(d)` — 時間切れで `TimeoutError` で失敗し、**元の Effect は中断される**。`Effect.timeoutOption(d)` は `Option.none`、`Effect.timeoutOrElse({ duration, orElse })` は代わりの Effect。v3 の `timeoutFail` / `timeoutFailCause` / `timeoutTo` は `timeoutOrElse` に統合。[Effect.ts L8457・L8574・L8666](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Effect.ts#L8457)
- `Schedule`: `spaced` / `fixed` / `exponential` / `recurs` / `jittered` / `upTo` / `during` など（[Schedule.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Schedule.ts)）。`Effect.retry` は Schedule か `{ schedule, times, while, until }` を取る（L7353）。`Effect.repeatN` → `Effect.repeat({ times })`。
- 今の「子が生きている間は 200ms ごとに接続を再試行（時間切れ無し）」は `openSocket.pipe(Effect.retry(Schedule.spaced("200 millis")))` を、子の終了（`Deferred.await(exited)`）と `Effect.raceFirst` させれば書ける。`decideIntakeRestart`（失敗の数と 60 秒の判断）は純粋な core の関数なので、Schedule に載せ替えず、そのまま `Effect.gen` のループから呼ぶほうが今の仕様を崩さない（Schedule は「間隔」だけを持つので、「60 秒以上動いたら失敗の数を 0 に戻す」は Schedule の外になる）。

## 4. コールバックを包む定石（安定）

- `Effect.async` / `Effect.asyncEffect` → **`Effect.callback`**。登録関数は `(resume, signal: AbortSignal) => void | Effect<void>` で、返した Effect は**中断されたときの後始末**。`resume` は最初の 1 回だけ有効。[Effect.ts L1805](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Effect.ts#L1805)
- `Stream.async` / `asyncEffect` / `asyncPush` / `asyncScoped` → **`Stream.callback((queue) => Effect, { bufferSize?, strategy? })`**。`Queue.offerUnsafe` で流し、`Queue.end` で終わり、`Queue.fail` で失敗。登録の Effect は Scope を使えるので、`acquireRelease` で listener を外せる。既定はバッファ無制限。[Stream.ts L697](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Stream.ts#L697)、[v3-to-v4.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/v3-to-v4.md)（`Stream.async -> Stream.callback` ほか）
- `Stream.fromEventListener(target, type)` は DOM 形の `addEventListener` を持つ相手用（`ws` の `WebSocket` は `addEventListener` も持つが、Node の EventEmitter の `on` 形には使えない）。[Stream.ts L1412](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Stream.ts#L1412)
- `Effect.tryPromise` / `Effect.promise` はそのまま（L1329・L1403）。

### 安定した API だけで書いたヘルパーの子プロセス（素描・未検証）

```ts
import { Deferred, Effect, Option } from "effect"
import { spawn } from "node:child_process"

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null }

// 起動から Scope の終わりまで。Scope が閉じると SIGTERM → 5 秒で SIGKILL
const helperProcess = (command: string, args: string[]) =>
  Effect.gen(function*() {
    const exited = yield* Deferred.make<ExitInfo>()
    let stderr = ""
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
        child.stderr!.on("data", (chunk: Buffer) => { process.stderr.write(chunk); stderr += chunk })
        // "close" を使う理由は今の launchHelper と同じ（stderr の最後の data を取りこぼさない）
        child.once("close", (code, signal) => Deferred.doneUnsafe(exited, Exit.succeed({ code, signal })))
        child.once("error", (e) => { stderr += String(e); Deferred.doneUnsafe(exited, Exit.succeed({ code: null, signal: null })) })
        return child
      }),
      (child) => stop(child, exited)
    )
    return { child, exited: Deferred.await(exited), stderr: () => stderr }
  })

const stop = (child: ChildProcess, exited: Deferred.Deferred<ExitInfo>) =>
  Effect.gen(function*() {
    if (yield* Deferred.isDone(exited)) return false
    child.kill("SIGTERM")
    const done = yield* Deferred.await(exited).pipe(Effect.timeoutOption("5 seconds"))
    if (Option.isSome(done)) return false
    child.kill("SIGKILL")
    yield* Deferred.await(exited)
    return true
  })
```

`stop` は `acquireRelease` の release なので中断不可の中で走り、stop・開始の失敗・`runMain` の SIGTERM のどれでも同じ道を通る。`Effect.timeoutOption` は Clock を使うので TestClock で進む。

### 安定した API だけで書いたヘルパーへの WebSocket（素描・未検証）

`helperSocket.ts` の「開いた直後のフレームを取りこぼさない」は、**`new WebSocket` と同じ同期区間で `message` を Queue に流し始める**ことで満たせる（Queue が今の `early` 配列の代わりになる）。

```ts
const helperMessages = (url: string) =>
  Effect.gen(function*() {
    const queue = yield* Queue.unbounded<RawData, Cause.Done>()
    const ws = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const ws = new WebSocket(url)
        ws.on("message", (data) => Queue.offerUnsafe(queue, data))
        ws.once("close", () => Queue.endUnsafe(queue))
        return ws
      }),
      (ws) => Effect.sync(() => ws.terminate())
    )
    yield* Effect.callback<void, HelperUnreachable>((resume) => {
      ws.once("open", () => resume(Effect.void))
      ws.once("error", () => resume(Effect.fail(new HelperUnreachable())))
    })
    return { ws, messages: Stream.fromQueue(queue) }
  })
```

### 安定した API だけで書いたスナップショットのサーバー（`ws.ts`、方針だけ）

`createServer` と `WebSocketServer` を `Effect.acquireRelease` で作り、release に今の `close`（terminate → `wss.close` → `http.close` + `closeAllConnections`）を `Effect.callback` で包んで置く。listen も `Effect.callback`（`"error"` で失敗、成功でポートを返す）。`publish` / `speak` / `intake` は同期のままでよい（Service のメソッドを `Effect.sync` にするかは好み）。HTTP の受け口は `onRequest` の中で `Effect.runPromise` / `runFork` するか、`Effect.runForkWith(context)`（v3 の `Runtime.runFork` の後継。[migration/runtime.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/migration/runtime.md)）で、Layer から作った context を使って走らせる。

### `claude.ts` の開いた query

`Promise.race([q.output.next(), q.aborted])` は、`Effect.callback` か `Effect.tryPromise` で `next()` を包み、close を**ファイバーの中断**で表せば `aborted` の Promise は要らなくなる（`Effect.tryPromise` は中断時に `AbortSignal` を abort する）。query 自体は `acquireRelease(open, (q) => sync(() => { q.input.end(); q.query.close() }))` で、「14 回で開き直す」「失敗したら捨てる」は `ScopedRef`（[ScopedRef.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/ScopedRef.ts)、`@stability` タグ無し）か、自前の `Ref` + 子 Scope で書ける。どちらが ADR 0006 と相性が良いかはマップの別の未決事項なので、ここでは名前だけ挙げる。

## 5. unstable の側（`effect/process`・`effect/socket`・`effect/http` と `@effect/platform-node`）

### 安定性の扱い（MIGRATION.md L40-L66）

- `effect/process`・`effect/socket`・`effect/http`・`effect/http-api`・`effect/cli`・`effect/schema` などは `@stability unstable`。**マイナーで壊れうる**。パスに `unstable` は付かない。
- 第三者の依存を露出する API も unstable 扱い（例: `@effect/platform-node/Undici`、`ws` の options をそのまま取る引数）。
- 4.0.1 の数え: `process/ChildProcess.ts` に `@stability unstable` 42 か所、`socket/Socket.ts` 54、`http/HttpServer.ts` 20、`http/HttpRouter.ts` 45。
- `@effect/platform-node` の `NodeChildProcessSpawner` / `NodeHttpServer` / `NodeSocket` の**モジュール自体には `@stability` タグが付いていない**が、中身は unstable な `effect/process` / `effect/http` / `effect/socket` の Service を実装しているので、実質はそれに従う。`NodeHttpServer` の `websocket` option と `NodeSocketServer.makeWebSocket` / `layerWebSocket` は明示的に `@stability unstable`（`ws` の `ServerOptions` を露出するため）。
- `@effect/platform-node@4.0.1` は依存に `@effect/platform-node-shared`・`undici`、platform-node-shared が `ws@^8.22.0` を持つ。`ws` は結局入る。

### `ChildProcess` + `NodeChildProcessSpawner`

- `ChildProcess.make\`cmd ...\`` か `ChildProcess.make(command, args, options)` が **Effect そのもの**で、`ChildProcessSpawner | Scope` を要求して `ChildProcessHandle` を返す（Scope が閉じると子を止める）。[process/ChildProcess.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/process/ChildProcess.ts)
- `ChildProcessHandle`: `pid`・`exitCode: Effect<ExitCode, PlatformError>`・`isRunning`・`kill(options?)`・`stdin: Sink`・`stdout` / `stderr` / `all: Stream<Uint8Array>`・`unref`。[process/ChildProcessSpawner.ts L85-L131](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/process/ChildProcessSpawner.ts#L85)
- `KillOptions`: `killSignal`（既定 SIGTERM）と `forceKillAfter`（既定 undefined = **SIGKILL は送らない**）。今の「SIGTERM → 5 秒 → SIGKILL」は `handle.kill({ forceKillAfter: "5 seconds" })` で表せる。[ChildProcess.ts L254-L270](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/process/ChildProcess.ts#L254)。コマンドの options に `killSignal` / `forceKillAfter` を置けば、Scope が閉じるときの止め方にも使われる。
- Node の実装（[platform/node-shared/src/NodeChildProcessSpawner.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/platform/node-shared/src/NodeChildProcessSpawner.ts)）の挙動で、今の作りとずれる点:
  1. **既定で `detached: true`**（Windows 以外）。子は新しいプロセスグループの先頭になり、止めるときは `process.kill(-pid, signal)` でグループごと送る（[internal/nodeChildProcessSpawner.ts L9](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/platform/node-shared/src/internal/nodeChildProcessSpawner.ts#L9)、本体 L394-L493）。ターミナルの Ctrl+C はヘルパーへ直接届かなくなる（サーバーが SIGINT を受けて Scope 経由で止めることになる）。ヘルパーが孫を持たないなら害は小さいが、`detached: false` を明示すれば今と同じになる。モジュールの説明には「グループが消えて ID が再利用されると無関係なグループへ送る可能性」が明記されている。
  2. **`forceKillAfter` が無いと、Scope の後始末と `kill` は最大 1 秒だけ待って SIGKILL しない**。`forceKillAfter` があれば「その時間 + SIGKILL 後に最大 1 秒」。
  3. **終了の待ち合わせは `"exit"`**（L380）。`"close"` ではないので、`exitCode` が解決した時点で stderr の最後の `data` が届いていないことがある。stderr の末尾（`STDERR_TAIL_LINES`）が要るなら、`handle.stderr` の Stream を最後まで読み切ってから `exitCode` を見る順にする必要がある。
  4. **`exitCode` はシグナルでの終了を `PlatformError` にする**（L586-L595、メッセージに `Process interrupted due to receipt of signal: 'SIGKILL'`）。今の `{ code, signal }` を `intake-stopped` ログと `decideIntakeRestart` に渡す形は、そのままでは作れない（エラー文から読むことになる）。
  5. 終了コードが 0 以外で終わった子は、`exit` の時点でグループへも killSignal を送る（L564-L568）。
  6. `cwd` の検証に `FileSystem` と `Path` の Service を使う（`NodeServices.layer` などで与える）。
- 評価: 「SIGTERM → 時間切れで SIGKILL」「Scope で必ず止める」は手書きの素描とほぼ同じ量で、テストのしやすさも同じ（子プロセスの終了は実プロセスでしか起きない）。上の 3・4 のために `launchHelper` の「`"close"` で `{ code, signal }`」を作り直す必要があり、置き換える得は小さい。

### `Socket` + `NodeSocket`（ヘルパーへの WebSocket クライアント）

- `Socket.makeWebSocket(url, { openTimeout?, protocols?, highWaterMark? })` は `WebSocketConstructor` を要求する。`NodeSocket.layerWebSocketConstructor` は **`globalThis.WebSocket` があればそれを使い**（Node 24 にはある）、options がオブジェクトなら `ws` を使う。`layerWebSocketConstructorWS` で `ws` に固定できる。[platform/node/src/NodeSocket.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/platform/node/src/NodeSocket.ts)
- v4 の `Socket` は v3 の `run(handler)` ではなく、`reader: Effect<Reader, SocketError, Scope>`（`pull` で次の束を取る）と `writer` の形に変わっている。[socket/Socket.ts L104-L144](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/socket/Socket.ts#L104)。v3 の資料・例は使えない。
- `fromWebSocket` は **`message` の listener を付けてから open を待つ**（L1048-L1100）。open の前・open と同じ tick に届いたフレームはバッファに入り、最初の `pull` で渡る。`helperSocket.ts` の早期バッファの工夫はこれで不要になる。`ws` には `pause`/`resume` で背圧をかける（既定 64 KiB）。
- **open の時間切れは既定 10 秒**（`SocketOpenError` の `kind: "Timeout"`）。今は「子が生きている間は時間切れなし」なので、`openTimeout` を長めにするか、短いまま 200ms ごとの `Effect.retry` と子の終了の race で包む。
- 切断は `SocketError`（`SocketCloseError` など）で表される。`reader` を取得するたびに接続し直す作りなので、起動し直しで新しいポートへつなぐのは「新しい `Socket` を作る」になる（URL を `Effect<string>` でも渡せる）。

### `HttpServer` + `NodeHttpServer` + `NodeSocketServer`（ブラウザ向けの受け口）

- `NodeHttpServer.layer(() => http.createServer(), { port, host })` / `make` が Scope 付きの `HttpServer` を作り、Scope の終わりで閉じる（`gracefulShutdownTimeout`、`disablePreemptiveShutdown`）。`upgrade` イベントは `HttpServerRequest.upgrade` で `Socket` として受け取れる。WebSocket の部分は内部で `ws` の `WebSocketServer({ noServer: true })` を遅延生成する。[platform/node/src/NodeHttpServer.ts L67-L100・L146](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/platform/node/src/NodeHttpServer.ts#L67)
- `websocket` option（`@stability unstable`）は `ws` の `ServerOptions` から `noServer`・`server`・`host`・`port`・`path` を除いたもので、`verifyClient` は渡せる。ただし Origin の確認は upgrade の前に handler の中で `request.headers.origin` を見て 403 を返すほうが、HTTP の 403（`server.ts` の `onRequest`）と同じ場所に書ける。
- `NodeSocketServer.makeWebSocket(options)` / `layerWebSocket(options)`（`@stability unstable`）は `ws` の `WebSocketServer` を直接 Scope 付きで包む `SocketServer`（`run(handler)` で接続ごとに handler）。HTTP と同じポートで待ち受けたい今の作り（`ws.ts`）には、`NodeHttpServer` の upgrade のほうが合う。
- これを使うと、ルーティング（`HttpRouter`）・本文の Schema 検証・型付きエラーから HTTP ステータスへの変換が `effect/http` / `effect/http-api` の道具に乗る。そのぶん、**ルーター・リクエスト・レスポンスの型が全部 unstable**（マイナーで壊れうる）。マップの未決「`RequestError` を型付きエラーから HTTP ステータスへ」と一緒に決める必要がある。

## 6. テスト（`@effect/vitest` と TestClock）

- `@effect/vitest@4.0.1` の peer は `vitest >=5.0.0 <6.0.0`・`effect ^4.0.1`。
- `it.effect` は `Effect.scoped` と `TestConsole.layer` + `TestClock.layer()` を与える。`it.live` は Scope だけ（本物の時計）。[packages/vitest/src/internal/internal.ts L59・L386-L387](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/vitest/src/internal/internal.ts#L386)。v3 の `it.scoped` 相当は `it.effect` に含まれる。
- `TestClock` は `effect/testing/TestClock`（v3 の `effect/TestClock` から移動）。`adjust` / `setTime` / `withLive`。v3 の `TestClock.save` / `sleeps` は削除。定石は「テストする Effect を fork → `TestClock.adjust` → `Fiber.await` / join して確かめる」。[testing/TestClock.ts](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/testing/TestClock.ts)
- SIGKILL への切り替えを TestClock で確かめるには、子プロセスを Service（例 `HelperProcess`）にして、テストでは「SIGTERM を受けても終わらない偽物」を Layer で差し込む。`stop` を fork → `TestClock.adjust("5 seconds")` → 偽物が SIGKILL を受けたことを確かめる。実プロセスの終了は TestClock で進まないので、`NodeChildProcessSpawner` を使う場合も `ChildProcessSpawner` の Service を偽物にする（`ChildProcessSpawner.make` で作れる）か、`it.live` で実時間を待つかになる。

## 7. 3.x の資料が使えない主な箇所（v3 → v4）

出典: [MIGRATION.md](https://github.com/Effect-TS/effect/blob/effect@4.0.1/MIGRATION.md) と [migration/*.md](https://github.com/Effect-TS/effect/tree/effect@4.0.1/migration)（`v3-to-v4.md` は API の差分から生成された対応表）。

| v3 | v4 |
|---|---|
| `Context.Tag` / `Context.GenericTag` / `Effect.Tag` / `Effect.Service` | `Context.Service`（クラスは `Context.Service<Self, Shape>()("Id")`。`Default` Layer の自動生成は無い。`Layer.effect` を自分で書く） |
| `Either` / `Effect.either` | `Result`（`Success` / `Failure`）/ `Effect.result` |
| `Effect.async` / `asyncEffect` | `Effect.callback` |
| `Stream.async*` | `Stream.callback` |
| `Effect.fork` / `forkDaemon` | `Effect.forkChild` / `forkDetach` |
| `Effect.catchAll` / `catchAllCause` / `catchSome` | `Effect.catch` / `catchCause` / `catchFilter`（`catchTag` / `catchTags` は同じ） |
| `Effect.timeoutFail` / `timeoutTo` | `Effect.timeoutOrElse` |
| `Effect.acquireReleaseInterruptible` | `Effect.acquireRelease(..., { interruptible: true })` |
| `Layer.scoped` | `Layer.effect` |
| `Scope.extend` | `Scope.provide` |
| `Runtime<R>` / `Runtime.runFork(runtime)` | 削除 / `Effect.context<R>()` + `Effect.runForkWith(context)` |
| `FiberRef` | `Context.Reference` |
| `effect/TestClock` | `effect/testing/TestClock` |
| `Schema.TaggedErrorClass` | `Schema.TaggedError`（`Data.TaggedError` も残っている） |
| `@effect/platform/*` | `effect/*`（FileSystem・Path など安定）または `effect/http`・`effect/socket`・`effect/process`（unstable） |
| `effect/unstable/*`（4.0 の beta・rc） | `effect/*`（`unstable` を外す。互換 export 無し） |

`Deferred`・`Queue`・`Fiber`・`PubSub` は**名前は同じだが Effect の部分型でなくなった**ので、`yield* deferred` / `yield* queue` / `yield* fiber` の v3 の書き方は通らない。

## 選ぶときの目安（判断はマップの側で）

| | 安定した API だけ | unstable も使う |
|---|---|---|
| 子プロセス | `spawn` を `acquireRelease` で包み、`"close"` と `{ code, signal }` を今のまま保てる。SIGTERM→SIGKILL は `Deferred` + `timeoutOption` で 10 行ほど | `kill({ forceKillAfter })` が既にある。代わりにプロセスグループ・`"exit"`・シグナルの扱いを今の仕様に合わせ直す必要がある |
| ヘルパーへの WebSocket | `ws` + Queue で早期バッファを自分で書く（今とほぼ同じ量） | `Socket.makeWebSocket` が早期バッファと背圧を持つ。open の時間切れ（既定 10 秒）と再試行は自分で組む |
| ブラウザ向け HTTP + WebSocket | `node:http` + `ws` を `acquireRelease` で包む。ルーティング・本文の検証・エラーのステータス変換は自前 | `HttpRouter`・Schema 検証・型付きエラーの変換が揃う。ルーター周りの型がマイナーで壊れうる |
| 壊れうる範囲 | strict semver（4.x の間は壊れない） | マイナーごとに CHANGELOG を見る必要がある |

## 調べなかったこと

- Node 24 の strip-types・TS 7 で `effect@4.0.1` がそのまま動くか（マップの前提。このチケットの範囲外）。
- effect.website の v4 向けドキュメントの各ページ（今回はソースの JSDoc と MIGRATION.md で足りた）。
- 素描のコードの型検査と実行。
