// セッションの状態と、start・stop・resume・status、ヘルパーの起動し直しのループ（ADR 0008）。HTTP を知らない。
// 状態は idle → starting → live（取り込みは running ⇄ interrupted → stopped のいずれか）→ stopping → idle。
// 同時に扱うセッションは 1 つ。外の世界は Helpers、セッションの中身は SessionSinks、ブラウザへの配信は Viewers が受け持つ。
//
// Issue #161: ヘルパーが予期せず終わっても（stop・サーバーの終了によるものを除く）、同じセッション（同じマップ・ログ・
// 差分更新）へヘルパーを起動し直す。差し替えるのはヘルパーごとのもの（1 回分の起動の Scope）だけで、
// ヘルパーに依らないもの（SessionSink・原点・起動の回数）は引き継ぐ。
//
// 止め方: stop は中断しない。「止めて」の印（Deferred）を立てるだけで、その回の起動の中で待っているファイバーが
// ヘルパーを止め、ヘルパーが終われば読み取りがほどける。stop は起動し直しのループの終わりを Fiber.join で待ってから書き出す。
// 中断はサーバーの終了だけ。セッションの Scope はサーバーの Scope の子で、サーバーの Scope を閉じるとループも
// 1 回分の起動の Scope（ヘルパーの停止）も SessionSink（updater）も後始末される。
import { Clock, Console, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Result, Scope, Stream } from "effect";
import {
  CONFIGURATION_CHANGE_WINDOW_MS,
  decideIntakeRestart,
  decodeHelperEvent,
  MAX_CONFIGURATION_CHANGES,
  SCREEN_NOTICE_MS,
  SCREEN_NOTICE_TEXT,
  type HelperEvent,
  type IntakeGiveUpReason,
  type IntakeStatusReport,
} from "./core/index.ts";
import { withoutFinalNewline } from "./consoleText.ts";
import { Helpers, HELPER_STOP_TIMEOUT_MS, type HelperAttempt, type HelperExitInfo } from "./helpers.ts";
import {
  Aborted,
  HelperExited,
  IntakeNotStopped,
  NoSession,
  RestartGaveUp,
  SessionBusy,
  SessionTransition,
  type SessionFailure,
} from "./sessionFailure.ts";
import { SessionSinks, type SessionSink } from "./sessionSinks.ts";
import { Viewers } from "./viewers.ts";

// セッションの開始に渡す値。null と省略はどちらも「指定なし」で、既定は title がフォルダ名・audio が録音する
export type SessionStart = { app: string; title: string | undefined; audio: boolean; screen: boolean; model: import("./modelSelection.ts").ExecutableModel };

// セッションのフォルダを作る親のフォルダ
export class SessionsDir extends Context.Service<SessionsDir, string>()("live-mindmap/server/SessionsDir") {}

type IntakeKind = "running" | "interrupted" | "stopped";

// 起動し直しの連鎖が到達した結果。resume の応答・ログ・フレームの基準（複数失敗を集約する境界）。
// running: 動いている状態へ戻った。stopped: 続けて失敗して諦めた（stderrTail は最後の失敗の標準エラー末尾）。
// aborted: stop・サーバーの終了に中断された（起動し直し自体は成立していない）
type RestartOutcome = { kind: "running" } | { kind: "stopped"; stderrTail: ReadonlyArray<string> } | { kind: "aborted" };

// 連鎖の終わり。exit は、stop で止めたヘルパーの終わり方（止めたヘルパーが無ければ undefined）
type ChainEnd = { exit: HelperExitInfo | undefined };

// 接続済みのヘルパー 1 回分と、その Scope
type Launched = { attempt: HelperAttempt; scope: Scope.Closeable };

