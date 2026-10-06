# Effect 4 でヘルパーのライフサイクルを書くための API

issue #195（マップ #193）の調査結果。`server/src/server.ts` のヘルパーのライフサイクル（`child_process` で起動、予期せず終わったら同じセッションへ起動し直す #161、stop で SIGTERM → 5 秒後に SIGKILL、開始の失敗・stop・サーバーの終了で updater を閉じる、WebSocket の listen とポート）を、**`effect@4.0.1` の安定した API だけ**で書くときに使うモジュールと関数をまとめる。

調べた日: 2026-10-06。対象: `effect@4.0.1`（npm の latest、2026-10-05 公開）と `@effect/vitest@4.0.1`。

## 出典と、先に知っておくこと

- **ソース**: npm の `effect-4.0.1.tgz` を展開した `package/src/`（以下「ソース」）。シグネチャと内部実装はここで確かめた。タグ `effect@4.0.1` は https://github.com/Effect-TS/effect/tree/effect@4.0.1/packages/effect/src
- **effect-smol は Effect-TS/effect へ移った**。https://github.com/Effect-TS/effect-smol の main は `4.0.0-beta.98`（2026-07-14）で止まっていて、`effect@4.0.1` の `repository` は `Effect-TS/effect`（`npm view effect@4.0.1 repository`）。MIGRATION.md と `migration/*.md` も Effect-TS/effect の main にある: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- **effect.website の v4 の資料**は `/docs/v4/` 以下（`/docs/` は `/docs/v4/onboarding` へ転送される）。Markdown 版が `.md` で取れる（例: https://effect.website/docs/v4/resource-management/scope.md ）。スケジュールの章（`/docs/v4/scheduling/*`）はまだ無い（404）
- この文書のコード断片は、`effect@4.0.1`・`@effect/vitest@4.0.1`・`vitest@5.0.3`・`ws` で scratch に作って **`tsc --strict` を通し、TestClock のテストと実プロセスのテストを実行して通した**もの（リポジトリには入れていない）

### 「`effect/unstable/*` を使わない」は 4.0 では読み替えが要る

マップ #193 の Notes にある「`effect/unstable/*` と platform-node の socket・HTTP は使わない」は、4.0 正式版では import のパスで判断できなくなった。

> v4 includes **unstable modules** under `effect/*` import paths. Their paths no longer contain an `unstable` segment, but their API documentation is marked with `@stability unstable`.
> …Unstable modules include: `ai`, `cli`, `cluster`, `devtools`, `eventlog`, `http`, `http-api`, `jsonschema`, `observability`, `persistence`, `process`, `reactivity`, `rpc`, `schema`, `socket`, `sql`, `workflow`, `workers`.
> Moving these modules does not stabilize their APIs.
> — MIGRATION.md「Unstable Module System」

- `effect/unstable/process` は `effect/process`（`ChildProcess`・`ChildProcessSpawner`）に、`effect/unstable/socket` は `effect/socket` になった。旧パスの互換 export は無い。ソースの `process/ChildProcess.ts` には `@stability unstable` が 42 か所ある
- 方針は「**`@stability unstable` の付いた API を使わない**」と書き直すのがよい。この文書で使うモジュール（`Effect`・`Scope`・`Fiber`・`Deferred`・`Queue`・`PubSub`・`Schedule`・`Stream`・`Layer`・`Context`・`FiberHandle`・`FiberSet`・`Latch`・`Clock`・`Cause`・`Exit`・`Option`・`Result`・`Data`・`Duration`・`Runtime`・`testing/TestClock`）は、ソースに `@stability` が 1 つも無い＝ strict semver（「APIs without a stability tag follow strict semver」MIGRATION.md）
- 安定かどうかは**モジュール単位ではなく API 単位**で付く。たとえばトップレベルの `Schema`（`import { Schema } from "effect"`。unstable 一覧の `effect/schema` ディレクトリとは別物）は大半が安定だが、`MacAddress`・`Ipv4Address` などの 120 か所に `@stability unstable` が付いている。使う API ごとに JSDoc を見る
- `@effect/platform-node` の `NodeRuntime.runMain` には `@stability` が無い（安定）。HTTP・socket（`NodeHttpServer`・`NodeHttpClient`・`NodeClusterSocket` など）には付いている

## 1. Scope・acquireRelease・addFinalizer・Layer の後始末

### 名前とシグネチャ（ソース `Effect.ts`・`Scope.ts`）

