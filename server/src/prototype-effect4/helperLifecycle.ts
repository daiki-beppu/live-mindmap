// PROTOTYPE（issue #197、マップ #193）: 使い捨て。main には入れない。
// server.ts のヘルパーのライフサイクル（起動・起動し直し #161・SIGTERM → 5 秒 → SIGKILL・stop・開始の失敗・サーバーの終了）を
// Effect 4 で書いた形。今の server.ts と並べて読み比べるためのもので、HTTP・セッションの中身（差分更新・書き出し）は
// IntakeSink の向こうに隠している。
//
// 形の要点
// - 外の世界（子プロセス・ポート・WebSocket）は Helpers という Service 1 つ。テストは偽物の Layer を渡す
// - 1 回分の起動（runAttempt）は 1 つの Scope。ヘルパーの停止はその Scope の後始末（安全網）
// - stop は中断しない。stopRequested を立てると、その回の stopper が SIGTERM を送り、ヘルパーが終わることで
//   接続待ち・読み取り・終了待ちのすべてがほどける。中断（Fiber.interrupt・Scope.close）はサーバーの終了だけが使う
// - セッションの Scope（updater・起動し直しのループ）は Sessions の Scope の子。サーバーの終了で Sessions の
//   Scope を閉じれば、開始中・起動し直し中を含めてすべて止まる（今の closing フラグ・controller.aborted・stillOwns が要らない）
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schedule, Schema, Scope, Stream } from "effect";
import { decideIntakeRestart, STDERR_TAIL_LINES, tailLines, type IntakeLogEvent, type IntakeStatus, type IntakeStatusReport } from "../core/index.ts";

export const HELPER_STOP_TIMEOUT = "5 seconds";
const CONNECT_RETRY = "200 millis";

// ---- 失敗（事実だけを持つタグ付きの失敗。HTTP のステータスへの対応は境界の 1 か所に置く）

export class HelperExited extends Schema.TaggedError<HelperExited>()("HelperExited", {
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stderr: Schema.String,
}) {}
export class PortUnavailable extends Schema.TaggedError<PortUnavailable>()("PortUnavailable", { cause: Schema.Defect() }) {}
export class SocketNotOpen extends Schema.TaggedError<SocketNotOpen>()("SocketNotOpen", {}) {}
export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", { state: Schema.Literals(["starting", "live", "stopping"]) }) {}
export class NoSession extends Schema.TaggedError<NoSession>()("NoSession", {}) {}
export class IntakeNotStopped extends Schema.TaggedError<IntakeNotStopped>()("IntakeNotStopped", {}) {}
export class RestartGaveUp extends Schema.TaggedError<RestartGaveUp>()("RestartGaveUp", { stderrTail: Schema.Array(Schema.String) }) {}
export class Aborted extends Schema.TaggedError<Aborted>()("Aborted", {}) {}

export type LaunchError = HelperExited | PortUnavailable;

// ---- 外の世界: 子プロセス・ポート・ヘルパーへの WebSocket

export type ExitInfo = { readonly code: number | null; readonly signal: string | null };

