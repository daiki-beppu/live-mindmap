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
import { Cause, Clock, Console, Context, DateTime, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Result, Scope, Stream } from "effect";
import { parse } from "node:path";
import {
  type RecordedEvent,
  type RecordedProgress,
  isScreenBrowser,
  makeMeetingTabNotice,
  SCREEN_NOTICE_MS,
  SCREEN_NOTICE_TEXT,
  INITIAL_SELF_PAUSE_STATE,
  TAP_NOTICE_TEXT,
  type HelperEvent,
  type IntakeStatusReport,
  type SelfPauseFrame,
  type SelfPauseState,
  type Track,
} from "./core/index.ts";
import { openIntake } from "./intakeAttempts.ts";
import { withoutFinalNewline } from "./consoleText.ts";
import { Helpers, HELPER_STOP_TIMEOUT_MS } from "./helpers.ts";
import {
  Aborted,
  IntakeNotStopped,
  NoSession,
  NotForRecordedSession,
  RestartGaveUp,
  SessionBusy,
  SessionTransition,
  type SessionFailure,
  type SpeakerNameRejected,
} from "./sessionFailure.ts";
import { planModel } from "./updatePlan.ts";
import { audioFileNames, SessionSinks, type LiveSink, type RecordedSink } from "./sessionSinks.ts";
import { Viewers } from "./viewers.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { checkManagedDeps, requireRecordedTranscriptDeps, requireStartupDeps, startupPreparationFailure } from "./managedDepsCheck.ts";
import type { CheckReport } from "./managedDepsProtocol.ts";

// セッションの開始に渡す値。null と省略はどちらも「指定なし」で、既定は title がフォルダ名・audio が録音する
// vocab は利用者が足した語（cli start --vocab。1 語ずつ。足さなければ空）。開始のときにだけ受け取る
// 差分更新の計画 plan は CLI が決め、server が検めたもの。モデルは planModel(plan)
export type SessionStart = { app: string; title: string | undefined; audio: boolean; screen: boolean; vocab: ReadonlyArray<string>; plan: import("./updatePlan.ts").UpdatePlan };

// 録画からのセッション（cli recorded）の開始に渡す値。file は絶対パス。title・vocab・plan は SessionStart と同じ意味。realtime は音声の時刻どおりに等速で入れる。
// selfFile は自分用の録音のファイル（絶対パス。cli recorded --self）。あれば、file を 相手、selfFile を 自分 の 2 トラックで組む
export type RecordedStart = { file: string; selfFile?: string; title: string | undefined; vocab: ReadonlyArray<string>; realtime: boolean } & ({ noMap: true; plan?: never } | { noMap?: false; plan: import("./updatePlan.ts").UpdatePlan });

// セッションのフォルダを作る親のフォルダ
export class SessionsDir extends Context.Service<SessionsDir, string>()("live-mindmap/server/SessionsDir") {}

type IntakeKind = "running" | "interrupted" | "stopped";

type Intake = Effect.Success<ReturnType<typeof openIntake>>;
type IntakeRun = Effect.Success<ReturnType<Intake["run"]>>;

type Live = {
  model: import("./modelSelection.ts").ExecutableModel;
  app: string;
  dir: string;
  audio: boolean;
  screen: boolean; // false なら共有画面を取り込まない（ヘルパーに --no-screen を渡す。起動し直し・resume でも引き継ぐ）
  noticeShown: Ref.Ref<boolean>; // 許可なしの一文を出したか。セッションにつき 1 回だけ（起動し直しをまたぐ）
  meetingTabNotice: Effect.Success<ReturnType<typeof makeMeetingTabNotice>>;
  sink: LiveSink;
  controller: Intake;
  running: Ref.Ref<IntakeRun | undefined>;
  scope: Scope.Closeable; // セッションの Scope。サーバーの Scope の子
  intake: Ref.Ref<IntakeKind>;
  origin: Ref.Ref<string | undefined>; // 最初のヘルパーから受け取った原点。一度決まったら上書きしない
  lastInterruptedAt: Ref.Ref<string | undefined>; // 最後に途切れた時刻（ISO）
  selfPauseFrame: Ref.Ref<SelfPauseFrame>; // helper が報告した自分の休止の状態と理由（Issue #1069・#1071）。paused が変わったときだけログとフレームを出し、休止中に理由だけが変わったときはフレームだけ出す
  selfPauseState: Ref.Ref<SelfPauseState>; // helper が知らせた休止の規則の状態。起動し直しをまたいで続き、次の起動の引数になる（server は覚えるだけ）
};