```ts
Effect.acquireRelease<A, E, R, R2>(
  acquire: Effect<A, E, R>,
  release: (a: A, exit: Exit<unknown, unknown>) => Effect<unknown, never, R2>,
  options?: { readonly interruptible?: boolean }
): Effect<A, E, R | R2 | Scope>

Effect.acquireUseRelease(acquire, use, release)        // 1 つの式で取る・使う・放す
Effect.addFinalizer<R>(finalizer: (exit: Exit<unknown, unknown>) => Effect<void, never, R>): Effect<void, never, R | Scope>
Effect.acquireDisposable(acquire)                      // 4.0 で追加。Symbol.dispose / asyncDispose を持つもの
Effect.scoped(self)                                    // 新しい Scope を作り、self の終わりで閉じる
Effect.scopedWith((scope) => ...)
Effect.ensuring(self, finalizer) / Effect.onExit(self, f) / Effect.onInterrupt(self, f) / Effect.onError(self, f)

Scope.make(strategy?: "sequential" | "parallel"): Effect<Scope.Closeable>   // 既定は "sequential"
Scope.close(scope, exit): Effect<void>
Scope.provide(scope)(effect)        // 3.x の Scope.extend
Scope.fork(parent, strategy?)       // 子 Scope（親が閉じると閉じる）
Scope.addFinalizer(scope, effect) / Scope.addFinalizerExit(scope, (exit) => effect)
```

- 3.x の `Effect.acquireReleaseInterruptible` は無くなり、`acquireRelease(..., { interruptible: true })` になった（migration/v3-to-v4.md）
- `Layer.scoped` は無くなり、**`Layer.effect` が Scope を受け持つ**（「Scoped acquisition was merged into Layer.effect」v3-to-v4.md）。`Layer.scope` も無い

### 後始末の順番（内部実装で確かめた）

`internal/effect.ts` の `scopeCloseFinalizers`:

- 登録の**逆順**（LIFO）に走る。`for (let i = arr.length - 1; i >= 0; i--)`
- `"sequential"`（既定）なら 1 つずつ、`"parallel"` なら全部を fork して待つ
- 後始末の 1 つが失敗しても残りは走り、全部の `Exit` をまとめる（`exitAsVoidAll`）
- **すでに閉じた Scope に後始末を足すと、その場で走る**（`scopeAddFinalizerExit`: `if (scope.state._tag === "Closed") return finalizer(scope.state.exit)`）
- `Scope.close` は呼んだファイバーを中断不可にしてから後始末を走らせる（`scopeClose` の `fiberEnterUninterruptibleUnsafe`）。後始末の途中で中断されない

Layer の順番（`Layer.ts`）:

- `Layer.provide(self, that)` は `that` を先に作り、同じ Scope で `self` を作る（`provideWith`）。LIFO なので **依存される側（that）が後に閉じる**
- `Layer.merge` / `Layer.mergeAll` は `"parallel"` の子 Scope の下に、レイヤーごとの `"sequential"` の Scope を作って並行に作る（`mergeAllEffect`）。だから**兄弟のレイヤーの後始末は並行**で、順番は決まらない
- 4.0 では Layer の memo が `Effect.provide` の呼び出しをまたいで共有される（migration/layer-memoization.md。`{ local: true }` で止められる）

### 中断（interrupt）が後始末に届く保証

- `acquireRelease` の `acquire` は既定で中断不可の区間で走り、成功したら同じ区間で `release` を Scope に登録する（`internal/effect.ts` の `acquireRelease` は `uninterruptibleMask` の中で `tap(acquire, (a) => scopeAddFinalizerExit(...))`）。だから「取れたのに後始末が登録されない」すき間は無い
- `{ interruptible: true }` を付けると `acquire` の待ちは中断できる。そのとき取れていない資源の後始末は `release` ではなく、`acquire` の中で書く（下の `Effect.callback` の戻り値）
- `Effect.scoped` は `onExitUnsafe` でファイバーの終わり（成功・失敗・中断のどれでも）に Scope を閉じる
- `Fiber.interrupt` は**後始末が終わるまで待つ**（v3-to-v4.md: 「Fiber.interrupt waits for cleanup」）。待たずに中断だけ送るのは `fiber.interruptUnsafe()`（3.x の `Fiber.interruptFork`）
- effect.website の Scope の章も「finalizers are executed in the reverse order」「The acquisition process is uninterruptible」と書いている（https://effect.website/docs/v4/resource-management/scope.md ）

確かめたテスト（`@effect/vitest` で通った）:

```ts
it.effect("後始末は逆順・中断でも走る", () =>
  Effect.gen(function*() {
    const log: Array<string> = []
    const fiber = yield* Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => log.push("updater")))
      yield* Effect.addFinalizer(() => Effect.sync(() => log.push("helper")))
      yield* Effect.never
    }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))
    yield* Fiber.interrupt(fiber)
    assert.deepStrictEqual(log, ["helper", "updater"])
  }))
```

### このリポジトリへの当てはめ

