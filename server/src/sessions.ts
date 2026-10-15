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
import { Cause, Clock, Console, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Result, Scope, Stream, SynchronizedRef } from "effect";
import { parse } from "node:path";
import {
  CONFIGURATION_CHANGE_WINDOW_MS,
  decideIntakeRestart,
  decodeHelperEvent,
  MAX_CONFIGURATION_CHANGES,
  type RecordedEvent,
  SCREEN_NOTICE_MS,
  SCREEN_NOTICE_TEXT,
  INITIAL_SELF_PAUSE_STATE,
  TAP_NOTICE_TEXT,
  type HelperEvent,
  type IntakeGiveUpReason,
  type IntakeStatusReport,
  type SelfPauseFrame,
  type SelfPauseState,
} from "./core/index.ts";
import { withoutFinalNewline } from "./consoleText.ts";
import { Helpers, HELPER_STOP_TIMEOUT_MS, type HelperAttempt, type HelperExitInfo } from "./helpers.ts";
import {
  Aborted,
  HelperExited,
  IntakeNotStopped,
  NoSession,
  NotForRecordedSession,
  RestartGaveUp,
  SessionBusy,
  SessionTransition,
  type SessionFailure,
} from "./sessionFailure.ts";
import { SessionSinks, type SessionSink } from "./sessionSinks.ts";
import { Viewers } from "./viewers.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { checkManagedDeps, requireStartupDeps, startupPreparationFailure } from "./managedDepsCheck.ts";
import type { CheckReport } from "./managedDepsProtocol.ts";

// セッションの開始に渡す値。null と省略はどちらも「指定なし」で、既定は title がフォルダ名・audio が録音する
// vocab は利用者が足した語（cli start --vocab。1 語ずつ。足さなければ空）。開始のときにだけ受け取る
export type SessionStart = { app: string; title: string | undefined; audio: boolean; screen: boolean; vocab: ReadonlyArray<string>; model: import("./modelSelection.ts").ExecutableModel; judge?: import("./judgeSelection.ts").JudgeModel };

// 録画からのセッション（cli recorded）の開始に渡す値。file は絶対パス。title・vocab・model は SessionStart と同じ意味
export type RecordedStart = { file: string; title: string | undefined; vocab: ReadonlyArray<string>; model: import("./modelSelection.ts").ExecutableModel };

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
// 休止の指示の送り先。connected: いま接続している起動回（指示をすぐ送る）。waiting: 起動し直しの途中（接続待ち）。
// pending は、接続待ちの間に求められた状態で、接続した回へ送って消す。helper が受け付けたかどうかは self-pause イベントだけが決める（起動の引数には使わない）
type SelfPauseLink = { kind: "connected"; attempt: HelperAttempt } | { kind: "waiting"; pending: boolean | undefined };

type Live = {
  model: SessionStart["model"];
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
  selfPauseFrame: Ref.Ref<SelfPauseFrame>; // helper が報告した自分の休止の状態と理由（Issue #1069・#1071）。paused が変わったときだけログとフレームを出し、休止中に理由だけが変わったときはフレームだけ出す
  selfPauseState: Ref.Ref<SelfPauseState>; // helper が知らせた休止の規則の状態。起動し直しをまたいで続き、次の起動の引数になる（server は覚えるだけ）
  selfPauseLink: SynchronizedRef.SynchronizedRef<SelfPauseLink>; // 休止の指示の送り先。送信と切り替えを 1 つずつ行う
};

// セッションに入れた位置（秒）・録画の全体の長さ（届く前は null）・マップの更新回数
type RecordedProgressState = { position: number; duration: number | null; rounds: number };

// 録画からのセッション。ヘルパーは 1 回だけ起動し、起動し直さない。ヘルパーに依らない状態は持たない
type Recorded = {
  model: RecordedStart["model"];
  dir: string;
  sink: SessionSink;
  scope: Scope.Closeable; // セッションの Scope。サーバーの Scope の子
  stopRequested: Deferred.Deferred<void>; // 「止めて」の印
  run: Ref.Ref<Fiber.Fiber<void> | undefined>; // ヘルパーの出力を読む fiber
  events: Queue.Queue<RecordedEvent, Cause.Done>; // 開始の応答の stream へ流す進み具合・終わり
  progress: Ref.Ref<RecordedProgressState>;
};

type State =
  | { kind: "idle"; installations: number }
  | { kind: "starting" }
  | { kind: "live"; live: Live }
  | { kind: "recorded"; recorded: Recorded }
  | { kind: "stopping" };

// 開始の応答で返す、録画からのセッションの経過。events は進み具合から終わりまで（finished の後に閉じる）
export type RecordedRun = { dir: string; warnings: ReadonlyArray<string>; events: Stream.Stream<RecordedEvent> };