// セッションに入れた位置（秒）・録画の全体の長さ（届く前は null）・マップの更新回数・差分更新の一時停止（一時停止の間だけ。理由と次に試す時刻）
type RecordedProgressState = { position: number; duration: number | null; rounds: number; paused?: RecordedPause };
type RecordedPause = NonNullable<RecordedProgress["paused"]>;

// 録画からのセッション。ヘルパーが落ちたら、ライブと同じ判断（ADR 0008）で、最後に作った発言の end から読み直す
type Recorded = {
  local: boolean;
  dir: string;
  file: string;
  selfFile: string | undefined;
  sink: RecordedSink;
  controller: Intake;
  running: Ref.Ref<IntakeRun | undefined>;
  scope: Scope.Closeable; // セッションの Scope。サーバーの Scope の子
  events: Queue.Queue<RecordedEvent, Cause.Done>; // 開始の応答の stream へ流す進み具合・終わり
  progress: Ref.Ref<RecordedProgressState>;
  from: Ref.Ref<Partial<Readonly<Record<Track, number>>>>; // いまの回のヘルパーがトラックごとに読み始める音声の時刻（秒）。無いトラックは頭から。そのトラックでこれより前に始まる発言・途中結果は捨てる
  announced: Ref.Ref<Announced>; // 端末へ知らせた印。起動し直したヘルパーが流し直しても、セッションにつき 1 回だけ知らせる
};