export type Helper = {
  readonly exited: Deferred.Deferred<ExitInfo>; // spawn と同じ同期区間で張る（張る前に終わったときを取りこぼさない）
  readonly kill: (signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
  readonly stderr: Effect.Effect<string>;
};

export class Helpers extends Context.Service<
  Helpers,
  {
    readonly freePort: Effect.Effect<number, PortUnavailable>;
    // 起動するだけ。止めるのは呼び出し側（stopHelper を Scope の後始末に置く）
    readonly spawn: (args: ReadonlyArray<string>) => Effect.Effect<Helper>;
    // 1 回だけつなぐ。new WebSocket と同じ同期区間から届いたメッセージを Queue に流し、close で Queue を終える
    // （helperSocket.ts の early バッファが要らない）。Scope が閉じると terminate する
    readonly connectOnce: (port: number) => Effect.Effect<Queue.Dequeue<string, Cause.Done>, SocketNotOpen, Scope.Scope>;
  }
>()("live-mindmap/server/Helpers") {}

// ---- セッションの側（差分更新・ログ・いま話している文字・書き出し）。この試作では中身を持たない

export type IntakeSink = {
  readonly receive: (message: string) => Effect.Effect<void>; // 今の wireListen
  readonly interrupted: Effect.Effect<void>; // 途切れたとき: settling.drain() と speaking.clear()
  readonly log: (event: IntakeLogEvent) => Effect.Effect<void>;
  readonly intakeFrame: (status: IntakeStatus | "none") => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
  readonly exportFiles: Effect.Effect<ReadonlyArray<string>>;
};

export class SessionSinks extends Context.Service<
  SessionSinks,
  {
    // セッションのフォルダを作り、updater を開く。updater は渡された Scope が閉じると閉じる
    // （今の start の catch・stop の finally・close() の 3 か所の updater.close() が、この 1 つになる）
    readonly open: (request: StartRequest) => Effect.Effect<{ dir: string; sink: IntakeSink }, never, Scope.Scope>;
  }
>()("live-mindmap/server/SessionSinks") {}

export type StartRequest = { readonly app: string; readonly title: string | undefined; readonly audio: boolean };

// ---- ヘルパーを止める: SIGTERM、5 秒で終わらなければ SIGKILL。SIGKILL に切り替えたときだけ true

export const stopHelper = Effect.fnUntraced(function* (helper: Helper) {
  if (yield* Deferred.isDone(helper.exited)) return false;
  yield* helper.kill("SIGTERM");
  const exited = yield* Deferred.await(helper.exited).pipe(Effect.timeoutOption(HELPER_STOP_TIMEOUT));
  if (Option.isSome(exited)) return false;
  yield* Effect.logWarning(`ヘルパーが SIGTERM から ${HELPER_STOP_TIMEOUT} 経っても終了しないので、SIGKILL で止めます`);
  yield* helper.kill("SIGKILL");
  yield* Deferred.await(helper.exited);
  return true;
});

// ヘルパーの WebSocket へつなぐ。子が生きている間は時間切れなしで再試行し、子が終わったら HelperExited
const connect = (helpers: Helpers["Service"], helper: Helper, port: number) =>
  helpers.connectOnce(port).pipe(
    Effect.retry({ schedule: Schedule.spaced(CONNECT_RETRY) }),
    Effect.catchTag("SocketNotOpen", (e) => Effect.die(e)), // 時間切れなしで再試行するので、ここには来ない
    Effect.raceFirst(
      Deferred.await(helper.exited).pipe(
        Effect.flatMap(({ code, signal }) => Effect.flatMap(helper.stderr, (stderr) => Effect.fail(new HelperExited({ code, signal, stderr })))),
      ),
    ),
  );

// ---- セッションの寿命ぶんだけあるもの（起動し直しをまたいで引き継ぐ）

type Live = {
  readonly request: StartRequest;
  readonly dir: string;
  readonly sink: IntakeSink;
  readonly scope: Scope.Closeable;
  readonly stopRequested: Deferred.Deferred<void>;
  readonly status: Ref.Ref<IntakeStatus>;
  // 以下は起動し直しのループ（同時に 1 本）だけが書く
  loop: Fiber.Fiber<LoopEnd>;
  attempt: number;
  failures: number;
  restarts: number;
  lastInterruptedAt: string | undefined;
};

// ループの終わり方。stop が使う（SIGKILL にしたか）
type LoopEnd = { kind: "stop-requested"; killed: boolean } | { kind: "gave-up" } | { kind: "start-failed" };

// 起動し直しのループが「動いている状態へ戻った」か「諦めた・中断された」かを、待っている start・resume へ知らせる
type SettledError = LaunchError | RestartGaveUp | Aborted;
type Settled = Deferred.Deferred<void, SettledError>;

const helperRunArgs = (live: Live, port: number): ReadonlyArray<string> => [
  "run",
  "--app",
  live.request.app,
  "--port",
  String(port),
  ...(live.request.audio ? ["--audio-dir", live.dir, "--audio-index", String(live.attempt)] : []),
];

// 1 回分の起動。ヘルパーが終わるまで（stop に頼まれて止めたときも）続け、終わり方を返す。
// 接続できずに子が終わったら HelperExited で失敗する
const runAttempt = (live: Live, onRunning: Effect.Effect<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const helpers = yield* Helpers;
      const port = yield* helpers.freePort;
      // freePort の間に stop が来ていたら起動しない（サーバーの終了なら、ここに来る前に中断されている）
      if (yield* Deferred.isDone(live.stopRequested)) return { info: { code: null, signal: null }, stderr: "", killed: false };
      const helper = yield* Effect.acquireRelease(helpers.spawn(helperRunArgs(live, port)), stopHelper); // 中断・失敗のときの安全網
      // stop が頼まれたら、接続待ちでも動いている最中でも SIGTERM（→ 5 秒で SIGKILL）を送る。
      // ヘルパーが終われば、下の接続待ち・読み取り・終了待ちがすべてほどける
      const stopper = yield* Deferred.await(live.stopRequested).pipe(Effect.andThen(stopHelper(helper)), Effect.forkScoped);
      const messages = yield* connect(helpers, helper, port);
      yield* onRunning;
      // ws の close まで読む。close の前に届いた発言（接続した瞬間に届いていた分も）はすべて受け取る
      yield* Stream.fromQueue(messages).pipe(Stream.runForEach(live.sink.receive));
      const info = yield* Deferred.await(helper.exited);
      const killed = (yield* Deferred.isDone(live.stopRequested)) ? yield* Fiber.join(stopper) : false;
      return { info, stderr: yield* helper.stderr, killed };
    }),
  );