export class Sessions extends Context.Service<Sessions, {
  apps: Effect.Effect<unknown>;
  start: (input: SessionStart) => Effect.Effect<{ dir: string; warnings: ReadonlyArray<string> }, SessionFailure>;
  // 録画からのセッションを始める。ヘルパーが読み終えるか stop されるまで続き、その経過を events で流す
  startRecorded: (input: RecordedStart) => Effect.Effect<RecordedRun, SessionFailure>;
  stop: Effect.Effect<{ paths: string[] }, SessionFailure>;
  status: Effect.Effect<IntakeStatusReport>;
  resume: Effect.Effect<{ warnings: ReadonlyArray<string> }, SessionFailure>;
  checkResume: Effect.Effect<typeof CheckReport.Type, SessionFailure>;
  reserveDeps: Effect.Effect<void, SessionFailure, Scope.Scope>;
  // いま進行中のセッション（ライブ・録画から）の Scope（閲覧の共有の寿命をセッションに結ぶ）と、ローカルモードかどうか。無ければ失敗する
  liveSession: Effect.Effect<{ readonly scope: Scope.Scope; readonly local: boolean }, SessionFailure>;
  // 自分の休止・再開を求める（paused が求める状態。Issue #1069）。いま接続している helper へ指示を送る。live でなければ失敗する（録画からのセッションは NotForRecordedSession）
  setSelfPause: (paused: boolean) => Effect.Effect<void, SessionFailure>;
}>()("live-mindmap/server/Sessions") {
  static readonly layer: Layer.Layer<Sessions, never, Helpers | SessionSinks | SessionsDir | Viewers | ManagedDeps> = Layer.effect(Sessions)(
    Effect.gen(function* () {
      const helpers = yield* Helpers;
      const sinks = yield* SessionSinks;
      const viewers = yield* Viewers;
      const sessionsDir = yield* SessionsDir;
      const deps = yield* ManagedDeps;
      const serverScope = yield* Effect.scope;
      const state = yield* Ref.make<State>({ kind: "idle", installations: 0 });
      const reserveDeps = Effect.acquireRelease(
        Effect.gen(function* () {
          const refusal = yield* Ref.modify(state, (current): [Option.Option<SessionFailure>, State] =>
            current.kind === "idle"
              ? [Option.none(), { kind: "idle", installations: current.installations + 1 }]
              : [Option.some(current.kind === "live" || current.kind === "recorded" ? new SessionBusy() : new SessionTransition()), current]);
          if (Option.isSome(refusal)) return yield* refusal.value;
        }),
        () => Ref.update(state, (current): State => current.kind === "idle" ? { kind: "idle", installations: current.installations - 1 } : current),
      );

      // 標準エラー。Console.error が末尾に改行を足すので、渡された文字列の末尾の改行は 1 つ外す（出力のバイト列は変えない）
      const note = (text: string) => Console.error(withoutFinalNewline(text));
      const intakeFrame = (status: "running" | "interrupted" | "stopped" | "none") => viewers.intake({ type: "intake", status });

      // run の argv（port は Helpers が足す。audio・origin は未定義なら渡さない。screen が false なら --no-screen。
      // 休止の規則の状態は、初期状態と違う値だけ渡す）
      const runArgs = (live: Pick<Live, "app" | "dir" | "audio" | "screen">, attempt: number, origin: string | undefined, selfPause: SelfPauseState): string[] => [
        "run",
        "--app",
        live.app,
        ...(live.audio ? ["--audio-dir", live.dir, "--audio-index", String(attempt)] : []),
        ...(live.screen ? [] : ["--no-screen"]),
        ...(origin !== undefined ? ["--origin", origin] : []),
        ...(selfPause.manual !== INITIAL_SELF_PAUSE_STATE.manual ? ["--self-manual", selfPause.manual] : []),
        ...(selfPause.basis !== INITIAL_SELF_PAUSE_STATE.basis ? ["--self-basis", selfPause.basis] : []),
        ...(selfPause.lastKnown !== INITIAL_SELF_PAUSE_STATE.lastKnown ? ["--self-last-known", selfPause.lastKnown] : []),
        ...(selfPause.idleFor !== INITIAL_SELF_PAUSE_STATE.idleFor ? ["--self-idle-for", String(selfPause.idleFor)] : []),
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
            // 新しい origin は起動し直したヘルパーのもので、前の回の「届いていません」は消す（保持が無ければ何も変わらない）
            return Effect.andThen(
              Ref.update(live.origin, (origin) => origin ?? event.hostTime),
              viewers.tapNotice({ type: "tap-notice", text: null }),
            );
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
            return live.sink.screen({ start: event.start, image: event.image, lines: event.lines });
          case "screen-off":
            // 共有画面だけが取れないことは取り込みの途切れではないので、appendLog・intake・起動し直しには触れない。
            // ログには届くたびに残し、画面の一文はセッションにつき 1 回だけ出す
            return Effect.andThen(live.sink.screenOff({ start: event.start, reason: event.reason }), showScreenNotice(live));
          case "tap-silent":
            // 音声が届かないことは取り込みの途切れではないので、intake・起動し直しには触れない。
            // ログには届くたびに残し、一文は届くたびに出す（起動し直した回でも出し直す）。消すのは新しい origin かセッションの終わり
            return Effect.andThen(
              live.sink.appendLog({ type: "tap-silent", start: event.start }),
              viewers.tapNotice({ type: "tap-notice", text: TAP_NOTICE_TEXT }),
            );
          case "self-pause": {
            // 報告された状態と比べ、paused が変わったときだけログ（組）とフレームを出す。休止中に理由だけが変わったときはフレームだけ出す。
            // 同じ状態・同じ理由のイベントは何も変えない。取り込みの途切れではないので、intake・起動し直しには触れない
            const frame: SelfPauseFrame = event.paused ? { type: "self-pause", paused: true, reason: event.reason } : { type: "self-pause", paused: false };
            return Effect.flatMap(
              Ref.modify(live.selfPauseFrame, (current): ["transition" | "reason" | "same", SelfPauseFrame] => [
                current.paused !== frame.paused ? "transition" : current.paused && frame.paused && current.reason !== frame.reason ? "reason" : "same",
                frame,
              ]),
              (change) =>
                change === "transition"
                  ? Effect.andThen(
                      live.sink.appendLog({ type: event.paused ? "self-paused" : "self-resumed", reason: event.reason, start: event.start }),
                      viewers.selfPause(frame),
                    )
                  : change === "reason" ? viewers.selfPause(frame) : Effect.void,
            );
          }
          case "self-pause-state": {
            // 起動し直しで送り直すために覚えるだけ。ログにも画面にも出さない
            const { type: _type, ...state } = event;
            return Ref.set(live.selfPauseState, state);
          }
          case "file-duration":
            // 録画の文字起こしだけが流す。ライブのヘルパーは流さないので、何もしない
            return Effect.void;
          case "speaker":
          case "speaker-off":
          case "speaker-settled":
            // 受け取った値のまま、届いた順に log.jsonl へ残し（sink が行う）、相手の発言の話者を決める段へ渡す。字幕・差分更新には載せない
            return live.sink.speaker(event);
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

      const handleEventWith = (apply: (event: HelperEvent) => Effect.Effect<void>) => (data: string) =>
        decodeHelperEvent(data).pipe(
          Effect.map((decoded) => (decoded.kind === "unknown" ? undefined : decoded.event)),
          Effect.catchTag("SchemaError", (error) => Effect.as(skipped(error.message), undefined)),
          Effect.catchDefect((defect) => Effect.as(skipped(defectReason(defect)), undefined)),
          Effect.flatMap((event) =>
            event === undefined ? Effect.void : apply(event).pipe(Effect.catchDefect((defect) => applyFailed(defectReason(defect)))),
          ),
        );
      const handleEvent = (live: Live) => handleEventWith((event) => applyEvent(live, event));

      // 接続済みのヘルパー 1 回分を、終わるまで読む。ヘルパーが終われば接続が閉じて読み取りが終わり、
      // 標準エラーを読み終えた終わり方が確定する。終わったら 1 回分の Scope を閉じる
      const serve = Effect.fnUntraced(function* (live: Live, { attempt, scope }: Launched) {
        // 「止めて」の印が立ったら、その回のヘルパーを止める
        yield* Effect.forkIn(Effect.andThen(Deferred.await(live.stopRequested), attempt.stop), scope);
        yield* Stream.runForEach(attempt.events, handleEvent(live)).pipe(
          Effect.ensuring(SynchronizedRef.set(live.selfPauseLink, { kind: "waiting", pending: undefined })),
        );
        const exit = yield* attempt.exit;
        const stderrTail = yield* attempt.stderrTail;
        yield* Scope.close(scope, Exit.void);
        return { exit, stderrTail };
      });

      const markStopped = (live: Live) => Effect.andThen(Ref.set(live.intake, "stopped"), intakeFrame("stopped"));

      // 次のヘルパーを 1 回起動する。end は連鎖を終える（exit は stop へ渡す終わり方）、retry は続けて起動し直す、
      // launched は接続できたもの。restarted は、起動し直しとして数えた（以後の途切れは自動になる）ときだけ true
      const relaunch = Effect.fnUntraced(function* (live: Live, reason: "auto" | "resume", outcome: Deferred.Deferred<RestartOutcome>) {
        if (yield* Deferred.isDone(live.stopRequested)) return { kind: "end" as const, exit: undefined };
        const attemptNo = yield* Ref.updateAndGet(live.attempt, (n) => n + 1);
        yield* Ref.set(live.attemptStartedAt, yield* Clock.currentTimeMillis);
        const scope = yield* Scope.fork(live.scope, "sequential");
        // 休止の規則の状態は、helper が知らせた最新のものを引き継ぐ。接続待ちの間に求められた状態は、接続した回へ送る
        const result = yield* helpers.launch(runArgs(live, attemptNo, yield* Ref.get(live.origin), yield* Ref.get(live.selfPauseState)), live.stopRequested).pipe(
          Scope.provide(scope),
          Effect.result,
        );
        if (Result.isFailure(result)) {
          yield* Scope.close(scope, Exit.void);
          if (yield* Deferred.isDone(live.stopRequested)) return { kind: "end" as const, exit: result.failure.exit }; // 中断。stop が後片付けを引き継ぐ（止めたヘルパーの終わり方を stop へ渡す）
          const failure = result.failure;
          const action = yield* finishAttempt(live, failure.exit ?? { code: null, signal: null }, failure.stderrTail);
          if (action === "giveup") {
            yield* markStopped(live);
            yield* Deferred.succeed(outcome, { kind: "stopped", stderrTail: failure.stderrTail });
            return { kind: "end" as const, exit: undefined };
          }
          return { kind: "retry" as const }; // 続けて起動し直す
        }
        const launched: Launched = { attempt: result.success, scope };
        // 起動の引数を決めた後に求められた状態は、接続できた回へ送る（落とさない）
        yield* SynchronizedRef.updateEffect(live.selfPauseLink, (link) =>
          Effect.as(
            link.kind === "waiting" && link.pending !== undefined ? result.success.send(link.pending) : Effect.void,
            { kind: "connected", attempt: result.success } as SelfPauseLink,
          ),
        );
        // 中断された後に接続が追いついた（接続成功と stop が競合した）。起動し直しとは数えず、届いていたイベントを
        // 読み終えてから止まる
        if (yield* Deferred.isDone(live.stopRequested)) return { kind: "launched" as const, launched, restarted: false };
        yield* Ref.update(live.restarts, (n) => n + 1);
        yield* live.sink.appendLog({ type: "intake-restarted", trigger: reason });
        yield* note("ヘルパーを起動し直しました\n");
        yield* Ref.set(live.intake, "running");
        yield* intakeFrame("running");
        yield* Deferred.succeed(outcome, { kind: "running" });
        return { kind: "launched" as const, launched, restarted: true };
      });

      // 接続済みのヘルパー 1 回分を読み終えた後を扱う。end は連鎖を終える、continue は次の起動し直しへ進む
      const afterServe = Effect.fnUntraced(function* (live: Live, launched: Launched) {
        const { exit, stderrTail } = yield* serve(live, launched);
        // stop・サーバーの終了による意図した終了。届いていた最後の発話を落とさず、起動し直さない
        if (yield* Deferred.isDone(live.stopRequested)) {
          yield* live.sink.drain;
          return { kind: "end" as const, exit };
        }
        yield* live.sink.drain; // 確定結果に覆われなかった最後の発話を発言にする
        yield* live.sink.clearSpeaking; // いま話している文字を空にする（永久停止はしない）
        yield* Ref.set(live.lastInterruptedAt, DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)));
        const action = yield* finishAttempt(live, exit, stderrTail);
        if (action === "giveup") {
          yield* markStopped(live);
          return { kind: "end" as const, exit: undefined };
        }
        yield* Ref.set(live.intake, "interrupted");
        yield* intakeFrame("interrupted");
        return { kind: "continue" as const };
      });

      // 起動し直しの連鎖。成功するまで（または諦めるまで）、decideIntakeRestart の判断に従って繰り返す。
      // initial があれば最初の 1 回は起動済みのもの（start の初回起動）。trigger は、最初の起動し直しの成功をログに残す
      // 「自動か resume か」の区別（以後の途切れは自動）。outcome は、最初の成功か諦めか中断で解決する（resume の応答の基準）
      const chain = Effect.fnUntraced(function* (live: Live, initial: Launched | undefined, trigger: "auto" | "resume", outcome: Deferred.Deferred<RestartOutcome>) {
        let current = initial;
        let reason = trigger;
        for (;;) {
          if (current === undefined) {
            const step = yield* relaunch(live, reason, outcome);
            if (step.kind === "end") return { exit: step.exit };
            if (step.kind === "retry") continue;
            if (step.restarted) reason = "auto";
            current = step.launched;
          }
          const launched = current;
          current = undefined;
          const after = yield* afterServe(live, launched);
          if (after.kind === "end") return { exit: after.exit };
        }
      }, (effect, _live, _initial, _trigger, outcome) => effect.pipe(Effect.ensuring(Deferred.succeed(outcome, { kind: "aborted" }))));

      const begin = Effect.fnUntraced(function* (input: SessionStart): Effect.fn.Return<{ dir: string; warnings: ReadonlyArray<string> }, SessionFailure> {
        const scope = yield* Scope.fork(serverScope, "sequential");
        return yield* Effect.gen(function* () {
          const warnings = yield* requireStartupDeps("start", input.model.route, { screen: input.screen, check: input.screen ? helpers.check : helpers.checkNoScreen }).pipe(Effect.provideService(ManagedDeps, deps));
          const updaterLayer = yield* sinks.prepare(input.model, input.judge).pipe(Scope.provide(scope), Effect.mapError(startupPreparationFailure));
          const dir = yield* sinks.createDir(sessionsDir);
          // 60 秒の判断の基準は、接続が成功した時刻ではなく、起動（接続待ちを含む）を始めた時刻にする。
          // 接続はマイクの許可待ち等で時間がかかることがあり、ここを接続成功後にすると、長く待ってから
          // 短時間で終わった回を「続けて失敗した」と誤って数えてしまう（起動し直しと同じ基準にそろえる）
          const startedAt = yield* Clock.currentTimeMillis;
          const stopRequested = yield* Deferred.make<void>();
          const attemptScope = yield* Scope.fork(scope, "sequential");
          const attempt = yield* helpers
            .launch(runArgs({ app: input.app, dir, audio: input.audio, screen: input.screen }, 1, undefined, INITIAL_SELF_PAUSE_STATE), stopRequested)
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
          if (input.vocab.length > 0) yield* sink.addUserVocabulary(input.vocab);
          const live: Live = {
            model: input.model,
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
            selfPauseFrame: yield* Ref.make<SelfPauseFrame>({ type: "self-pause", paused: false }),
            selfPauseState: yield* Ref.make<SelfPauseState>(INITIAL_SELF_PAUSE_STATE),
            selfPauseLink: yield* SynchronizedRef.make<SelfPauseLink>({ kind: "connected", attempt }),
          };
          const outcome = yield* Deferred.make<RestartOutcome>();
          const fiber = yield* Effect.forkIn(chain(live, { attempt, scope: attemptScope }, "auto", outcome), scope);
          yield* Ref.set(live.chain, fiber);
          yield* Ref.set(state, { kind: "live", live });
          yield* Scope.addFinalizer(scope, viewers.sessionMode({ type: "session-mode", local: false }));
          yield* viewers.sessionMode({ type: "session-mode", local: input.model.local });
          return { dir, warnings };
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

      const start = Effect.fnUntraced(function* (input: SessionStart): Effect.fn.Return<{ dir: string; warnings: ReadonlyArray<string> }, SessionFailure> {
        const refusal = yield* Ref.modify(state, (current): [Option.Option<SessionFailure>, State] =>
          current.kind === "idle" && current.installations === 0
            ? [Option.none(), { kind: "starting" }]
            : [Option.some(current.kind === "live" || current.kind === "recorded" ? new SessionBusy() : new SessionTransition()), current],
        );
        if (Option.isSome(refusal)) return yield* refusal.value;
        return yield* begin(input).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(state, { kind: "idle", installations: 0 }) : Effect.void)),
        );
      });

      // セッションを閉じて idle に戻す（ライブの stop と録画からのセッションの終わりが共有する）。
      // 停止の成否に関係なく、予約を取り消して両トラックの仮の文字を空にする（失敗しても、古い文字が新規接続へ再送されない）
      const closeSession = (sink: SessionSink, scope: Scope.Closeable) =>
        Effect.gen(function* () {
          yield* sink.stopRelays;
          // session.flush() で最後の差分更新が終わっているので、ここで閉じる（updater・ヘルパーの後始末）
          yield* Scope.close(scope, Exit.void);
          // 接続中のクライアントにも、途切れ・止まったの一言を消すフレームを送る。status は "running" ではなく
          // "none"（セッションが無い）にする。"running" だと、直前が interrupted/stopped だったクライアントが
          // 「再開した」と解釈し、終わったセッションに「再開しました」が出てしまう（CT-NOTICE-CLEAR）
          yield* intakeFrame("none");
          // 相手の音声が届いていないことの一文も、セッションの終わりで消す
          yield* viewers.tapNotice({ type: "tap-notice", text: null });
          // 自分を休止中の一文も、セッションの終わりで消す
          yield* viewers.selfPause({ type: "self-pause", paused: false });
        }).pipe(Effect.ensuring(Ref.set(state, { kind: "idle", installations: 0 })));

      // 録画の文字起こしのイベントを、セッションへつなぐ。話者は分けないので、使うのは発言・途中結果・全体の長さだけ
      const publishProgress = ({ progress, events }: Pick<Recorded, "progress" | "events">) =>
        Effect.flatMap(Ref.get(progress), (current) => Queue.offer(events, { type: "progress", ...current }));

      const applyRecordedEvent = (recorded: Recorded, event: HelperEvent): Effect.Effect<void> => {
        switch (event.type) {
          case "remark": {
            const { type: _type, ...settled } = event;
            return recorded.sink.final(settled);
          }
          case "partial": {
            const { type: _type, ...partial } = event;
            return recorded.sink.partial(partial);
          }
          case "file-duration":
            return Effect.andThen(Ref.update(recorded.progress, (p) => ({ ...p, duration: event.duration })), publishProgress(recorded));
          default:
            return Effect.void;
        }
      };

      // イベント列を終え、セッションの Scope を閉じる。状態を recorded にした後の終わらせ方は、成功・失敗・中断のどれでも必ずここを通す
      const closeRecorded = (recorded: Recorded) => Effect.andThen(Queue.end(recorded.events), closeSession(recorded.sink, recorded.scope));

      // 書き出して終える。helperFailure があれば、終わりの知らせに載せる。終わらせる後始末（closeRecorded）は呼び出し側が付ける
      const finishRecorded = (recorded: Recorded, failure: { code: number | null; signal: string | null; stderrTail: ReadonlyArray<string> } | undefined) =>
        Effect.gen(function* () {
          yield* recorded.sink.flush;
          const paths = yield* recorded.sink.exports;
          yield* Queue.offer(recorded.events, { type: "finished", paths, ...(failure === undefined ? {} : { failure }) });
          return { paths };
        });

      // ヘルパーの出力を、終わるまで読む。終わったら、止められていなければ（stop と取り合って先に取れたら）そこまでの分を入れ切って終える。
      // 終わらせる本体は、セッションの Scope が閉じても続くよう、サーバーの Scope の fiber で動かす
      const runRecorded = Effect.fnUntraced(function* (recorded: Recorded, attempt: HelperAttempt, attemptScope: Scope.Closeable) {
        yield* Effect.forkIn(Effect.andThen(Deferred.await(recorded.stopRequested), attempt.stop), attemptScope);
        yield* Stream.runForEach(attempt.events, handleEventWith((event) => applyRecordedEvent(recorded, event)));
        const exit = yield* attempt.exit;
        const stderrTail = yield* attempt.stderrTail;
        // 1 回分の Scope（ヘルパーの停止）は、読み終えても閉じない。セッションの Scope が閉じるときに後始末される
        if (yield* Deferred.isDone(recorded.stopRequested)) return;
        const failed = exit.code !== 0;
        if (failed) yield* note(`取り込みが止まった（${exit.code ?? exit.signal ?? "不明"}）\n`);
        // 0 以外で終わっても、そこまでに文字にして届いた分は入れ切って終える。入れている間、状態は recorded のまま
        // （status・share が効き、別のセッションは始められない）。入れ切る前に stop が状態を取れば、溜まりが捨てられて早く戻る
        // 入れ切る途中で失敗（defect を含む）しても、所有権を取って後始末（イベント列を終える・Scope を閉じる・idle に戻す）まで進める
        const drained = yield* Effect.exit(Effect.andThen(recorded.sink.drain, recorded.sink.finishBacklog));
        const claimed = yield* Ref.modify(state, (current): [boolean, State] =>
          current.kind === "recorded" && current.recorded === recorded ? [true, { kind: "stopping" }] : [false, current]);
        if (!claimed) return;
        const finishing = Exit.isFailure(drained)
          ? Effect.andThen(note(`録画の取り込みの終了処理に失敗した: ${Cause.pretty(drained.cause)}\n`), Effect.failCause(drained.cause))
          : finishRecorded(recorded, failed ? { code: exit.code, signal: exit.signal, stderrTail: [...stderrTail] } : undefined);
        yield* Effect.forkIn(finishing.pipe(Effect.ensuring(closeRecorded(recorded))), serverScope);
      });

      const beginRecorded = Effect.fnUntraced(function* (input: RecordedStart): Effect.fn.Return<RecordedRun, SessionFailure> {
        const scope = yield* Scope.fork(serverScope, "sequential");
        return yield* Effect.gen(function* () {
          const warnings = yield* requireStartupDeps("recorded", input.model.route, { check: helpers.checkNoScreen }).pipe(Effect.provideService(ManagedDeps, deps));
          const updaterLayer = yield* sinks.prepare(input.model).pipe(Scope.provide(scope), Effect.mapError(startupPreparationFailure));
          // 基準の時刻は、ファイルの作成日時。取れないとき（記録が無い・聞けなかった）は、流し始めた今の時刻。
          // フォルダ名と log.jsonl の時刻は、この 1 つの基準から決める（ずらし幅 = 基準 − 今）
          const now = DateTime.nowUnsafe();
          const created = yield* helpers.creationDate(input.file).pipe(
            Effect.catchTag("HelperCreationDateFailure", (failure) =>
              Effect.as(note(`作成日時を読めないので、今の時刻でセッションを作ります: ${failure.message}\n`), null)),
          );
          const createdAt = created === null ? Option.none() : DateTime.make(created);
          const base = Option.getOrElse(createdAt, () => now);
          const dir = yield* sinks.createDir(sessionsDir, base);
          const stopRequested = yield* Deferred.make<void>();
          const attemptScope = yield* Scope.fork(scope, "sequential");
          const attempt = yield* helpers
            .launch(["transcribe-file", "--file", input.file, "--audio-dir", dir], stopRequested)
            .pipe(
              Scope.provide(attemptScope),
              Effect.catchTag("HelperLaunchFailure", (failure) =>
                Effect.fail(new HelperExited({ code: failure.exit?.code ?? null, signal: failure.exit?.signal ?? null, stderrTail: failure.stderrTail })),
              ),
            );
          const events = yield* Queue.unbounded<RecordedEvent, Cause.Done>();
          const progress = yield* Ref.make<RecordedProgressState>({ position: 0, duration: null, rounds: 0 });
          const sink = yield* sinks.open({
            dir, title: input.title ?? parse(input.file).name, logShiftMs: DateTime.toEpochMillis(base) - DateTime.toEpochMillis(now),
            model: input.model, updaterLayer, publish: viewers.publish, speak: viewers.speak, diffUpdate: viewers.diffUpdate,
            recorded: {
              progress: ({ position, rounds }) =>
                Effect.andThen(
                  Ref.update(progress, (p) => ({ ...p, position: Math.max(p.position, position), rounds })),
                  publishProgress({ progress, events }),
                ),
            },
          }).pipe(Scope.provide(scope));
          if (input.vocab.length > 0) yield* sink.addUserVocabulary(input.vocab);
          const recorded: Recorded = { model: input.model, dir, sink, scope, stopRequested, run: yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined), events, progress };
          // 状態を recorded にしてから読み始める（ヘルパーがすぐ終わっても、終わらせる側が状態を取れるように）
          const ready = yield* Deferred.make<void>();
          const run = yield* Effect.forkIn(Effect.andThen(Deferred.await(ready), runRecorded(recorded, attempt, attemptScope)), scope);
          yield* Ref.set(recorded.run, run);
          yield* Ref.set(state, { kind: "recorded", recorded });
          yield* Deferred.succeed(ready, undefined);
          yield* Scope.addFinalizer(scope, viewers.sessionMode({ type: "session-mode", local: false }));
          yield* viewers.sessionMode({ type: "session-mode", local: input.model.local });
          return { dir, warnings, events: Stream.fromQueue(events) };
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

      const startRecorded = Effect.fnUntraced(function* (input: RecordedStart): Effect.fn.Return<RecordedRun, SessionFailure> {
        const refusal = yield* Ref.modify(state, (current): [Option.Option<SessionFailure>, State] =>
          current.kind === "idle" && current.installations === 0
            ? [Option.none(), { kind: "starting" }]
            : [Option.some(current.kind === "live" || current.kind === "recorded" ? new SessionBusy() : new SessionTransition()), current],
        );
        if (Option.isSome(refusal)) return yield* refusal.value;
        return yield* beginRecorded(input).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(state, { kind: "idle", installations: 0 }) : Effect.void)),
        );
      });

      // 止めて書き出す。順番の要る停止（ヘルパーを止める → 読み終える → 書き出す）は本体に書き、
      // Scope の後始末（updater を閉じる等）は、途中で失敗・中断されたときの安全網にもなる
      const stopLive = (live: Live) =>
        Effect.gen(function* () {
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
        }).pipe(Effect.ensuring(closeSession(live.sink, live.scope)));

      // 録画からのセッションの stop。溜まっている発言は入れず、入れている途中の 1 件だけ入れ終えて、そこまでの分で書き出す
      const stopRecorded = (recorded: Recorded) =>
        Effect.gen(function* () {
          // 溜まりを捨ててから止めの印を立てる（印で差分更新の待ちがほどけても、次の発言を取らせない）
          yield* recorded.sink.discardBacklog;
          yield* Deferred.succeed(recorded.stopRequested, undefined);
          const fiber = yield* Ref.get(recorded.run);
          if (fiber !== undefined) yield* Fiber.join(fiber);
          yield* recorded.sink.finishBacklog;
          return yield* finishRecorded(recorded, undefined);
        }).pipe(Effect.ensuring(closeRecorded(recorded)));

      // 止めて書き出す。順番の要る停止（ヘルパーを止める → 読み終える → 書き出す）は本体に書き、
      // Scope の後始末（updater を閉じる等）は、途中で失敗・中断されたときの安全網にもなる
      const stop = Effect.uninterruptible(
        Effect.gen(function* () {
          const claimed = yield* Ref.modify(state, (current): [Result.Result<Extract<State, { kind: "live" | "recorded" }>, SessionFailure>, State] =>
            current.kind === "live" || current.kind === "recorded"
              ? [Result.succeed(current), { kind: "stopping" }]
              : [Result.fail(current.kind === "idle" ? new NoSession() : new SessionTransition()), current],
          );
          if (Result.isFailure(claimed)) return yield* claimed.failure;
          const target = claimed.success;
          // 本体は呼び出し側（HTTP 要求の fiber）ではなくサーバーの Scope の fiber で動かす。要求の切断で呼び出し側が
          // 中断されても、読み終える・書き出す・状態を idle に戻すまで続ける。中断はサーバーの終了（serverScope を閉じる）だけ
          const body = target.kind === "live" ? stopLive(target.live) : stopRecorded(target.recorded);
          const running = yield* Effect.forkIn(Effect.interruptible(body), serverScope);
          return yield* Effect.interruptible(Fiber.join(running));
        }),
      );

      // 応答は、起動し直しの連鎖が実際に到達した状態（RestartOutcome）から作る
      const resume = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.kind === "recorded") return yield* new NotForRecordedSession();
        if (current.kind !== "live") return yield* new NoSession();
        const { live } = current;
        if ((yield* Ref.get(live.intake)) !== "stopped") return yield* new IntakeNotStopped();
        const warnings = yield* requireStartupDeps("resume", live.model.route, { screen: live.screen, check: live.screen ? helpers.check : helpers.checkNoScreen }).pipe(Effect.provideService(ManagedDeps, deps));
        const afterCheck = yield* Ref.get(state);
        if (afterCheck.kind !== "live" || afterCheck.live !== live || (yield* Deferred.isDone(live.stopRequested))) return yield* new Aborted();
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
        return { warnings };
      });

      const checkResume = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.kind === "recorded") return yield* new NotForRecordedSession();
        if (current.kind !== "live") return yield* new NoSession();
        return yield* checkManagedDeps("resume", current.live.model.route, { screen: current.live.screen, check: current.live.screen ? helpers.check : helpers.checkNoScreen }).pipe(Effect.provideService(ManagedDeps, deps));
      });

      const status: Effect.Effect<IntakeStatusReport> = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        // 録画からのセッションは、ヘルパーが読み終えるまで動いていて、途切れも起動し直しもない
        if (current.kind === "recorded") return { status: "running", dir: current.recorded.dir, restarts: 0, lastInterruptedAt: undefined };
        if (current.kind !== "live") return { status: "none" };
        const { live } = current;
        return {
          status: yield* Ref.get(live.intake),
          dir: live.dir,
          restarts: yield* Ref.get(live.restarts),
          lastInterruptedAt: yield* Ref.get(live.lastInterruptedAt),
        };
      });

      const liveSession: Effect.Effect<{ readonly scope: Scope.Scope; readonly local: boolean }, SessionFailure> = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.kind === "live") return { scope: current.live.scope, local: current.live.model.local };
        if (current.kind === "recorded") return { scope: current.recorded.scope, local: current.recorded.model.local };
        return yield* (current.kind === "idle" ? new NoSession() : new SessionTransition());
      });

      // 求める状態を、いま接続している helper へ指示として送る（同じ状態の指示でも送る。何も変えないかどうかは helper の側が決める）。
      // 接続していない間（起動し直しの途中）に求められた状態は、接続した回への送信で helper へ届く。
      // 受け付けたかどうかは helper の self-pause イベントだけが決める（無視された要求は残らない）
      const setSelfPause = (paused: boolean): Effect.Effect<void, SessionFailure> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.kind === "recorded") return yield* new NotForRecordedSession();
          if (current.kind !== "live") return yield* (current.kind === "idle" ? new NoSession() : new SessionTransition());
          yield* SynchronizedRef.updateEffect(current.live.selfPauseLink, (link): Effect.Effect<SelfPauseLink> =>
            link.kind === "connected" ? Effect.as(link.attempt.send(paused), link) : Effect.succeed({ kind: "waiting", pending: paused }));
        });

      return Sessions.of({ apps: helpers.apps, start, startRecorded, stop, status, resume, checkResume, reserveDeps, liveSession, setSelfPause });
    }),
  );
}