- **LIFO は今の stop の順番と合わないところがある**。今の stop は「SIGTERM を送る・ws の close を待つ（close の前に届いた発言を push し終える）→ `ws.terminate()` → `settling.drain()`」。ws はヘルパーの後に取るので、後始末だけに任せると **ws の後始末（terminate）がヘルパーの停止より先に走る**。正常な stop の順番（ヘルパー停止 → 読み取りの終わりを待つ → drain）は本体に明示的に書き、後始末（finalizer）は中断・失敗のときの安全網にする、と分けるのがよい（下の §4 の `runAttempt` の形）
- updater は「セッションの Scope」に `acquireRelease` で置けば、開始の失敗・stop・サーバーの終了のどれでも閉じる（今の `catch` の `updater?.close()`、`finally` の `live.updater.close()`、`close()` の中の `updater.close()` の 3 か所が 1 つになる）
- 今の `close()` の `closing` フラグ（freePort の後で spawn しない）は、Scope が閉じたら `acquireRelease` の acquire が走らない・閉じた Scope への `forkIn` はすぐ中断される（下の §2）ことで置き換えられる

## 2. Fiber の fork・監視・中断、終了の待ち合わせ

### fork の名前（migration/forking.md）

| 3.x | 4.0 | 寿命 |
| --- | --- | --- |
| `Effect.fork` | `Effect.forkChild` | 親ファイバーが終わると中断される（auto supervision） |
| `Effect.forkDaemon` | `Effect.forkDetach` | 親と無関係（グローバル） |
| `Effect.forkScoped` | `Effect.forkScoped`（同じ） | 今の Scope が閉じると中断される。親より長生きできる |
| `Effect.forkIn` | `Effect.forkIn`（同じ） | 渡した Scope が閉じると中断される |
| `Effect.forkAll`・`Effect.forkWithErrorHandler` | 削除 | 個別に fork し `Fiber.await` で見る |
| `Effect.daemonChildren` | `Effect.awaitAllChildren`（意味が違う） | |

4.0 では全部に `{ startImmediately?: boolean; uninterruptible?: boolean | "inherit" }` を渡せる。既定では fork したファイバーは**次の tick で始まる**（`forkUnsafe` は `scheduleTask` に積む）。fork した直後に同期的なイベントを待ち受ける必要があるなら `startImmediately: true`。

内部（`internal/effect.ts`）:

- `forkChild` は親の `children()` に入る（親の終わりで中断）
- `forkIn(scope)` は **daemon として fork し、Scope に「そのファイバーを中断する」後始末を登録**する。ファイバーが先に終われば後始末を外す。**Scope がすでに閉じていたら、fork した直後に中断する**
- `forkScoped` は `forkIn(今の Scope)`

### Fiber（ソース `Fiber.ts`）

```ts
Fiber.join(fiber): Effect<A, E>            // 失敗も伝える
Fiber.await(fiber): Effect<Exit<A, E>>     // Exit で受け取る（3.x と同じ）
Fiber.interrupt(fiber): Effect<void>       // 後始末が終わるまで待つ
Fiber.interruptAs / interruptAll / joinAll / awaitAll
fiber.addObserver((exit) => ...)           // 戻り値は登録解除の関数
fiber.interruptUnsafe()                    // 待たずに中断
```

- **4.0 の `Fiber` は Effect ではない**。3.x のように `yield* fiber` とは書けず、`yield* Fiber.join(fiber)` と書く（v3-to-v4.md: 「The v4 Fiber is the concrete runtime handle and is no longer itself an Effect」）
- `Fiber.map`・`Fiber.zip`・`Fiber.orElse` などの合成は削除

### 1 つだけ持つ・まとめて持つ（`FiberHandle`・`FiberSet`）

- `FiberHandle.make<A, E>(): Effect<FiberHandle<A, E>, never, Scope>` / `FiberHandle.run(handle, effect, { onlyIfMissing? })`: 1 本だけ持つ。新しく `run` すると前のファイバーを中断する。Scope が閉じると中のファイバーを中断する。「今の起動し直しのループ」を 1 本だけ持つのに合う
- `FiberSet.make()` / `FiberSet.run` / `FiberSet.makeRuntime<R>()`: 複数本。`makeRuntime` は「Effect を渡すと fork して `Fiber` を返す関数」を返し、Scope が閉じると全部中断する。`node:http` の `onRequest` のようなコールバックから Effect を起動する口に使える

### Deferred・Queue・PubSub の 4.0 での名前

