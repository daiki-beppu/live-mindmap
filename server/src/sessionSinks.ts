// セッションの中身（updater・ログ・いま話している文字・書き出し）を開く（ADR 0008）。
// core のセッションを直接使う。updater はセッションの Scope の資源で、Scope を閉じると閉じる。
import { Context, Effect, FileSystem, Layer, Ref, Scope } from "effect";
import { MapCapture } from "./capture.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { createSessionDir, openRecordedSession, writeExportsAndCapture } from "./sessionFiles.ts";
import { DiffUpdater, type HelperPartial, type IntakeLogEvent, type Remark, type SettledRemark, type Snapshot, type SpeakingFrame, type Track } from "./core/index.ts";
import { AudioMix } from "./audioMix.ts";
import { createRemarkSettling } from "./remarkSettling.ts";
import { ReviewBuild } from "./review.ts";
import { createSpeakingRelay } from "./speakingRelay.ts";
import { errorMessage } from "./truthFile.ts";

// 開いたセッション 1 つ。ヘルパーに依らず、起動し直しをまたいで 1 つを使い続ける
export type SessionSink = {
  dir: string;
  // ヘルパーの途中結果。いま話している文字（speaking）と、1 秒更新されなかった発話の発言化（settling）へ渡す
  partial: (p: HelperPartial) => Effect.Effect<void>;
  // ヘルパーの確定結果。発言は、確定結果と 1 秒更新されなかった途中結果のどちらからも差分更新・ログ・speaking へ届く
  final: (r: SettledRemark) => Effect.Effect<void>;
  // 共有画面の変化（start は発言と同じ原点からの秒、image は JPEG のバイト列。ウィンドウが無くなったときは null）。
  // セッションの pushScreen へ渡す。log.jsonl の記録・screens/ への書き出し・Claude へのメッセージはセッションが行う
  screen: (change: { start: number; image: Uint8Array | null }) => Effect.Effect<void>;
  // 共有画面を見ていない印（start は発言と同じ原点からの秒。指定はサーバーが開始時に、許可なしはヘルパーが流す）。
  // セッションの pushScreenOff へ渡す。log.jsonl に 1 行書くだけで、差分更新・Claude へのメッセージには載らない
  screenOff: (off: { start: number; reason: "指定" | "許可なし" }) => Effect.Effect<void>;
  // 確定結果に覆われなかった最後の発話を発言にする
  drain: Effect.Effect<void>;
  // いま話している文字を空にする（以後も送れる。取り込みの途切れの瞬間に使う）
  clearSpeaking: Effect.Effect<void>;
  // 予約を取り消し、いま話している文字を空にして、以後は何も送らない
  stopRelays: Effect.Effect<void>;
  // log.jsonl へ、取り込みの途切れ等の記録を追記する
  appendLog: (event: IntakeLogEvent) => Effect.Effect<void>;
  // 差分更新の結果を待つ
  flush: Effect.Effect<void>;
  // map.md・map.json・map.drawnix（と撮影できれば map.png、書き出せれば map.html）を書き出し、パスを返す
  exports: Effect.Effect<string[]>;
  // 起動回 attempt（1 始まり）のヘルパーが書く録音ファイルの名前
  audioFileNames: (attempt: number) => string[];
};

export type SessionSinksDeps<R = never> = {
  prepareUpdater: (model: ExecutableModel) => Effect.Effect<Layer.Layer<DiffUpdater, UpdaterUnavailable>, UpdaterUnavailable, R | Scope.Scope>;
};

export type OpenSessionSink = {
  model: ExecutableModel;
  updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable>;
  dir: string; // createDir で作ったセッションのフォルダ
  title: string | undefined; // 省略したときは、セッションのフォルダ名（開始時刻）
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  speak: (frame: SpeakingFrame) => Effect.Effect<void>;
};

const TRACKS: Track[] = ["相手", "自分"];

// ヘルパー（--audio-index として渡される起動回）が書く録音ファイルの名前。
// helper/Sources/HelperCore/Recording.swift の recordingFileName と同じ規則（1 回目は番号を付けない）。
// 採番規則の所有者をここに 1 つ置き、警告文もここから組み立てる（固定文字列をファイル名として埋め込まない）
const audioFileNames = (attempt: number): string[] => TRACKS.map((track) => (attempt > 1 ? `${track}-${attempt}.m4a` : `${track}.m4a`));