type Announced = { audioTracks: boolean; screenOff: boolean; speakerOff: boolean };

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
  stop: Effect.Effect<{ paths: string[]; ocrSummary: typeof import("./core/recordedProgress.ts").OcrSummary.Type; kind: "live" | "recorded" }, SessionFailure>;
  status: Effect.Effect<IntakeStatusReport>;
  resume: Effect.Effect<{ warnings: ReadonlyArray<string> }, SessionFailure>;
  checkResume: Effect.Effect<typeof CheckReport.Type, SessionFailure>;
  reserveDeps: Effect.Effect<void, SessionFailure, Scope.Scope>;
  // いま進行中のセッション（ライブ・録画から）の Scope（閲覧の共有の寿命をセッションに結ぶ）と、ローカルモードかどうか。無ければ失敗する
  liveSession: Effect.Effect<{ readonly scope: Scope.Scope; readonly local: boolean }, SessionFailure>;
  // 自分の休止・再開を求める（paused が求める状態。Issue #1069）。いま接続している helper へ指示を送る。live でなければ失敗する（録画からのセッションは NotForRecordedSession）
  setSelfPause: (paused: boolean) => Effect.Effect<void, SessionFailure>;
  // 話者のラベル（相手 B）に名前を手で付ける（Issue #1026）。ライブも録画からのセッションも同じ（録画も話者分離でラベルを振る。Issue #1094）。
  // 付けられないラベル・空の名前は SpeakerNameRejected
  setSpeakerName: (speaker: { label: string; name: string }) => Effect.Effect<void, SessionFailure | SpeakerNameRejected>;
}>()("live-mindmap/server/Sessions") {
  static readonly layer: Layer.Layer<Sessions, never, Helpers | SessionSinks | SessionsDir | Viewers | ManagedDeps> = Layer.effect(Sessions)(
    Effect.gen(function* () {
      const helpers = yield* Helpers;
      const sinks = yield* SessionSinks;
      const viewers = yield* Viewers;
      const sessionsDir = yield* SessionsDir;
      const deps = yield* ManagedDeps;
      const serverScope = yield* Effect.scope;
      const stopTimeoutMs = yield* HELPER_STOP_TIMEOUT_MS;
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
            return Effect.andThen(
              live.meetingTabNotice.screen({ start: event.start, hasImage: event.image !== null, meetingTabTitle: event.meetingTabTitle }),
              live.sink.screen({ start: event.start, image: event.image, lines: event.lines, ...(event.ocrFailed === true ? { ocrFailed: event.ocrFailed } : {}) }),
            );
          case "screen-off":
            // 共有画面だけが取れないことは取り込みの途切れではないので、appendLog・intake・起動し直しには触れない。
            // ログには届くたびに残し、画面の一文はセッションにつき 1 回だけ出す
            return Effect.andThen(live.meetingTabNotice.reset,
              Effect.andThen(live.sink.screenOff({ start: event.start, reason: event.reason }), showScreenNotice(live)));
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
          case "file-audio-tracks":
            // 録画の文字起こしだけが流す。ライブのヘルパーは流さないので、何もしない
            return Effect.void;
          case "speaker":
          case "speaker-off":
          case "speaker-settled":
          case "speaker-mixed":
          case "speaker-centroid":
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

      const runLive = (live: Live, trigger: "auto" | "resume") => live.controller.run({
        trigger, exitZero: "restart", log: live.sink.appendLog,
        apply: (event) => applyEvent(live, event),
        observe: (transition) => Effect.gen(function* () {
          switch (transition.kind) {
            case "connected":
              if ((yield* live.controller.stats).attempt > 1) yield* live.sink.speakersRenumbered;
              break;
            case "crashed":
              yield* live.meetingTabNotice.reset;
              yield* live.sink.drain;
              yield* live.sink.clearSpeaking;
              yield* Ref.set(live.lastInterruptedAt, DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)));
              break;
            case "running":
            case "interrupted":
            case "stopped":
              yield* Ref.set(live.intake, transition.kind);
              yield* intakeFrame(transition.kind);
          }
        }),
      });

      const begin = Effect.fnUntraced(function* (input: SessionStart): Effect.fn.Return<{ dir: string; warnings: ReadonlyArray<string> }, SessionFailure> {
        const model = planModel(input.plan);
        const scope = yield* Scope.fork(serverScope, "sequential");
        return yield* Effect.gen(function* () {
          const startupWarnings = yield* requireStartupDeps("start", model.route, { screen: input.screen, check: input.screen ? helpers.check : helpers.checkNoScreen }).pipe(Effect.provideService(ManagedDeps, deps));
          const { layer: updaterLayer, notice } = yield* sinks.prepare(input.plan).pipe(Scope.provide(scope), Effect.mapError(startupPreparationFailure));
          const warnings = notice === undefined ? startupWarnings : [...startupWarnings, notice];
          const dir = yield* sinks.createDir(sessionsDir);
          const origin = yield* Ref.make<string | undefined>(undefined);
          const selfPauseState = yield* Ref.make<SelfPauseState>(INITIAL_SELF_PAUSE_STATE);
          const controller = yield* openIntake({
            scope, commands: { "self-pause": "pending-once" },
            argv: (attemptNo) => Effect.gen(function* () {
              return runArgs({ app: input.app, dir, audio: input.audio, screen: input.screen }, attemptNo, yield* Ref.get(origin), yield* Ref.get(selfPauseState));
            }),
          }).pipe(Effect.provideService(Helpers, helpers));
          // 初期ルートの公開は、ヘルパーへの接続が成功した後にする。公開したフレームは取り消せないので、
          // 開始に失敗するときに、接続中のクライアントへ空のマップを送らない
          const sink = yield* sinks.open({ dir, title: input.title, vocab: input.vocab, model, updaterLayer, publish: viewers.publish, speak: viewers.speak, speakerNames: viewers.speakerNames, diffUpdate: viewers.diffUpdate }).pipe(Scope.provide(scope));
          // 指定のログは、セッションを開いた直後（start の行の後、最初の発言より前）に 1 回だけ。applyEvent は経由しない（知らせは出さない）
          if (!input.screen) yield* sink.screenOff({ start: 0, reason: "指定" });
          const live: Live = {
            model,
            app: input.app,
            dir,
            audio: input.audio,
            screen: input.screen,
            noticeShown: yield* Ref.make(false),
            meetingTabNotice: yield* makeMeetingTabNotice({ enabled: input.screen && isScreenBrowser(input.app), notify: note }).pipe(Scope.provide(scope)),
            sink,
            scope,
            controller,
            running: yield* Ref.make<IntakeRun | undefined>(undefined),
            intake: yield* Ref.make<IntakeKind>("running"),
            origin,
            lastInterruptedAt: yield* Ref.make<string | undefined>(undefined),
            selfPauseFrame: yield* Ref.make<SelfPauseFrame>({ type: "self-pause", paused: false }),
            selfPauseState,
          };
          yield* Ref.set(live.running, yield* runLive(live, "auto"));
          yield* Ref.set(state, { kind: "live", live });
          yield* Scope.addFinalizer(scope, viewers.sessionMode({ type: "session-mode", local: false }));
          yield* viewers.sessionMode({ type: "session-mode", local: model.local });
          return { dir, warnings };
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

      const claimStart = Effect.gen(function* () {
        const refusal = yield* Ref.modify(state, (current): [Option.Option<SessionFailure>, State] =>
          current.kind === "idle" && current.installations === 0
            ? [Option.none(), { kind: "starting" }]
            : [Option.some(current.kind === "live" || current.kind === "recorded" ? new SessionBusy() : new SessionTransition()), current],
        );
        if (Option.isSome(refusal)) return yield* refusal.value;
      });

      const start = Effect.fnUntraced(function* (input: SessionStart): Effect.fn.Return<{ dir: string; warnings: ReadonlyArray<string> }, SessionFailure> {
        yield* claimStart;
        return yield* begin(input).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(state, { kind: "idle", installations: 0 }) : Effect.void)),
        );
      });

      // セッションを閉じて idle に戻す（ライブの stop と録画からのセッションの終わりが共有する）。
      // 停止の成否に関係なく、予約を取り消して両トラックの仮の文字を空にする（失敗しても、古い文字が新規接続へ再送されない）
      const closeSession = (sink: Pick<LiveSink, "stopRelays">, scope: Scope.Closeable) =>
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

      // 録画の文字起こしのイベントを、セッションへつなぐ。ヘルパーは `相手` に話者分離をかけ、話者の区間（speaker 系）も流す
      const publishProgress = ({ progress, events }: Pick<Recorded, "progress" | "events">) =>
        Effect.flatMap(Ref.get(progress), (current) => Queue.offer(events, { type: "progress", ...current }));

      // 1 回だけ端末へ知らせる印を立てる。立てたのがこの呼び出しなら true
      const announceOnce = (recorded: Recorded, key: "audioTracks" | "screenOff" | "speakerOff") =>
        Ref.modify(recorded.announced, (announced): [boolean, Announced] => [!announced[key], { ...announced, [key]: true }]);

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
          case "file-audio-tracks":
            // 1 本なら知らせることがない。2 本以上のときだけ、最初の 1 本だけを使ったことを端末へ回す（起動し直した回が流し直しても 1 回）
            return event.count > 1
              ? Effect.flatMap(announceOnce(recorded, "audioTracks"), (first) => first ? Queue.offer(recorded.events, { type: "audio-tracks", count: event.count }) : Effect.void)
              : Effect.void;
          case "screen":
            return recorded.sink.screen({ start: event.start, image: event.image, lines: event.lines, ...(event.ocrFailed === true ? { ocrFailed: event.ocrFailed } : {}) });
          case "screen-off":
            // ライブと違い、画面の一文（showScreenNotice）は出さない。代わりに端末へ知らせる（録画で screen-off が出るのは映像が読めないときだけ。
            // 起動し直した回が流し直しても、ログにも端末にも 1 回）
            return Effect.flatMap(announceOnce(recorded, "screenOff"), (first) =>
              Effect.andThen(recorded.sink.screenOff({ start: event.start, reason: event.reason }), first ? Queue.offer(recorded.events, { type: "screen-off" }) : Effect.void));
          case "speaker":
          case "speaker-settled":
          case "speaker-mixed":
          case "speaker-centroid":
            // ライブと同じ。受け取った値のまま log.jsonl へ残し、`相手` の発言の話者を決める段へ渡す（Issue #1094）
            return recorded.sink.speaker(event);
          case "speaker-off":
            // 話者分離が使えない。待たずに話者なしで出す段へ渡し、端末へも知らせる（起動し直した回が流し直しても、端末には 1 回）
            return Effect.flatMap(announceOnce(recorded, "speakerOff"), (first) =>
              Effect.andThen(recorded.sink.speaker(event), first ? Queue.offer(recorded.events, { type: "speaker-off", reason: event.reason }) : Effect.void));
          default:
            return Effect.void;
        }
      };

      // 起動し直した回は、ファイルの頭から結果を流し直すことがある。そのトラックの読み始める位置（from[track]）より前に始まる発言・途中結果は、
      // 前の回がすでに作った分なので捨てる（重ねて入れない。発言の番号も進めない）
      const applyRecordedEventFrom = (recorded: Recorded, event: HelperEvent): Effect.Effect<void> =>
        event.type === "remark" || event.type === "partial"
          ? Effect.flatMap(Ref.get(recorded.from), (from) => from[event.track] !== undefined && event.start < from[event.track]! ? Effect.void : applyRecordedEvent(recorded, event))
          : applyRecordedEvent(recorded, event);

      // イベント列を終え、セッションの Scope を閉じる。状態を recorded にした後の終わらせ方は、成功・失敗・中断のどれでも必ずここを通す
      const closeRecorded = (recorded: Recorded) => Effect.andThen(Queue.end(recorded.events), closeSession(recorded.sink, recorded.scope));

      // 書き出して終える。helperFailure があれば、終わりの知らせに載せる。終わらせる後始末（closeRecorded）は呼び出し側が付ける
      const finishRecorded = (recorded: Recorded, failure: { code: number | null; signal: string | null; stderrTail: ReadonlyArray<string> } | undefined) =>
        Effect.gen(function* () {
          yield* recorded.sink.flush;
          const paths = yield* recorded.sink.exports;
          const ocrSummary = yield* recorded.sink.ocrSummary;
          yield* Queue.offer(recorded.events, { type: "finished", paths, ocrSummary, ...(failure === undefined ? {} : { failure }) });
          return { paths, ocrSummary };
        });

      // transcribe-file の argv。from があれば、トラックごとにその音声の時刻（秒）から読む（相手は --from、自分は --self-from。自分は --self-file があるときだけ）。audioDir は最初の起動だけ渡す
      // （起動し直しで渡すと、書き出し先が既にあって失敗し続ける。最初の起動が接続できた時点で書き出しは終わっている）
      const transcribeArgs = (recorded: Pick<Recorded, "file" | "selfFile">, from: Partial<Readonly<Record<Track, number>>>, audioDir: string | undefined): string[] => [
        "transcribe-file",
        "--file",
        recorded.file,
        ...(recorded.selfFile === undefined ? [] : ["--self-file", recorded.selfFile]),
        ...(from.相手 === undefined ? [] : ["--from", String(from.相手)]),
        ...(recorded.selfFile === undefined || from.自分 === undefined ? [] : ["--self-from", String(from.自分)]),
        ...(audioDir === undefined ? [] : ["--audio-dir", audioDir]),
      ];

      // 終わらせる。prepare（溜まりを入れ切る・捨てる）の後、止められていなければ（stop と取り合って先に取れたら）書き出して終える。
      // 入れている間、状態は recorded のまま（status・share が効き、別のセッションは始められない）。入れ切る前に stop が状態を取れば、溜まりが捨てられて早く戻る
      // prepare が失敗（defect を含む）しても、所有権を取って後始末（イベント列を終える・Scope を閉じる・idle に戻す）まで進める。
      // 終わらせる本体は、セッションの Scope が閉じても続くよう、サーバーの Scope の fiber で動かす
      const concludeRecorded = Effect.fnUntraced(function* (recorded: Recorded, prepare: Effect.Effect<void>, failure: { code: number | null; signal: string | null; stderrTail: ReadonlyArray<string> } | undefined) {
        const prepared = yield* Effect.exit(prepare);
        const claimed = yield* Ref.modify(state, (current): [boolean, State] =>
          current.kind === "recorded" && current.recorded === recorded ? [true, { kind: "stopping" }] : [false, current]);
        if (!claimed) return;
        const finishing = Exit.isFailure(prepared)
          ? Effect.andThen(note(`録画の取り込みの終了処理に失敗した: ${Cause.pretty(prepared.cause)}\n`), Effect.failCause(prepared.cause))
          : finishRecorded(recorded, failure === undefined ? undefined : { code: failure.code, signal: failure.signal, stderrTail: [...failure.stderrTail] });
        yield* Effect.forkIn(finishing.pipe(Effect.ensuring(closeRecorded(recorded))), serverScope);
      });

      const beginRecorded = Effect.fnUntraced(function* (input: RecordedStart): Effect.fn.Return<RecordedRun, SessionFailure> {
        const scope = yield* Scope.fork(serverScope, "sequential");
        return yield* Effect.gen(function* () {
          const prepared = input.noMap === true
            ? { noMap: true as const, warnings: yield* requireRecordedTranscriptDeps(helpers.checkNoScreen) }
            : yield* Effect.gen(function* () {
              const model = planModel(input.plan);
              const startupWarnings = yield* requireStartupDeps("recorded", model.route, { check: helpers.checkNoScreen }).pipe(Effect.provideService(ManagedDeps, deps));
              const { layer: updaterLayer, notice } = yield* sinks.prepare(input.plan).pipe(Scope.provide(scope), Effect.mapError(startupPreparationFailure));
              return { noMap: false as const, model, updaterLayer, warnings: notice === undefined ? startupWarnings : [...startupWarnings, notice] };
            });
          const { warnings } = prepared;
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
          const from = yield* Ref.make<Partial<Readonly<Record<Track, number>>>>({});
          const controller = yield* openIntake({
            scope, commands: { "reading-pause": "sticky" },
            argv: (attemptNo) => Effect.map(Ref.get(from), (position) => transcribeArgs({ file: input.file, selfFile: input.selfFile }, position, attemptNo === 1 ? dir : undefined)),
          }).pipe(Effect.provideService(Helpers, helpers));
          const events = yield* Queue.unbounded<RecordedEvent, Cause.Done>();
          const progress = yield* Ref.make<RecordedProgressState>({ position: 0, duration: null, rounds: 0 });
          const sink = yield* sinks.openRecorded({
            dir, title: input.title ?? parse(input.file).name, logShiftMs: DateTime.toEpochMillis(base) - DateTime.toEpochMillis(now),
            ...(prepared.noMap ? { noMap: true as const } : { model: prepared.model, updaterLayer: prepared.updaterLayer }), vocab: input.vocab, publish: viewers.publish, speak: viewers.speak, speakerNames: viewers.speakerNames, diffUpdate: viewers.diffUpdate,
            recorded: {
              realtime: input.realtime,
              excluded: (surfaces) => Effect.asVoid(Queue.offer(events, { type: "vocabulary-excluded", surfaces })),
              selfTrack: input.selfFile !== undefined,
              progress: ({ position, rounds }) =>
                Effect.andThen(
                  Ref.update(progress, (p) => ({ ...p, position: Math.max(p.position, position), rounds })),
                  publishProgress({ progress, events }),
                ),
              // 差分更新の一時停止に入る・理由か時刻が変わる・戻る。ヘルパーには停止か再開を（状態が変わったときだけ）送り、進み具合の行に理由と時刻を載せる
              paused: (pause) =>
                Effect.gen(function* () {
                  const changedState = yield* Ref.modify(progress, (p): [boolean, RecordedProgressState] => {
                    const { paused: before, ...rest } = p;
                    return [(before !== undefined) !== (pause !== undefined), pause === undefined ? rest : { ...rest, paused: pause }];
                  });
                  if (changedState) yield* controller.send({ type: "reading-pause", paused: pause !== undefined });
                  yield* publishProgress({ progress, events });
                }),
            },
          }).pipe(Scope.provide(scope));
          const recorded: Recorded = {
            local: prepared.noMap ? false : prepared.model.local,
            dir,
            file: input.file,
            selfFile: input.selfFile,
            sink,
            scope,
            controller,
            running: yield* Ref.make<IntakeRun | undefined>(undefined),
            events,
            progress,
            from,
            announced: yield* Ref.make({ audioTracks: false, screenOff: false, speakerOff: false }),
          };
          const running = yield* controller.run({
            trigger: "auto", exitZero: "finish", log: sink.appendLog,
            apply: (event) => applyRecordedEventFrom(recorded, event),
            observe: (transition) => Effect.gen(function* () {
              if (transition.kind === "crashed") yield* Ref.set(from, yield* sink.drainForRestart);
              if (transition.kind === "connected" && (yield* controller.stats).attempt > 1) yield* sink.speakersRenumbered;
            }),
          });
          yield* Ref.set(recorded.running, running);
          yield* Ref.set(state, { kind: "recorded", recorded });
          yield* Effect.forkIn(Effect.flatMap(running.end, (end) => {
            if (end.kind === "stopped") return Effect.void;
            return end.kind === "finished"
              ? concludeRecorded(recorded, Effect.andThen(sink.drain, sink.finishBacklog), undefined)
              : concludeRecorded(recorded, Effect.andThen(sink.discardBacklog, sink.finishBacklog), { ...end.last.exit, stderrTail: end.last.stderrTail });
          }), scope);
          yield* Scope.addFinalizer(scope, viewers.sessionMode({ type: "session-mode", local: false }));
          yield* viewers.sessionMode({ type: "session-mode", local: recorded.local });
          return { dir, warnings, events: Stream.fromQueue(events) };
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

      const startRecorded = Effect.fnUntraced(function* (input: RecordedStart): Effect.fn.Return<RecordedRun, SessionFailure> {
        yield* claimStart;
        return yield* beginRecorded(input).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(state, { kind: "idle", installations: 0 }) : Effect.void)),
        );
      });

      // 止めて書き出す。順番の要る停止（ヘルパーを止める → 読み終える → 書き出す）は本体に書き、
      // Scope の後始末（updater を閉じる等）は、途中で失敗・中断されたときの安全網にもなる
      const stopLive = (live: Live) =>
        Effect.gen(function* () {
          yield* live.meetingTabNotice.stop;
          yield* live.controller.stop;
          const running = yield* Ref.get(live.running);
          const end = running === undefined ? { kind: "stopped" as const, exit: undefined } : yield* running.end;
          yield* live.sink.drain;
          if (end.kind === "stopped" && end.exit?.signal === "SIGKILL") {
            yield* note(`ヘルパーが SIGTERM から ${stopTimeoutMs}ms 経っても終了しないので、SIGKILL で止めます\n`);
            if (live.audio) {
              // その時点で動いていた起動回の録音ファイル名を示す。起動し直していれば相手-2.m4a 等になる
              const names = audioFileNames((yield* live.controller.stats).attempt).join("・");
              yield* note(`録音の書き終わりを確認できないまま、セッションを閉じます。${live.dir} の ${names} が不完全なことがあります\n`);
            }
          }
          yield* live.sink.flush;
          return { paths: yield* live.sink.exports, ocrSummary: yield* live.sink.ocrSummary };
        }).pipe(Effect.ensuring(closeSession(live.sink, live.scope)));

      // 録画からのセッションの stop。溜まっている発言は入れず、入れている途中の 1 件だけ入れ終えて、そこまでの分で書き出す
      const stopRecorded = (recorded: Recorded) =>
        Effect.gen(function* () {
          // 溜まりを捨ててから止めの印を立てる（印で差分更新の待ちがほどけても、次の発言を取らせない）
          yield* recorded.sink.discardBacklog;
          yield* recorded.controller.stop;
          const running = yield* Ref.get(recorded.running);
          if (running !== undefined) yield* running.end;
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
          return { ...yield* Effect.interruptible(Fiber.join(running)), kind: target.kind };
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
        if (afterCheck.kind !== "live" || afterCheck.live !== live) return yield* new Aborted();
        // 取り込みの状態は、確かめてから書き換える（自動の起動し直しと取り合うので 1 つの操作にする）
        const taken = yield* Ref.modify(live.intake, (kind): [boolean, IntakeKind] => (kind === "stopped" ? [true, "interrupted"] : [false, kind]));
        if (!taken) return yield* new IntakeNotStopped();
        const previous = yield* Ref.get(live.running);
        if (previous !== undefined) yield* previous.end;
        // stop が前回の終了待ちを追い越した場合は、新しい run を開始しない。
        const beforeRun = yield* Ref.get(state);
        if (beforeRun.kind !== "live" || beforeRun.live !== live) return yield* new Aborted();
        const running = yield* runLive(live, "resume");
        yield* Ref.set(live.running, running);
        yield* intakeFrame("interrupted");
        const result = yield* running.reached;
        if (result.kind === "gaveUp") return yield* new RestartGaveUp({ stderrTail: result.stderrTail });
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
        if (current.kind === "recorded") return { status: "running", dir: current.recorded.dir, restarts: 0 };
        if (current.kind !== "live") return { status: "none" };
        const { live } = current;
        const lastInterruptedAt = yield* Ref.get(live.lastInterruptedAt);
        // 応答の Schema は値の無い欄を null にして書き出すので、途切れていなければ欄ごと付けない
        return {
          status: yield* Ref.get(live.intake),
          dir: live.dir,
          restarts: (yield* live.controller.stats).restarts,
          ...(lastInterruptedAt === undefined ? {} : { lastInterruptedAt }),
        };
      });

      const liveSession: Effect.Effect<{ readonly scope: Scope.Scope; readonly local: boolean }, SessionFailure> = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.kind === "live") return { scope: current.live.scope, local: current.live.model.local };
        if (current.kind === "recorded") return { scope: current.recorded.scope, local: current.recorded.local };
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
          yield* current.live.controller.send({ type: "self-pause", paused });
        });

      const setSpeakerName = (speaker: { label: string; name: string }): Effect.Effect<void, SessionFailure | SpeakerNameRejected> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.kind === "recorded") return yield* current.recorded.sink.nameSpeaker(speaker);
          if (current.kind !== "live") return yield* (current.kind === "idle" ? new NoSession() : new SessionTransition());
          yield* current.live.sink.nameSpeaker(speaker);
        });

      return Sessions.of({ apps: helpers.apps, start, startRecorded, stop, status, resume, checkResume, reserveDeps, liveSession, setSelfPause, setSpeakerName });
    }),
  );
}