- **Deferred**（名前は同じ）: `Deferred.make<A, E>()`・`Deferred.makeUnsafe()`・`Deferred.await`・`Deferred.succeed`・`Deferred.fail`・`Deferred.done`・`Deferred.complete`・`Deferred.isDone`・`Deferred.poll`。Effect の外（Node のコールバック）から完了させるのは `Deferred.doneUnsafe(deferred, Effect.succeed(x))`
- **Queue**（名前は同じ、中身が変わった）: `Queue.unbounded<A, E>()`・`Queue.bounded(n)`・`Queue.sliding`・`Queue.dropping`・`Queue.make({ capacity, strategy })`。`Queue.offer`・`Queue.offerUnsafe`・`Queue.take`・`Queue.takeAll`・`Queue.poll`。**4.0 の Queue はエラーの型 `E` を持ち、終わりを `Queue.end` / `Queue.endUnsafe` で知らせる**（`Queue<A, E | Cause.Done>` のとき。`take` は終わった Queue で `Cause.Done` で失敗する）。`Queue.fail`・`Queue.failCause`・`Queue.interrupt`・`Queue.shutdown` もある。`Queue.makeUnsafe` は export されていない（Effect の中で作る）
- **PubSub**（名前は同じ）: `PubSub.unbounded<A>()`・`PubSub.bounded`・`PubSub.publish`・`PubSub.subscribe(pubsub): Effect<Subscription<A>, never, Scope>`・`PubSub.take(subscription)`。**4.0 の PubSub は `Queue.Enqueue` を継承しない**ので、`Queue.offer(pubsub, x)` のような 3.x の書き方は使えない（v3-to-v4.md）。3.x の `TPubSub.subscribeScoped` 系の `Scoped` は無くなった
- 参考: `Latch`（`Latch.make`・`open`・`close`・`whenOpen`）も安定。3.x の `Effect.makeLatch` に当たる

### このリポジトリへの当てはめ

- 今の `watchForUnexpectedEnd`（`helper.exited.then(...)` と `stillOwns` の再確認）は、「1 回分の起動」を Effect にして `Deferred.await(helper.exited)` で待つ形にすると要らなくなる。stop・close は **そのファイバーを `Fiber.interrupt` するだけ**で、後始末が終わるまで待てる。`controller.aborted` と `closing` を見て回る必要も無くなる（中断は次の待ちの地点で届く）
- 起動し直しのループはセッションの Scope に `forkIn`（または `FiberHandle.run`）で置く。resume は同じハンドルへもう一度 `run` する

## 3. Schedule・Effect.timeout・TestClock

### Effect.timeout 系（ソース `Effect.ts`）

```ts
Effect.timeout(duration): Effect<A, E | Cause.TimeoutError, R>     // 時間切れで元の Effect を中断して失敗
Effect.timeoutOption(duration): Effect<Option<A>, E, R>           // 時間切れは Option.none
Effect.timeoutOrElse({ duration, orElse: () => Effect }): ...     // 3.x の timeoutFail / timeoutTo
Effect.sleep(duration) / Effect.delay(duration)
Effect.race(a, b)          // 先に「成功」した方
Effect.raceFirst(a, b)     // 先に「終わった」方（失敗でも）。負けた方は中断
```

- `Duration.Input` は `number`（ミリ秒）、`"5 seconds"` のような文字列、`Duration` などを受ける
- 3.x の `Cause.TimeoutException` は **`Cause.TimeoutError`** になった（v3-to-v4.md: 「TimeoutException becomes Cause.TimeoutError … raised by Effect.timeout」）。判定は `Cause.isTimeoutError`
- `timeoutOption` は内部で `raceFirst` を使う（`internal/effect.ts`）。`sleep` は `Clock` サービス経由（`clockWith((clock) => clock.sleep(...))`）なので TestClock で進められる

SIGTERM → 5 秒 → SIGKILL（scratch で型検査とテストを通した形）:

```ts
const stopHelper = (helper: Helper) =>
  Effect.gen(function*() {
    if (yield* Deferred.isDone(helper.exited)) return false
    helper.child.kill("SIGTERM")
    const exited = yield* Deferred.await(helper.exited).pipe(Effect.timeoutOption("5 seconds"))
    if (Option.isSome(exited)) return false
    yield* Effect.logWarning("SIGTERM から 5 秒経っても終わらないので SIGKILL で止めます")
    helper.child.kill("SIGKILL")
    yield* Deferred.await(helper.exited)
    return true // SIGKILL に切り替えた（録音の不完全の警告に使う）
  })
```

### Schedule（ソース `Schedule.ts`）

使いそうなもの: `Schedule.spaced(d)`・`Schedule.fixed(d)`・`Schedule.exponential(base, factor = 2)`・`Schedule.fibonacci`・`Schedule.recurs(n)`・`Schedule.during(d)`・`Schedule.upTo`・`Schedule.jittered`（4.0 は 0.8〜1.2 倍で固定）・`Schedule.while`・`Schedule.tap`・`Schedule.addDelay`・`Schedule.modifyDelay`・`Schedule.concat`・`Schedule.max`・`Schedule.min`・`Schedule.forever`・`Schedule.once`。