// 起動し直しのループ。trigger は、最初に動いている状態へ戻ったときのログ（intake-restarted）に残す区別。
// "initial" は start の最初の起動で、接続できなければ起動し直さずに start を失敗させる
const intakeLoop = (live: Live, trigger: "initial" | "resume" | "auto", settled: Settled) =>
  Effect.gen(function* () {
    let reason = trigger;
    for (;;) {
      if (yield* Deferred.isDone(live.stopRequested)) {
        yield* Deferred.fail(settled, new Aborted());
        return { kind: "stop-requested", killed: false } as const;
      }
      live.attempt += 1;
      const startedAt = yield* Clock.currentTimeMillis;
      const onRunning = Effect.gen(function* () {
        if (reason !== "initial") {
          live.restarts += 1;
          yield* live.sink.log({ type: "intake-restarted", trigger: reason });
        }
        reason = "auto";
        yield* setStatus(live, "running");
        yield* Deferred.succeed(settled, undefined);
      });
      const exit = yield* Effect.exit(runAttempt(live, onRunning));

      if (yield* Deferred.isDone(live.stopRequested)) {
        yield* Deferred.fail(settled, new Aborted()); // すでに running で知らせていれば何もしない
        return { kind: "stop-requested", killed: Exit.isSuccess(exit) && exit.value.killed } as const;
      }
      if (reason === "initial" && Exit.isFailure(exit)) {
        yield* Deferred.failCause(settled, exit.cause);
        return { kind: "start-failed" } as const;
      }

      // 予期しない終わり。分類 → 判断 → 投影
      if (Exit.isSuccess(exit)) {
        yield* live.sink.interrupted;
        live.lastInterruptedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      }
      const { info, stderr } = Exit.isSuccess(exit) ? exit.value : describeLaunchFailure(exit.cause);
      const stderrTail = tailLines(stderr, STDERR_TAIL_LINES);
      yield* live.sink.log({ type: "intake-stopped", code: info.code, signal: info.signal as NodeJS.Signals | null, stderrTail });
      const ranMs = (yield* Clock.currentTimeMillis) - startedAt;
      const decision = decideIntakeRestart({ failures: live.failures, ranMs });
      live.failures = decision.failures;
      if (decision.action === "giveup") {
        yield* live.sink.log({ type: "intake-gave-up" });
        yield* setStatus(live, "stopped");
        yield* Deferred.fail(settled, new RestartGaveUp({ stderrTail }));
        return { kind: "gave-up" } as const;
      }
      yield* setStatus(live, "interrupted");
    }
  }).pipe(Effect.onInterrupt(() => Deferred.fail(settled, new Aborted())));

const describeLaunchFailure = (cause: Cause.Cause<LaunchError>) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && error.value._tag === "HelperExited") {
    return { info: { code: error.value.code, signal: error.value.signal }, stderr: error.value.stderr };
  }
  return { info: { code: null, signal: null }, stderr: Cause.pretty(cause) };
};

const setStatus = (live: Live, status: IntakeStatus) => Effect.andThen(Ref.set(live.status, status), live.sink.intakeFrame(status));

// ---- 同時に 1 つのセッション: start・stop・resume・status

type State = { kind: "idle" } | { kind: "starting" } | { kind: "live"; live: Live } | { kind: "stopping" };

export class Sessions extends Context.Service<
  Sessions,
  {
    readonly start: (request: StartRequest) => Effect.Effect<{ dir: string }, SessionBusy | LaunchError | Aborted>;
    readonly stop: Effect.Effect<{ paths: ReadonlyArray<string> }, NoSession | SessionBusy>;
    readonly resume: Effect.Effect<void, NoSession | IntakeNotStopped | RestartGaveUp | Aborted>;
    readonly status: Effect.Effect<IntakeStatusReport>;
  }