export class SessionSinks extends Context.Service<SessionSinks, {
  prepare: SessionSinksDeps["prepareUpdater"];
  // セッションのフォルダを作る。ヘルパーが録音を書き出す先として、起動の前に確定させる。失敗したら以後 open を呼ばない
  createDir: (sessionsDir: string) => Effect.Effect<string>;
  // セッションの Scope の中で 1 回開く。Scope を閉じると updater が閉じ、予約が止まる
  open: (args: OpenSessionSink) => Effect.Effect<SessionSink, never, Scope.Scope>;
}>()("live-mindmap/server/SessionSinks") {
  // 終了時の書き出しが使う撮影・見返し用の HTML のビルド・mix・FileSystem は、Layer を作るときに文脈から 1 回だけ受け取る
  static readonly layer = <R>({ prepareUpdater }: SessionSinksDeps<R>): Layer.Layer<SessionSinks, never, R | MapCapture | ReviewBuild | AudioMix | FileSystem.FileSystem> =>
    Layer.effect(SessionSinks)(
      Effect.gen(function* () {
        const preparationServices = yield* Effect.context<R>();
        const exportServices = Context.pick(MapCapture, ReviewBuild, AudioMix, FileSystem.FileSystem)(
          yield* Effect.context<MapCapture | ReviewBuild | AudioMix | FileSystem.FileSystem>(),
        );
        return SessionSinks.of({
        prepare: (model) => Effect.gen(function* () {
          const scope = yield* Effect.scope;
          return yield* prepareUpdater(model).pipe(Effect.provideContext(Context.add(preparationServices, Scope.Scope, scope)));
        }),
        createDir: (sessionsDir) => createSessionDir(sessionsDir).pipe(Effect.provideContext(exportServices), Effect.orDie),
        open: Effect.fnUntraced(function* ({ dir, title, publish, speak, model, updaterLayer }) {
          // updater を開く。Layer はメモ化されるので、Layer.fresh でセッションごとに別の実体にする（query を使い回さない）。
          // 最後の消費者は session.flush の差分更新で、Scope の後始末はそれより後に走る。開けなければ defect
          const updaterContext = yield* Layer.build(Layer.fresh(updaterLayer)).pipe(Effect.orDie);
          // relay を先に作る。unreflected は session ができた後（onDiff が走るとき）にだけ評価されるので、Effect.suspend で遅らせる
          // （onDiff は diff の反映後にしか呼ばれず、openRecordedSession が返る前には呼ばれない）
          const relay = yield* createSpeakingRelay({ unreflected: Effect.suspend((): Effect.Effect<Remark[]> => session.unreflectedRemarks), send: speak });
          // 記録つきセッションは、反映が終わるたびに onDiff を知らせる。未反映の発言が変わるので、いま話している文字を送り直す
          const { session, appendLog } = yield* openRecordedSession({
            dir,
            title,
            model,
            publish,
            onDiff: relay.flushAll,
          }).pipe(Effect.provideService(DiffUpdater, Context.get(updaterContext, DiffUpdater)), Effect.provideContext(exportServices));
          // ID の採番はセッションにつき 1 回だけ作る。起動し直しでは作り直さない
          const count = yield* Ref.make(0);
          const settling = yield* createRemarkSettling({
            emit: (settled) =>
              Effect.gen(function* () {
                const n = yield* Ref.updateAndGet(count, (c) => c + 1);
                yield* session.push({ ...settled, id: `r${n}` });
                yield* relay.remark(settled.track);
              }),
          });
          // 画像の ID も、セッションにつき 1 回だけ作るクロージャで採番する
          const screenCount = yield* Ref.make(0);
          // 登録の逆順に走る: 予約を止めてから updater を閉じる
          yield* Effect.addFinalizer(() => Effect.andThen(relay.stop, settling.stop));

          return {
            dir,
            partial: (p) => Effect.andThen(relay.partial(p.track, p.text, p.duplicate), settling.partial(p)),
            final: (r) => settling.final(r),
            screen: ({ start, image }) =>
              Effect.gen(function* () {
                if (image === null) return yield* session.pushScreen({ start, image: null });
                const n = yield* Ref.updateAndGet(screenCount, (c) => c + 1);
                return yield* session.pushScreen({ start, image: { id: `s${n}`, bytes: image } });
              }),
            screenOff: (off) => session.pushScreenOff(off),
            drain: settling.drain,
            clearSpeaking: relay.clear,
            stopRelays: Effect.andThen(relay.stop, settling.stop),
            appendLog,
            flush: session.flush,
            // テキストの 3 形式を書けないのは予期しない失敗なので defect にする（撮影・HTML の失敗は writeExportsAndCapture の中で警告にする）
            exports: Effect.flatMap(session.snapshot, (snapshot) => writeExportsAndCapture(dir, snapshot, errorMessage)).pipe(
              Effect.provideContext(exportServices),
              Effect.orDie,
            ),
            audioFileNames,
          } satisfies SessionSink;
        }),
        });
      }),
    );
}