使い方は `Effect.retry(effect, schedule)` または `Effect.retry(effect, { schedule, times, while, until })`、`Effect.repeat` も同じ形。`Effect.retry` は**型付きの失敗だけ**を再試行し、defect と中断は再試行しない（`Effect.retry` の JSDoc の Gotchas）。

3.x からの名前の変更（v3-to-v4.md）:

| 3.x | 4.0 |
| --- | --- |
| `Schedule.intersect` | `Schedule.max`（遅い方の間隔。出力は選ばれた `Duration`） |
| `Schedule.union` / `Schedule.either` | `Schedule.min` |
| `Schedule.andThen` | `Schedule.concat` |
| `Schedule.whileInput` / `whileOutput` | `Schedule.while`（metadata の input・output を見る） |
| `Schedule.tapInput` / `tapOutput` | `Schedule.tap` |
| `Schedule.jitteredWith` | `Schedule.modifyDelay` |
| `Schedule.compose` / `zipWith` / `resetAfter` | 無し（`fromStep`・`toStep` で組み直す） |

このリポジトリへの当てはめ:

- 接続の再試行（今の `RETRY_MS = 200` で子が生きている間は時間切れなしで繰り返す）は `Effect.retry({ schedule: Schedule.spaced("200 millis") })` と、子の終了との `Effect.raceFirst` で書ける（下の §4 の `connectToHelper`）
- 起動し直しの判断（`decideIntakeRestart`: 続けて 3 回で諦める、60 秒より長く動いたら失敗の数を 0 に戻す）は **Schedule に載せない方がよい**。「動いた時間で数え直す」は 3.x の `resetAfter` に近いが 4.0 では削除された。純粋関数 `decideIntakeRestart` をそのまま使い、時刻は `Clock.currentTimeMillis` で取る（TestClock で 60 秒を進めてテストできる）。今の起動し直しには間隔が無いので、Schedule が要る場面は今のところ接続の再試行だけ

### TestClock（`effect/testing`）

- import は **`import { TestClock } from "effect/testing"`**（3.x の `effect/TestClock` から移った。v3-to-v4.md の Import Map）
- API: `TestClock.adjust(duration)`・`TestClock.setTime(timestamp)`・`TestClock.withLive(effect)`・`TestClock.layer(options?)`（`warningDelay` で「時間を使っているのに進めていない」警告の待ち時間）。時刻の読み取りは `Clock.currentTimeMillis`（3.x の `TestClock.currentTimeMillis` は無い）。3.x の `TestClock.adjustWith` も無い
- `@effect/vitest` の `it.effect` は `TestConsole.layer` と `TestClock.layer()` を入れて `Effect.scoped` で包む（`packages/vitest/src/internal/internal.ts` の `TestEnv`）。本物の時計で走らせるのは `it.live`
- 書き方の定石は「**テストする Effect を fork → `TestClock.adjust` → 結果を見る**」（`TestClock.ts` の JSDoc と https://effect.website/docs/v4/testing/testclock.md ）

SIGKILL までを確かめるテスト（scratch で通った）:

```ts
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

it.effect("SIGTERM で終わらなければ 5 秒後に SIGKILL", () =>
  Effect.gen(function*() {
    const { helper, signals } = fakeHelper({ ignoreTerm: true }) // kill() を記録し、SIGKILL でだけ exited を完了する偽物
    const fiber = yield* Effect.forkChild(stopHelper(helper))
    yield* TestClock.adjust("4999 millis")
    assert.deepStrictEqual(signals, ["SIGTERM"])
    yield* TestClock.adjust("1 millis")
    assert.isTrue(yield* Fiber.join(fiber))
    assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"])
  }))
```

注意: 本物の子プロセスやソケットを使うテストは、待つのが OS のイベントなので TestClock では進まない。その場合は `it.live`（または `TestClock.withLive`）にする。scratch では `it.live` で「子が先に終われば接続の再試行が中断されて `HelperExited` になる」を実プロセスで確かめた。

## 4. `child_process` と `ws` をコールバックから Effect に包む

### Effect.callback（3.x の `Effect.async`・`Effect.asyncEffect`）

```ts
Effect.callback<A, E = never, R = never>(
  register: (
    this: Scheduler,
    resume: (effect: Effect<A, E, R>) => void,
    signal: AbortSignal
  ) => void | Effect<void, never, R>
): Effect<A, E, R>
```

- `resume` は 1 回だけ効く（後の呼び出しは無視）。`register` が同期的に `resume` したら、そのまま続く
- **戻り値の Effect は「中断されたときだけ」走る後始末**（`asyncFinalizer` は中断の Cause のときだけ呼ぶ）。正常に `resume` したときは走らない。だからイベントの登録解除を正常時にもしたいなら、`resume` の前に自分で外すか、`acquireRelease` で包む
- `signal`（`AbortSignal`）は `register` の引数が 2 つ以上のときだけ作られる（`register.length >= 2`）。中断で abort される
- 3.x の `Effect.async` の名前のまま書くと 4.0 では存在しない（v3-to-v4.md: 「`Effect.async` -> `Effect.callback`」）。`Effect.promise`・`Effect.tryPromise` は同じ名前