// ヘルパーに依らない、セッションの寿命ぶんだけ存在するもの（起動し直しをまたいで引き継ぐ）。状態はすべて Ref
type Live = {
  app: string;
  dir: string;
  audio: boolean;
  screen: boolean; // false なら共有画面を取り込まない（ヘルパーに --no-screen を渡す。起動し直し・resume でも引き継ぐ）
  noticeShown: Ref.Ref<boolean>; // 許可なしの一文を出したか。セッションにつき 1 回だけ（起動し直しをまたぐ）
  sink: SessionSink;
  scope: Scope.Closeable; // セッションの Scope。サーバーの Scope の子
  stopRequested: Deferred.Deferred<void>; // 「止めて」の印
  chain: Ref.Ref<Fiber.Fiber<ChainEnd> | undefined>; // いまの起動し直しの連鎖
  intake: Ref.Ref<IntakeKind>;
  origin: Ref.Ref<string | undefined>; // 最初のヘルパーから受け取った原点。一度決まったら上書きしない
  attempt: Ref.Ref<number>; // 直近に起動した回数（1 始まり。--audio-index にそのまま使う）
  attemptStartedAt: Ref.Ref<number>; // 直近の起動を始めた時刻（Clock）。60 秒の判断の基準
  failures: Ref.Ref<number>; // 続けて失敗した回数（decideIntakeRestart が進める。構成の変化による終了は数えない）
  configurationChanges: Ref.Ref<ReadonlyArray<number>>; // 構成の変化（終了コード 75）で終わった時刻（Clock）。窓の外は decideIntakeRestart が除く
  restarts: Ref.Ref<number>; // 成功した起動し直しの回数（cli status の「起動し直した回数」）
  lastInterruptedAt: Ref.Ref<string | undefined>; // 最後に途切れた時刻（ISO）
};

type State = { kind: "idle" } | { kind: "starting" } | { kind: "live"; live: Live } | { kind: "stopping" };