>()("live-mindmap/server/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const helpers = yield* Helpers;
      const serverScope = yield* Effect.scope; // この Layer の Scope。サーバーの終了で閉じる
      const state = yield* Ref.make<State>({ kind: "idle" });

      const start = Effect.fnUntraced(function* (request: StartRequest) {
        const busy = yield* Ref.modify(state, (s): [State["kind"] | undefined, State] => (s.kind === "idle" ? [undefined, { kind: "starting" }] : [s.kind, s]));
        if (busy !== undefined) return yield* new SessionBusy({ state: busy as SessionBusy["state"] });
        // セッションの Scope はサーバーの Scope の子。サーバーが閉じれば、開始の途中でもここが閉じる
        const scope = yield* Scope.fork(serverScope);
        return yield* Effect.gen(function* () {
          const { dir, sink } = yield* sinks.open(request).pipe(Scope.provide(scope));
          const live: Live = {
            request,
            dir,
            sink,
            scope,
            stopRequested: yield* Deferred.make<void>(),
            status: yield* Ref.make<IntakeStatus>("interrupted"),
            loop: undefined as never, // 直後に入れる
            attempt: 0,
            failures: 0,
            restarts: 0,
            lastInterruptedAt: undefined,
          };
          const settled = yield* Deferred.make<void, SettledError>();
          live.loop = yield* intakeLoop(live, "initial", settled).pipe(Effect.provideService(Helpers, helpers), Effect.forkIn(scope));
          // 最初の起動は諦めずに失敗するので、RestartGaveUp にはならない
          yield* Deferred.await(settled).pipe(Effect.catchTag("RestartGaveUp", (e) => Effect.die(e)));
          yield* Ref.set(state, { kind: "live", live });
          return { dir };
        }).pipe(
          // 開始の失敗・中断: セッションの Scope を閉じる（ヘルパーの停止と updater の close はその後始末）
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.andThen(Scope.close(scope, exit), Ref.set(state, { kind: "idle" })))),
        );
      });

      const stop = Effect.gen(function* () {
        const taken = yield* Ref.modify(state, (s): [State, State] => (s.kind === "live" ? [s, { kind: "stopping" }] : [s, s]));
        if (taken.kind === "idle") return yield* new NoSession();
        if (taken.kind !== "live") return yield* new SessionBusy({ state: taken.kind });
        const { live } = taken;
        return yield* Effect.gen(function* () {
          yield* Deferred.succeed(live.stopRequested, undefined);
          // ヘルパーが止まり、close の前に届いた発言を読み終えるまで待つ（止まった状態ならすぐ終わっている）
          const end = yield* Fiber.join(live.loop);
          if (end.kind === "stop-requested" && end.killed && live.request.audio) {
            yield* Effect.logWarning(`録音の書き終わりを確認できないまま、セッションを閉じます（${live.dir}、${live.attempt} 回目の起動の録音）`);
          }
          yield* live.sink.flush;
          return { paths: yield* live.sink.exportFiles };
        }).pipe(Effect.ensuring(Effect.all([Scope.close(live.scope, Exit.void), Ref.set(state, { kind: "idle" }), live.sink.intakeFrame("none")])));
      });

      const resume = Effect.gen(function* () {
        const s = yield* Ref.get(state);
        if (s.kind !== "live") return yield* new NoSession();
        const { live } = s;
        const wasStopped = yield* Ref.modify(live.status, (status): [boolean, IntakeStatus] => (status === "stopped" ? [true, "interrupted"] : [false, status]));
        if (!wasStopped) return yield* new IntakeNotStopped();
        yield* live.sink.intakeFrame("interrupted");
        live.failures = 0; // 失敗の数を 0 から数え直す（要件 #17）
        const settled = yield* Deferred.make<void, SettledError>();
        live.loop = yield* intakeLoop(live, "resume", settled).pipe(Effect.provideService(Helpers, helpers), Effect.forkIn(live.scope));
        // 起動し直しは失敗しても続けるので、起動の失敗そのもの（HelperExited・PortUnavailable）にはならない
        yield* Deferred.await(settled).pipe(Effect.catchTag(["HelperExited", "PortUnavailable"], (e) => Effect.die(e)));
      });

      const status = Effect.gen(function* () {
        const s = yield* Ref.get(state);
        if (s.kind !== "live") return { status: "none" } satisfies IntakeStatusReport;
        const { live } = s;
        return { status: yield* Ref.get(live.status), dir: live.dir, restarts: live.restarts, lastInterruptedAt: live.lastInterruptedAt };
      });

      return Sessions.of({ start, stop, resume, status });
    }),
  );
}

// HTTP の境界での対応（ここ 1 か所）。マップの「HTTP の受け口と RequestError」で決める。試作では形だけ
export const httpStatusOf = (error: { readonly _tag: string }): number =>
  ({ SessionBusy: 409, NoSession: 409, IntakeNotStopped: 409, RestartGaveUp: 503, Aborted: 503 })[error._tag] ?? 500;