### Stream への変換（3.x の `Stream.async`・`asyncEffect`・`asyncPush`・`asyncScoped`）

```ts
Stream.callback<A, E = never, R = never>(
  f: (queue: Queue.Queue<A, E | Cause.Done>) => Effect<unknown, E, R | Scope>,
  options?: { bufferSize?: number; strategy?: "sliding" | "dropping" | "suspend" }
): Stream<A, E, Exclude<R, Scope>>

Stream.fromQueue(queue: Queue.Dequeue<A, E>): Stream<A, Exclude<E, Cause.Done>>
Stream.fromPubSub(pubsub)
Stream.fromEventListener(target, type, options?)   // DOM 風の addEventListener を持つもの向け
Stream.runForEach(stream, f) / Stream.runDrain / Stream.ensuring / Stream.onExit / Stream.interruptWhen
```

- 3.x の `emit.single(a)`・`emit.end()`・`emit.fail(e)` は、渡される Queue への `Queue.offer`（同期なら `Queue.offerUnsafe`）・`Queue.end`（`Queue.endUnsafe`）・`Queue.fail` / `Queue.failCause` になった（v3-to-v4.md の StreamEmit の項）。`StreamEmit` モジュールは無い
- `f` の戻り値の Effect は Scope を使える。イベントの登録と解除は `Effect.acquireRelease(on, off)` で書く（`Stream.fromEventListener` の実装がまさにこの形）
- Node の `EventEmitter`（`ChildProcess`・`ws` の `on`/`off`）には `Stream.fromEventListener` ではなく `Stream.callback` を使う

### 子プロセスを Scope の資源にする

```ts
type ExitInfo = { readonly code: number | null; readonly signal: NodeJS.Signals | null }
type Helper = { readonly child: ChildProcess; readonly exited: Deferred.Deferred<ExitInfo>; readonly stderr: () => string }

const spawnHelper = (command: string, args: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.sync((): Helper => {
      const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
      const exited = Deferred.makeUnsafe<ExitInfo>()
      let stderr = ""
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
      // "close" を使う理由は今の launchHelper と同じ（stderr の最後の data を取りこぼさない）
      child.once("close", (code, signal) => { Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })) })
      child.once("error", (e) => { stderr += String(e); Deferred.doneUnsafe(exited, Effect.succeed({ code: null, signal: null })) })
      return { child, exited, stderr: () => stderr }
    }),
    (helper) => stopHelper(helper) // §3。Scope が閉じれば、成功・失敗・中断のどれでも SIGTERM → 5 秒 → SIGKILL
  )
```

- 終了の監視を `Effect.callback` で後から張ると、張る前に終わったときを取りこぼす。spawn と同じ同期区間で `Deferred` に流しておけば、何度でも `Deferred.await` で待てる（今の `exited` の Promise と同じ考え方）

### 空きポート

```ts
const freePort = Effect.callback<number, PortError>((resume) => {
  const probe = createServer()
  probe.once("error", (cause) => resume(Effect.fail(new PortError({ cause }))))
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address()
    if (!address || typeof address === "string") return resume(Effect.fail(new PortError({ cause: address })))
    probe.close(() => resume(Effect.succeed(address.port)))
  })
  return Effect.sync(() => probe.close()) // 待っている間に中断されたとき
})
```

### WebSocket（早く届いたメッセージを取りこぼさない）

今の `helperSocket.ts` は「open を await してから購読すると、その間に流れたフレームが消える」ので early バッファを持つ。Effect では **`new WebSocket` と同じ同期区間で Queue に流す**だけで、その問題が無くなる。

```ts
const openOnce = (url: string, messages: Queue.Queue<RawData, Cause.Done>) =>
  Effect.callback<WebSocket, SocketNotOpen>((resume) => {
    const ws = new WebSocket(url)
    ws.on("message", (data) => Queue.offerUnsafe(messages, data))
    ws.once("close", () => Queue.endUnsafe(messages))   // close で Stream が終わる（今の wsClosed）
    ws.once("open", () => resume(Effect.succeed(ws)))
    ws.once("error", () => { ws.terminate(); resume(Effect.fail(new SocketNotOpen())) })
    return Effect.sync(() => ws.terminate())
  })

const connectToHelper = (helper: Helper, port: number) =>
  Effect.gen(function*() {
    const messages = yield* Queue.unbounded<RawData, Cause.Done>()
    const ws = yield* Effect.acquireRelease(
      openOnce(`ws://127.0.0.1:${port}`, messages),
      (ws) => Effect.sync(() => ws.terminate()),
      { interruptible: true } // 開くのを待つ間も、子の終了で中断できるように
    )
    return { ws, messages }
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("200 millis") }),   // 子が生きている間は時間切れなしで再試行
    Effect.raceFirst(
      Deferred.await(helper.exited).pipe(
        Effect.flatMap((info) => Effect.fail(new HelperExited({ info, stderr: helper.stderr() })))
      )
    )
  )