export class Sessions extends Context.Service<Sessions, {
  apps: Effect.Effect<unknown>;
  start: (input: SessionStart) => Effect.Effect<{ dir: string }, SessionFailure>;
  stop: Effect.Effect<{ paths: string[] }, SessionFailure>;
  status: Effect.Effect<IntakeStatusReport>;
  resume: Effect.Effect<void, SessionFailure>;
}>()("live-mindmap/server/Sessions") {
  static readonly layer: Layer.Layer<Sessions, never, Helpers | SessionSinks | SessionsDir | Viewers> = Layer.effect(Sessions)(
    Effect.gen(function* () {
      const helpers = yield* Helpers;
      const sinks = yield* SessionSinks;
      const viewers = yield* Viewers;
      const sessionsDir = yield* SessionsDir;
      const serverScope = yield* Effect.scope;
      const state = yield* Ref.make<State>({ kind: "idle" });

      // 標準エラー。Console.error が末尾に改行を足すので、渡された文字列の末尾の改行は 1 つ外す（出力のバイト列は変えない）
      const note = (text: string) => Console.error(withoutFinalNewline(text));
      const intakeFrame = (status: "running" | "interrupted" | "stopped" | "none") => viewers.intake({ type: "intake", status });

      // run の argv（port は Helpers が足す。audio・origin は未定義なら渡さない。screen が false なら --no-screen）
      const runArgs = (live: Pick<Live, "app" | "dir" | "audio" | "screen">, attempt: number, origin: string | undefined): string[] => [
        "run",
        "--app",
        live.app,
        ...(live.audio ? ["--audio-dir", live.dir, "--audio-index", String(attempt)] : []),
        ...(live.screen ? [] : ["--no-screen"]),
        ...(origin !== undefined ? ["--origin", origin] : []),
      ];

      // 諦めたときの標準エラーの 1 行。理由は decideIntakeRestart の判断から作る（ログと同じ理由）
      const gaveUpNote = (reason: IntakeGiveUpReason) =>
        note(
          reason === "configuration-changes"
            ? `マイクの入力の構成の変化が ${CONFIGURATION_CHANGE_WINDOW_MS / 1000} 秒に ${MAX_CONFIGURATION_CHANGES} 回を超えて続いたため、起動し直しを諦めました。取り込みは止まった状態です\n`
            : "起動し直しを諦めました。取り込みは止まった状態です\n",
        );

      // 1 回の起動（起動し直しを含む）の終わりを、記録 → 判断の順で扱う。ログ・標準エラーは必ず書く。
      // 終わり方（終了コード・シグナル）は decideIntakeRestart に渡し、構成の変化による終了は failures に数えず別の窓で数える。
      // 続けるか諦めるか（action）を返し、状態の更新は呼び出し側が行う
      const finishAttempt = Effect.fnUntraced(function* (live: Live, info: HelperExitInfo, stderrTail: ReadonlyArray<string>) {
        yield* live.sink.appendLog({ type: "intake-stopped", code: info.code, signal: info.signal, stderrTail: [...stderrTail] });
        yield* note(`取り込みが止まった（${info.code ?? info.signal ?? "不明"}）\n`);
        const now = yield* Clock.currentTimeMillis;
        const decision = decideIntakeRestart({
          failures: yield* Ref.get(live.failures),
          configurationChanges: yield* Ref.get(live.configurationChanges),
          ranMs: now - (yield* Ref.get(live.attemptStartedAt)),
          exit: info,
          now,
        });
        yield* Ref.set(live.failures, decision.failures);
        yield* Ref.set(live.configurationChanges, decision.configurationChanges);
        if (decision.action === "giveup") {
          yield* live.sink.appendLog({ type: "intake-gave-up", reason: decision.reason });
          yield* gaveUpNote(decision.reason);
        }
        return decision.action;
      });

      const defectReason = (defect: unknown) => (defect instanceof Error ? defect.message : String(defect));
      const skipped = (reason: string) => note(`ヘルパーのイベントを読み飛ばしました: ${reason}\n`);
      const applyFailed = (reason: string) => note(`ヘルパーのイベントの処理に失敗しました: ${reason}\n`);

      // ヘルパーからのイベントを、ヘルパーに依らないもの（SessionSink・原点）へつなぐ。
      // 知らない type は何も出さずに読み飛ばし、壊れたイベントと処理の失敗は文面を分けて 1 行出して読み続ける（セッションは止めない）
      const applyEvent = (live: Live, event: HelperEvent): Effect.Effect<void> => {
        switch (event.type) {
          case "origin":
            // 原点は最初のヘルパーからの値だけ採用する
            return Ref.update(live.origin, (origin) => origin ?? event.hostTime);
          case "remark": {
            const { type: _type, ...settled } = event;
            return live.sink.final(settled);
          }
          case "partial": {
            const { type: _type, ...partial } = event;
            return live.sink.partial(partial);
          }
          case "screen":
            // 画面が取れないことは取り込みの途切れではないので、取り込みの記録（appendLog）や状態には触れない
            return live.sink.screen({ start: event.start, image: event.image });
          case "screen-off":
            // 共有画面だけが取れないことは取り込みの途切れではないので、appendLog・intake・起動し直しには触れない。
            // ログには届くたびに残し、画面の一文はセッションにつき 1 回だけ出す
            return Effect.andThen(live.sink.screenOff({ start: event.start, reason: event.reason }), showScreenNotice(live));
        }
      };

      // 許可なしの一文を、まだ出していなければ出す。届いてから SCREEN_NOTICE_MS 後に消すフレームを送る（保持も消える）。
      // 消す役はセッションの Scope の Fiber で、stop で Scope が閉じても消すフレームは送られる
      const showScreenNotice = Effect.fnUntraced(function* (live: Live) {
        const first = yield* Ref.modify(live.noticeShown, (shown): [boolean, boolean] => [!shown, true]);
        if (!first) return;
        yield* viewers.screenNotice({ type: "screen-notice", text: SCREEN_NOTICE_TEXT });
        yield* Effect.forkIn(
          Effect.sleep(SCREEN_NOTICE_MS).pipe(Effect.ensuring(viewers.screenNotice({ type: "screen-notice", text: null }))),
          live.scope,
        );
      });

      const handleEvent = (live: Live) => (data: string) =>
        decodeHelperEvent(data).pipe(
          Effect.map((decoded) => (decoded.kind === "unknown" ? undefined : decoded.event)),
          Effect.catchTag("SchemaError", (error) => Effect.as(skipped(error.message), undefined)),
          Effect.catchDefect((defect) => Effect.as(skipped(defectReason(defect)), undefined)),
          Effect.flatMap((event) =>
            event === undefined ? Effect.void : applyEvent(live, event).pipe(Effect.catchDefect((defect) => applyFailed(defectReason(defect)))),
          ),
        );

      // 接続済みのヘルパー 1 回分を、終わるまで読む。ヘルパーが終われば接続が閉じて読み取りが終わり、
      // 標準エラーを読み終えた終わり方が確定する。終わったら 1 回分の Scope を閉じる
      const serve = Effect.fnUntraced(function* (live: Live, { attempt, scope }: Launched) {
        // 「止めて」の印が立ったら、その回のヘルパーを止める
        yield* Effect.forkIn(Effect.andThen(Deferred.await(live.stopRequested), attempt.stop), scope);
        yield* Stream.runForEach(attempt.events, handleEvent(live));
        const exit = yield* attempt.exit;
        const stderrTail = yield* attempt.stderrTail;
        yield* Scope.close(scope, Exit.void);
        return { exit, stderrTail };
      });

      const markStopped = (live: Live) => Effect.andThen(Ref.set(live.intake, "stopped"), intakeFrame("stopped"));

      // 起動し直しの連鎖。成功するまで（または諦めるまで）、decideIntakeRestart の判断に従って繰り返す。
      // initial があれば最初の 1 回は起動済みのもの（start の初回起動）。trigger は、最初の起動し直しの成功をログに残す
      // 「自動か resume か」の区別（以後の途切れは自動）。outcome は、最初の成功か諦めか中断で解決する（resume の応答の基準）
      const chain = Effect.fnUntraced(function* (live: Live, initial: Launched | undefined, trigger: "auto" | "resume", outcome: Deferred.Deferred<RestartOutcome>) {
        let current = initial;
        let reason = trigger;
        for (;;) {
          if (current === undefined) {
            if (yield* Deferred.isDone(live.stopRequested)) return { exit: undefined };
            const attemptNo = yield* Ref.updateAndGet(live.attempt, (n) => n + 1);
            yield* Ref.set(live.attemptStartedAt, yield* Clock.currentTimeMillis);
            const scope = yield* Scope.fork(live.scope, "sequential");
            const result = yield* helpers.launch(runArgs(live, attemptNo, yield* Ref.get(live.origin)), live.stopRequested).pipe(
              Scope.provide(scope),
              Effect.result,
            );
            if (Result.isFailure(result)) {
              yield* Scope.close(scope, Exit.void);
              if (yield* Deferred.isDone(live.stopRequested)) return { exit: result.failure.exit }; // 中断。stop が後片付けを引き継ぐ（止めたヘルパーの終わり方を stop へ渡す）
              const failure = result.failure;
              const action = yield* finishAttempt(live, failure.exit ?? { code: null, signal: null }, failure.stderrTail);
              if (action === "giveup") {
                yield* markStopped(live);
                yield* Deferred.succeed(outcome, { kind: "stopped", stderrTail: failure.stderrTail });
                return { exit: undefined };
              }
              continue; // 続けて起動し直す
            }
            // 中断された後に接続が追いついた（接続成功と stop が競合した）。起動し直しとは数えず、届いていたイベントを
            // 読み終えてから止まる
            if (!(yield* Deferred.isDone(live.stopRequested))) {
              yield* Ref.update(live.restarts, (n) => n + 1);
              yield* live.sink.appendLog({ type: "intake-restarted", trigger: reason });
              yield* note("ヘルパーを起動し直しました\n");
              yield* Ref.set(live.intake, "running");
              yield* intakeFrame("running");
              yield* Deferred.succeed(outcome, { kind: "running" });
              reason = "auto";
            }
            current = { attempt: result.success, scope };
          }
          const launched = current;
          current = undefined;
          const { exit, stderrTail } = yield* serve(live, launched);
          // stop・サーバーの終了による意図した終了。届いていた最後の発話を落とさず、起動し直さない
          if (yield* Deferred.isDone(live.stopRequested)) {
            yield* live.sink.drain;
            return { exit };
          }
          yield* live.sink.drain; // 確定結果に覆われなかった最後の発話を発言にする
          yield* live.sink.clearSpeaking; // いま話している文字を空にする（永久停止はしない）
          yield* Ref.set(live.lastInterruptedAt, DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)));
          const action = yield* finishAttempt(live, exit, stderrTail);
          if (action === "giveup") {
            yield* markStopped(live);
            return { exit: undefined };
          }
          yield* Ref.set(live.intake, "interrupted");
          yield* intakeFrame("interrupted");
        }
      }, (effect, _live, _initial, _trigger, outcome) => effect.pipe(Effect.ensuring(Deferred.succeed(outcome, { kind: "aborted" }))));

      const begin = Effect.fnUntraced(function* (input: SessionStart): Effect.fn.Return<{ dir: string }, SessionFailure> {
        const scope = yield* Scope.fork(serverScope, "sequential");
        return yield* Effect.gen(function* () {
          const updaterLayer = yield* sinks.prepare(input.model).pipe(Scope.provide(scope));
          const dir = yield* sinks.createDir(sessionsDir);
          // 60 秒の判断の基準は、接続が成功した時刻ではなく、起動（接続待ちを含む）を始めた時刻にする。
          // 接続はマイクの許可待ち等で時間がかかることがあり、ここを接続成功後にすると、長く待ってから
          // 短時間で終わった回を「続けて失敗した」と誤って数えてしまう（起動し直しと同じ基準にそろえる）
          const startedAt = yield* Clock.currentTimeMillis;
          const stopRequested = yield* Deferred.make<void>();
          const attemptScope = yield* Scope.fork(scope, "sequential");
          const attempt = yield* helpers
            .launch(runArgs({ app: input.app, dir, audio: input.audio, screen: input.screen }, 1, undefined), stopRequested)
            .pipe(
              Scope.provide(attemptScope),
              Effect.catchTag("HelperLaunchFailure", (failure) =>
                Effect.fail(new HelperExited({ code: failure.exit?.code ?? null, signal: failure.exit?.signal ?? null, stderrTail: failure.stderrTail })),
              ),
            );
          // 初期ルートの公開は、ヘルパーへの接続が成功した後にする。公開したフレームは取り消せないので、
          // 開始に失敗するときに、接続中のクライアントへ空のマップを送らない
          const sink = yield* sinks.open({ dir, title: input.title, model: input.model, updaterLayer, publish: viewers.publish, speak: viewers.speak, diffUpdate: viewers.diffUpdate }).pipe(Scope.provide(scope));
          // 指定のログは、セッションを開いた直後（start の行の後、最初の発言より前）に 1 回だけ。applyEvent は経由しない（知らせは出さない）
          if (!input.screen) yield* sink.screenOff({ start: 0, reason: "指定" });
          const live: Live = {
            app: input.app,
            dir,
            audio: input.audio,
            screen: input.screen,
            noticeShown: yield* Ref.make(false),
            sink,
            scope,
            stopRequested,
            chain: yield* Ref.make<Fiber.Fiber<ChainEnd> | undefined>(undefined),
            intake: yield* Ref.make<IntakeKind>("running"),
            origin: yield* Ref.make<string | undefined>(undefined),
            attempt: yield* Ref.make(1),
            attemptStartedAt: yield* Ref.make(startedAt),
            failures: yield* Ref.make(0),
            configurationChanges: yield* Ref.make<ReadonlyArray<number>>([]),
            restarts: yield* Ref.make(0),
            lastInterruptedAt: yield* Ref.make<string | undefined>(undefined),
          };
          const outcome = yield* Deferred.make<RestartOutcome>();
          const fiber = yield* Effect.forkIn(chain(live, { attempt, scope: attemptScope }, "auto", outcome), scope);
          yield* Ref.set(live.chain, fiber);
          yield* Ref.set(state, { kind: "live", live });
          yield* Scope.addFinalizer(scope, viewers.sessionMode({ type: "session-mode", local: false }));
          yield* viewers.sessionMode({ type: "session-mode", local: input.model.local });
          return { dir };
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

      const start = Effect.fnUntraced(function* (input: SessionStart): Effect.fn.Return<{ dir: string }, SessionFailure> {
        const refusal = yield* Ref.modify(state, (current): [Option.Option<SessionFailure>, State] =>
          current.kind === "idle"
            ? [Option.none(), { kind: "starting" }]
            : [Option.some(current.kind === "live" ? new SessionBusy() : new SessionTransition()), current],
        );
        if (Option.isSome(refusal)) return yield* refusal.value;
        return yield* begin(input).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(state, { kind: "idle" }) : Effect.void)),
        );
      });

      // 止めて書き出す。順番の要る停止（ヘルパーを止める → 読み終える → 書き出す）は本体に書き、
      // Scope の後始末（updater を閉じる等）は、途中で失敗・中断されたときの安全網にもなる
      const stop = Effect.uninterruptible(
        Effect.gen(function* () {
          const claimed = yield* Ref.modify(state, (current): [Result.Result<Live, SessionFailure>, State] =>
            current.kind === "live"
              ? [Result.succeed(current.live), { kind: "stopping" }]
              : [Result.fail(current.kind === "idle" ? new NoSession() : new SessionTransition()), current],
          );
          if (Result.isFailure(claimed)) return yield* claimed.failure;
          const live = claimed.success;
          // 本体は呼び出し側（HTTP 要求の fiber）ではなくサーバーの Scope の fiber で動かす。要求の切断で呼び出し側が
          // 中断されても、読み終える・書き出す・状態を idle に戻すまで続ける。中断はサーバーの終了（serverScope を閉じる）だけ
          const body = Effect.gen(function* () {
            yield* Deferred.succeed(live.stopRequested, undefined);
            const fiber = yield* Ref.get(live.chain);
            // 連鎖の終わりを待つ。close の前に届いた発言は、すべて読み終えて push 済みになる
            const end = fiber === undefined ? { exit: undefined } : yield* Fiber.join(fiber);
            if (end.exit?.signal === "SIGKILL") {
              yield* note(`ヘルパーが SIGTERM から ${HELPER_STOP_TIMEOUT_MS}ms 経っても終了しないので、SIGKILL で止めます\n`);
              if (live.audio) {
                // その時点で動いていた起動回の録音ファイル名を示す。起動し直していれば相手-2.m4a 等になる
                const names = live.sink.audioFileNames(yield* Ref.get(live.attempt)).join("・");
                yield* note(`録音の書き終わりを確認できないまま、セッションを閉じます。${live.dir} の ${names} が不完全なことがあります\n`);
              }
            }
            yield* live.sink.flush;
            return { paths: yield* live.sink.exports };
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                // 停止の成否に関係なく、予約を取り消して両トラックの仮の文字を空にする（失敗しても、古い文字が新規接続へ再送されない）
                yield* live.sink.stopRelays;
                // session.flush() で最後の差分更新が終わっているので、ここで閉じる（updater・ヘルパーの後始末）
                yield* Scope.close(live.scope, Exit.void);
                // 接続中のクライアントにも、途切れ・止まったの一言を消すフレームを送る。status は "running" ではなく
                // "none"（セッションが無い）にする。"running" だと、直前が interrupted/stopped だったクライアントが
                // 「再開した」と解釈し、終わったセッションに「再開しました」が出てしまう（CT-NOTICE-CLEAR）
                yield* intakeFrame("none");
              }).pipe(Effect.ensuring(Ref.set(state, { kind: "idle" }))),
            ),
          );
          const running = yield* Effect.forkIn(Effect.interruptible(body), serverScope);
          return yield* Effect.interruptible(Fiber.join(running));
        }),
      );

      // 応答は、起動し直しの連鎖が実際に到達した状態（RestartOutcome）から作る
      const resume = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.kind !== "live") return yield* new NoSession();
        const { live } = current;
        // 取り込みの状態は、確かめてから書き換える（自動の起動し直しと取り合うので 1 つの操作にする）
        const taken = yield* Ref.modify(live.intake, (kind): [boolean, IntakeKind] => (kind === "stopped" ? [true, "interrupted"] : [false, kind]));
        if (!taken) return yield* new IntakeNotStopped();
        yield* Ref.set(live.failures, 0); // 失敗の数を 0 から数え直す
        yield* Ref.set(live.configurationChanges, []); // 構成の変化の数も空から数え直す
        const outcome = yield* Deferred.make<RestartOutcome>();
        const fiber = yield* Effect.forkIn(chain(live, undefined, "resume", outcome), live.scope);
        yield* Ref.set(live.chain, fiber);
        yield* intakeFrame("interrupted");
        const result = yield* Deferred.await(outcome);
        if (result.kind === "stopped") return yield* new RestartGaveUp({ stderrTail: result.stderrTail });
        if (result.kind === "aborted") return yield* new Aborted();
      });

      const status: Effect.Effect<IntakeStatusReport> = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.kind !== "live") return { status: "none" };
        const { live } = current;
        return {
          status: yield* Ref.get(live.intake),
          dir: live.dir,
          restarts: yield* Ref.get(live.restarts),
          lastInterruptedAt: yield* Ref.get(live.lastInterruptedAt),
        };
      });

      return Sessions.of({ apps: helpers.apps, start, stop, status, resume });
    }),
  );
}