```

### 1 回分の起動と、起動し直しのループ

```ts
const runAttempt = (command: string, buildArgs: (port: number) => ReadonlyArray<string>, onMessage: (d: RawData) => Effect.Effect<void>) =>
  Effect.scoped(
    Effect.gen(function*() {
      const port = yield* freePort
      const helper = yield* spawnHelper(command, buildArgs(port))
      const socket = yield* connectToHelper(helper, port)
      const reader = yield* Stream.fromQueue(socket.messages).pipe(Stream.runForEach(onMessage), Effect.forkScoped)
      const info = yield* Deferred.await(helper.exited)
      yield* Fiber.join(reader) // ws の close まで届いた発言を処理し終える（今の await running.wsClosed）
      return { info, stderr: helper.stderr() }
    })
  )
// stop・close はこのファイバーを Fiber.interrupt する。Scope が閉じて ws の terminate → stopHelper の順に走る

const intakeLoop = (attempt: Effect.Effect<{ info: ExitInfo; stderr: string }, HelperExited | PortError>) =>
  Effect.gen(function*() {
    let failures = 0
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(attempt)
      const ranMs = (yield* Clock.currentTimeMillis) - startedAt
      const decision = decideIntakeRestart({ failures, ranMs }) // core の純粋関数をそのまま
      failures = decision.failures
      if (decision.action === "giveup") return { kind: "stopped" as const, exit }
    }
  })
```

- 中断で止めるときは、§1 のとおり LIFO で **ws の terminate が先、`stopHelper` が後**になる。stop で「close の前に届いた発言を全部 push してから書き出す」を守るなら、stop は中断の前に `helper.child.kill("SIGTERM")` を送り、`Fiber.join(attemptFiber)`（ヘルパーが終わり、ws が閉じ、reader が読み終えるまで）を `timeout` 付きで待ってから中断する、のように本体に書く。中断だけに頼るのは close（サーバーの終了）のときにする
- セッションの Scope は `Scope.make()` で作り、updater を `Effect.acquireRelease(open, close).pipe(Scope.provide(scope))` で置き、ループを `Effect.forkIn(scope)` で置く。stop の最後に `Scope.close(scope, exit)`

### サーバー全体の終わり

- `@effect/platform-node` の `NodeRuntime.runMain(effect)`（安定）は SIGINT・SIGTERM でメインのファイバーを中断し、後始末を走らせてから終了コードを決める（`packages/platform/node-shared/src/NodeRuntime.ts`）。今の `process.on(signal, () => server.close()...)` に当たる。依存を増やしたくなければ、同じものが core の `Runtime.makeRunMain` で作れる
- 4.0 は core の実行時が keep-alive のタイマーを持つので、`Deferred.await` で待っているだけでもプロセスが終わらない（migration/fiber-keep-alive.md）。3.x のように `runMain` が無いと勝手に終わる、ということは無い
- スナップショットの HTTP・WebSocket サーバー（`node:http` と `ws` の `WebSocketServer`）は、`Layer.effect` + `Effect.acquireRelease(listen, close)` で包み、`Layer.launch(layer)`（`scoped(build(layer) → never)`）または `Effect.never` で保つ。`onRequest` のようなコールバックから Effect を走らせるのは `FiberSet.makeRuntime()` が返す関数（Scope が閉じると走っている処理を中断する）か、`Effect.context<R>()` で取った Context を `Effect.runForkWith(context)` に渡す

## 5. 3.x からの名前の変更で、3.x の資料が使えない箇所

ヘルパーのライフサイクルとこのマップで関わるものだけ。出典は migration/*.md と migration/v3-to-v4.md。

| 3.x | 4.0 | 注意 |
| --- | --- | --- |
| `Context.Tag(id)<Self, Shape>()` / `Effect.Tag` / `Context.GenericTag` | `Context.Service<Self, Shape>()(id)` / `Context.Service<T>(id)` | `Effect.Tag` のアクセサは `.use` になった |
| `Effect.Service<Self>()(id, { effect, dependencies })` | `Context.Service<Self>()(id, { make })` | **`.Default` の Layer は自動で作られない**。`Layer.effect(this, this.make)` を自分で書く。`dependencies` は無く `Layer.provide`。慣習は `.layer` |
| `Layer.scoped` | `Layer.effect` | Scope は `Layer.effect` が受け持つ |
| `Either`（`effect/Either`） | `Result`（`effect/Result`） | `Effect.either` → `Effect.result` |
| `Effect.catchAll` / `catchAllCause` / `catchAllDefect` / `catchSome` | `Effect.catch` / `catchCause` / `catchDefect` / `catchFilter` | `catchTag`・`catchTags`・`catchIf` は同じ |
| `Effect.async` / `asyncEffect` | `Effect.callback` | 戻り値の後始末は中断のときだけ |
| `Stream.async` / `asyncEffect` / `asyncPush` / `asyncScoped` | `Stream.callback` | Emit ではなく Queue |
| `Effect.fork` / `forkDaemon` | `Effect.forkChild` / `forkDetach` | `forkScoped`・`forkIn` は同じ |
| `yield* fiber` | `yield* Fiber.join(fiber)` | Fiber は Effect ではない |
| `Fiber.interruptFork` | `fiber.interruptUnsafe()` | `Fiber.interrupt` は後始末まで待つ |
| `Effect.acquireReleaseInterruptible` | `Effect.acquireRelease(a, r, { interruptible: true })` | |
| `Scope.extend` | `Scope.provide` | |
| `Effect.timeoutFail` / `timeoutTo` | `Effect.timeoutOrElse` | `TimeoutException` → `Cause.TimeoutError` |
| `effect/TestClock` | `effect/testing`（`TestClock`） | `TestClock.currentTimeMillis` は `Clock.currentTimeMillis` |
| `FiberRef` | `Context.Reference` | migration/fiberref.md |
| `Runtime<R>`・`Runtime.runFork(runtime)` | `Context<R>`・`Effect.runForkWith(context)` | migration/runtime.md |
| `Effect.zipLeft` / `zipRight` | 無し | `Effect.tap` / `Effect.andThen` |
| `Schedule.intersect` / `union` / `andThen` / `resetAfter` | `Schedule.max` / `min` / `concat` / 無し | §3 |
| `effect/unstable/process` など | `effect/process` など | パスで安定かどうかを判断できない（冒頭） |
| `Effect.provide` ごとに Layer を作り直す | `Effect.provide` をまたいで memo を共有 | migration/layer-memoization.md |

effect.website について:

- `/docs/v4/` 以下は 4.0 の名前で書かれている（Fibers・Queue・TestClock の章は `Effect.forkChild`・`effect/testing` を使っている）。検索で出てくる `/docs/` 直下の古い URL や、ブログ・Q&A の 3.x の例（`Effect.fork`・`Effect.async`・`Layer.scoped`・`Context.Tag`・`Either`）はそのままでは型が通らない
- v4 の章にはまだスケジュール（Schedule）の章が無い。Schedule は `Schedule.ts` の JSDoc と v3-to-v4.md の対応表を見る
- Fibers の章（https://effect.website/docs/v4/concurrency/fibers.md ）の「`forkScoped` のファイバーは親より長生きできる、Scope が閉じると終わる」は、ソースの `forkIn`（daemon として fork し、Scope に中断を登録）と一致する

## まとめ（issue の問いへの答え）

1. **後始末**: `Effect.acquireRelease`（取るのは中断不可、後始末は必ず登録）・`Effect.addFinalizer`・`Effect.scoped`・`Scope.make`/`Scope.close`/`Scope.provide`。順番は登録の逆順、既定は 1 つずつ、`Scope.close` は中断不可。Layer は `provide` の依存側が後に閉じ、`merge` の兄弟は並行に閉じる。中断は `Fiber.interrupt` から Scope の後始末まで届き、`Fiber.interrupt` は終わるまで待つ
2. **Fiber**: `Effect.forkChild`（親と一緒に終わる）・`forkScoped`/`forkIn`（Scope と一緒に終わる）・`forkDetach`。待つのは `Fiber.join`/`Fiber.await`、止めるのは `Fiber.interrupt`。1 本だけ持つなら `FiberHandle`。`Deferred`・`Queue`・`PubSub` は同じ名前だが、Queue は `Cause.Done` で終わりを表し、PubSub は Queue を継承しない
3. **時間**: `Effect.timeoutOption("5 seconds")` で SIGKILL への切り替え、`Schedule.spaced("200 millis")` で接続の再試行。起動し直しの判断は Schedule にせず `decideIntakeRestart` と `Clock.currentTimeMillis`。テストは `@effect/vitest` の `it.effect` で fork → `TestClock.adjust` → 確認
4. **包み方**: 一度きりの結果は `Effect.callback`、続くイベントは `Stream.callback`（または同期区間で `Queue.offerUnsafe` して `Stream.fromQueue`）、終了は spawn と同時に `Deferred.doneUnsafe`
5. **名前**: §5 の表。特に `Effect.Service` の `.Default` が無いこと、`Layer.scoped` が無いこと、Fiber が Effect でないこと、`unstable` がパスから消えたこと
