// セッションの中身（updater・ログ・いま話している文字・書き出し）を開く（ADR 0008）。
// core のセッションを直接使う。updater はセッションの Scope の資源で、Scope を閉じると閉じる。
import { Context, DateTime, Effect, FileSystem, Layer, Ref, Scope, Semaphore } from "effect";
import { dirname } from "node:path";
import type { UpdatePlan } from "./updatePlan.ts";
import { MapCapture } from "./capture.ts";
import { COMMON_WORDS_PATH, loadCommonWords } from "./commonWords.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { createSessionDir, openLoggedSession, writeExportsAndCapture } from "./sessionFiles.ts";
import { DiffUpdater, DiffUpdateReason, type DiffUpdateFrame, type HelperPartial, type IntakeLogEvent, type SelfPauseLogEvent, nameSpeaker, speakerNameMap, speakerNamesFrame, type SpeakerNameChange, type SpeakerNameTable, type SpeakerNamesFrame, type SettledRemark, type SpeakerLogEvent, type Snapshot, type CaptionsFrame, type Track } from "./core/index.ts";
import { startPoolSession, updatePoolFromSession } from "./vocabularyPool.ts";
import { AudioMix } from "./audioMix.ts";
import { Readings } from "./readings.ts";
import { makeSessionVocabulary, modelReadings } from "./sessionVocabulary.ts";
import { recordedFeed, type RecordedFeed } from "./recordedFeed.ts";
import { directFeed, makeRemarkFlow } from "./remarkFlow.ts";
import { ReviewBuild } from "./review.ts";
import { SpeakerNameRejected } from "./sessionFailure.ts";
import { errorMessage } from "./truthFile.ts";

// 開いたセッション 1 つ。ヘルパーに依らず、起動し直しをまたいで 1 つを使い続ける
export type SessionSink = {
  dir: string;
  // ヘルパーの途中結果。いま話している文字（speaking）と、1 秒更新されなかった発話の発言化（settling）へ渡す
  partial: (p: HelperPartial) => Effect.Effect<void>;
  // ヘルパーの確定結果。発言は、確定結果と 1 秒更新されなかった途中結果のどちらからも差分更新・ログ・speaking へ届く
  final: (r: SettledRemark) => Effect.Effect<void>;
  // 共有画面の変化（start は発言と同じ原点からの秒、image は JPEG のバイト列。ウィンドウが無くなったときは null）。
  // セッションの pushScreen へ渡す。log.jsonl の記録・screens/ への書き出し・Claude へのメッセージはセッションが行う。
  // lines はヘルパーが Vision で読んだ文字の行（無い旧ヘルパーと、画像が null のときは undefined）。screen の行に残し、規則で取った候補を語彙に入れる
  // （録画では語彙は受け取った時点で頼み、変化そのものは発言との時刻の順を保って入れる）
  screen: (change: { start: number; image: Uint8Array | null; lines?: ReadonlyArray<string> | undefined }) => Effect.Effect<void>;
  // 共有画面を見ていない印（start は発言と同じ原点からの秒。指定はサーバーが開始時に、許可なしはヘルパーが流す）。
  // セッションの pushScreenOff へ渡す。log.jsonl に 1 行書くだけで、差分更新・Claude へのメッセージには載らない
  screenOff: (off: { start: number; reason: "指定" | "許可なし" }) => Effect.Effect<void>;
  // 確定結果に覆われなかった最後の発話を発言にする
  drain: Effect.Effect<void>;
  // 起動し直すヘルパーの前の準備。drain と同じく残りの発言を作るが、2 本の録画の並べ替えで保留中の発言は吐き出さず（トラックごとに読み直した発言が end の順に並ぶよう保つ）、
  // 全トラックの end の最大値以降の先読みの共有画面は溜まりへ入れず捨てる
  // （起動し直したヘルパーがその位置から映像を読み直して流し直すので、入れると重複し、続きの発言より未来の画面が先に入る）
  drainForRestart: Effect.Effect<void>;
  // トラックごとの、いままでに作った（settling が締めた）発言の end の最大値。まだ作っていないトラックのキーは無い。
  // 溜まりでセッションに入れていない発言も、2 本の録画の並べ替えで保留中の発言も数える（起動し直すヘルパーが、トラックごとに読み始める位置になる）
  lastRemarkEnds: Effect.Effect<Partial<Readonly<Record<Track, number>>>>;
  // 利用者が足した語（cli start --vocab）を語彙に入れる。開始のときにだけ呼ぶ。
  // 読みは返った後に非同期で作る（開始を待たせない）。読みができた後に締めた発言から、その語で直る（すでに締めた発言は直し直さない。録画の等速でも、入れる時刻を待つ間に届いた語では直さない）。
  // 英字の語（略語でないもの）はモデルにカタカナの読みを聞いてから読みを作る。
  // 読みが作れなかった語・読みの取得（モデルを含む）に失敗した語は補正に使わない（セッションは止めない）。足した語は読みの有無によらず vocab の行に残す
  addUserVocabulary: (words: ReadonlyArray<string>) => Effect.Effect<void>;
  // いま話している文字を空にする（以後も送れる。取り込みの途切れの瞬間に使う）
  clearSpeaking: Effect.Effect<void>;
  // 予約を取り消し、いま話している文字を空にして、以後は何も送らない
  stopRelays: Effect.Effect<void>;
  // ヘルパーの話者の区間と使えないこと。受け取った値のまま、届いた順に log.jsonl へ残してから、相手の発言の話者を決める段へ渡す（確定した区間が揃った保留を出す）。
  // 差分更新・字幕には載らない。speaker-off の後の相手の発言は、待たずに話者なしで出る。話者の記録の経路はここだけ
  speaker: (event: SpeakerLogEvent) => Effect.Effect<void>;
  // ヘルパーを起動し直して接続できた（Sortformer の枠が振り直された）。新しいヘルパーのイベントを読み始める前に呼ぶ（Issue #1025）。
  // 前の世代の保留を話者の判定を済ませて出し切り、以後の新しい枠は、重心をラベルに照らし合わせるまで話者なしで出す。ログには書かない
  speakersRenumbered: Effect.Effect<void>;
  // 話者のラベル（相手 B）に名前を手で付ける（Issue #1026）。付けられるのは発言に振ったラベルだけで、自分・まだ振っていないラベル・ラベルの無い「相手」・空の名前は SpeakerNameRejected。
  // 表が変わるときだけ、log.jsonl に speaker-name の行を残し、名前の表のフレームを送る。以後の差分更新の入力に載る。名前は外れない。
  // 表はこの sink（セッションにつき 1 つ）が持つので、ヘルパーの起動し直し・resume をまたいで残り、新しいセッションには持ち越さない
  nameSpeaker: (speaker: { label: string; name: string }) => Effect.Effect<void, SpeakerNameRejected>;
  // log.jsonl へ、取り込みの途切れ・自分の休止等の記録を追記する（話者の記録は speaker が行う）
  appendLog: (event: Exclude<IntakeLogEvent, SpeakerLogEvent> | SelfPauseLogEvent) => Effect.Effect<void>;
  // 録画からのセッションで、溜まっている発言をすべて入れ終えるまで待つ（ライブでは何もしない）。drain の後に呼ぶ
  finishBacklog: Effect.Effect<void>;
  // 録画からのセッションで、溜まっている発言を捨てる。入れている途中の 1 件は待たない（入れ終えるのは finishBacklog が待つ。ライブでは何もしない）
  discardBacklog: Effect.Effect<void>;
  // 差分更新の結果を待つ
  flush: Effect.Effect<void>;
  // map.md・map.json・map.drawnix（と撮影できれば map.png、書き出せれば map.html）を書き出し、パスを返す
  exports: Effect.Effect<string[]>;
  // 起動回 attempt（1 始まり）のヘルパーが書く録音ファイルの名前
  audioFileNames: (attempt: number) => string[];
};

export type SessionSinksDeps<R = never> = {
  // 計画から差分更新の layer を作る。notice は routed で判定の鍵が無く、判定なしで始めるときの知らせ
  prepareUpdater: (plan: UpdatePlan) => Effect.Effect<{ readonly layer: Layer.Layer<DiffUpdater, UpdaterUnavailable>; readonly notice?: string }, UpdaterUnavailable, R | Scope.Scope>;
};

export type OpenSessionSink = {
  model: ExecutableModel;
  updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable>;
  dir: string; // createDir で作ったセッションのフォルダ
  title: string | undefined; // 省略したときは、セッションのフォルダ名（開始時刻）
  logShiftMs?: number; // log.jsonl の時刻に足す幅（録画からのセッションが作成日時へそろえる）。省略は 0
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  speak: (frame: CaptionsFrame) => Effect.Effect<void>;
  // 話者の名前の表（全体）を送る。開いた直後に空の表を 1 回送り、前のセッションの名前を消す
  speakerNames: (frame: SpeakerNamesFrame) => Effect.Effect<void>;
  diffUpdate: (frame: DiffUpdateFrame) => Effect.Effect<void>;
  // 録画からのセッションのとき（cli recorded）だけ渡す。締めた発言はすぐ入れず溜め、1 発言入れて差分更新が終わるたびに progress を呼ぶ。
  // いま話している文字（字幕）はヘルパーの途中結果ではなく、入れた位置で出す
  // realtime なら、音声の時刻（発言は end、共有画面の変化は start）まで待ってから入れる。差分更新の終わりは待たない（play --realtime と同じ意味）
  // selfTrack は 2 本の録画（cli recorded --self）。相手と自分の発言を、トラックをまたいで音声の時刻（end）の順にして溜める（ヘルパーの保留や話者を決める段の保留で、届く順が時刻の順と前後するため）
  // paused は、差分更新の一時停止に入ったとき・理由か次に試す時刻が変わったとき・戻ったとき（undefined）に呼ぶ。
  // 一時停止の間は、溜まりから発言を入れない（戻るまで待つ。いくらでも待ち、自動では諦めない）。ヘルパーに読み取りを止めさせるのは呼び出し側
  recorded?: {
    realtime: boolean;
    selfTrack?: boolean;
    progress: (progress: { position: number; rounds: number }) => Effect.Effect<void>;
    paused: (pause: { reason: DiffUpdatePauseReason; retryAt: number } | undefined) => Effect.Effect<void>;
  };
};

type DiffUpdatePauseReason = typeof DiffUpdateReason["Type"];

const TRACKS: Track[] = ["相手", "自分"];

// ヘルパー（--audio-index として渡される起動回）が書く録音ファイルの名前。
// helper/Sources/HelperCore/Recording.swift の recordingFileName と同じ規則（1 回目は番号を付けない）。
// 採番規則の所有者をここに 1 つ置き、警告文もここから組み立てる（固定文字列をファイル名として埋め込まない）
const audioFileNames = (attempt: number): string[] => TRACKS.map((track) => (attempt > 1 ? `${track}-${attempt}.m4a` : `${track}.m4a`));

export class SessionSinks extends Context.Service<SessionSinks, {
  prepare: SessionSinksDeps["prepareUpdater"];
  // セッションのフォルダを作る。ヘルパーが録音を書き出す先として、起動の前に確定させる。失敗したら以後 open を呼ばない
  // at は録画からのセッションが渡す基準の時刻（ファイルの作成日時）。省略すると今の時刻
  createDir: (sessionsDir: string, at?: DateTime.DateTime) => Effect.Effect<string>;
  // セッションの Scope の中で 1 回開く。Scope を閉じると updater が閉じ、予約が止まる
  open: (args: OpenSessionSink) => Effect.Effect<SessionSink, never, Scope.Scope>;
}>()("live-mindmap/server/SessionSinks") {
  // 終了時の書き出しが使う撮影・見返し用の HTML のビルド・mix・FileSystem 、足した語の読みを作る Readings、ふつうの語の一覧は、Layer を作るときに文脈から 1 回だけ受け取る
  static readonly layer = <R>({ prepareUpdater }: SessionSinksDeps<R>): Layer.Layer<SessionSinks, never, R | MapCapture | ReviewBuild | AudioMix | Readings | FileSystem.FileSystem> =>
    Layer.effect(SessionSinks)(
      Effect.gen(function* () {
        const preparationServices = yield* Effect.context<R>();
        const exportServices = Context.pick(MapCapture, ReviewBuild, AudioMix, FileSystem.FileSystem)(
          yield* Effect.context<MapCapture | ReviewBuild | AudioMix | FileSystem.FileSystem>(),
        );
        const readings = yield* Readings;
        // ふつうの語の一覧は、Layer を作るときに 1 回だけ読む（同梱のファイルなので、読めないのは予期しない失敗）
        const commonWords = yield* loadCommonWords(COMMON_WORDS_PATH).pipe(Effect.provideContext(exportServices), Effect.orDie);
        return SessionSinks.of({
        prepare: (plan) => Effect.gen(function* () {
          const scope = yield* Effect.scope;
          return yield* prepareUpdater(plan).pipe(Effect.provideContext(Context.add(preparationServices, Scope.Scope, scope)));
        }),
        createDir: (sessionsDir, at) => createSessionDir(sessionsDir, at).pipe(Effect.provideContext(exportServices), Effect.orDie),
        open: Effect.fnUntraced(function* ({ dir, title, logShiftMs, publish, speak, speakerNames, diffUpdate, model, updaterLayer, recorded }) {
          // updater を開く。Layer はメモ化されるので、Layer.fresh でセッションごとに別の実体にする（query を使い回さない）。
          // 最後の消費者は session.flush の差分更新で、Scope の後始末はそれより後に走る。開けなければ defect
          const updaterContext = yield* Layer.build(Layer.fresh(updaterLayer)).pipe(Effect.orDie);
          // 話者の名前の表（ラベル → 名前）。セッションにつき 1 つで、ヘルパーの起動し直しでは作り直さない（Issue #1026）。
          // 開いた直後に空の表を送り、前のセッションの名前を画面から消す
          const names = yield* Ref.make<SpeakerNameTable>(new Map());
          const namesLock = yield* Semaphore.make(1);
          yield* speakerNames(speakerNamesFrame(new Map()));
          // 差分更新を呼ぶたびに、そのときの名前の表を入力に載せる（名前が無いときはキーごと付けない）。katakana などは保つ
          const baseUpdater = Context.get(updaterContext, DiffUpdater);
          const namedUpdater = DiffUpdater.of({
            ...baseUpdater,
            update: (input) => Effect.flatMap(Ref.get(names), (table) =>
              baseUpdater.update(table.size === 0 ? input : { ...input, speakerNames: speakerNameMap(table) })),
          });
          // 名前を付ける 1 つの口（手入力も AI の推定も通る）。規則は nameSpeaker にある。
          // Why: 要求が途中で中断されると、表・ログの行・フレームの一部だけが更新され、同じ名前の再送では直らない（同じ値は何もしない）ため、ロック取得後は中断させない
          const applyName = (change: SpeakerNameChange): Effect.Effect<void> =>
            namesLock.withPermit(Effect.uninterruptible(Effect.gen(function* () {
              const next = nameSpeaker(yield* Ref.get(names), change);
              if (next === undefined) return;
              yield* appendRecordedLog({ type: "speaker-name", label: change.label, name: next.get(change.label)!.name, source: change.source });
              yield* Ref.set(names, next);
              yield* speakerNames(speakerNamesFrame(next));
            })));
          // openLoggedSession は初期 frame も送るため、feed の構築後だけ observe へ接続する。
          let observe: RecordedFeed["observe"] | undefined;
          // ログを書くセッションは、反映が終わるたびに onDiff を知らせる。未反映の発言が変わるので、いま話している文字を送り直す
          const { session, appendLog: appendRecordedLog } = yield* openLoggedSession({
            dir,
            title,
            logShiftMs,
            model,
            publish,
            diffUpdate: (frame) => Effect.andThen(diffUpdate(frame), Effect.suspend(() => observe === undefined ? Effect.void : observe(frame))),
            onDiff: Effect.suspend((): Effect.Effect<void> => flow.captionsChanged),
            // 根拠の確かめは core が済ませている。1 件ずつ順に、規則（付け替えは名乗りのときだけ）を通して入れる
            onSpeakerNames: (inferred) => Effect.forEach(inferred, ({ label, name, basis }) => applyName({ label, name, source: "推定", basis }), { discard: true }),
          }).pipe(Effect.provideService(DiffUpdater, namedUpdater), Effect.provideContext(exportServices));
          // ログを開いた後に作り、Scope 閉鎖ではログを閉じる前に読み待ちを中断する。
          const started = yield* startPoolSession(dirname(dir)).pipe(Effect.provideContext(exportServices));
          if (started !== undefined) yield* appendRecordedLog({ type: "vocab-pool", session: started.session });
          const vocabulary = yield* makeSessionVocabulary({
            read: modelReadings(baseUpdater.katakana, readings),
            commonWords,
            log: appendRecordedLog,
            carried: started?.words ?? [],
          });
          const flow = yield* makeRemarkFlow({
            session, correct: vocabulary.correct, speak,
            captions: recorded === undefined ? "途中結果から" : "入れた発言だけ",
            feed: (inlet) => Effect.gen(function* () {
              if (recorded === undefined) return {
                ...yield* directFeed(inlet),
                finish: Effect.void, discard: Effect.void,
                prepareRestart: Effect.succeed({}), lastRemarkEnds: Effect.succeed({}),
              };
              const feed = yield* recordedFeed({
                realtime: recorded.realtime,
                selfTrack: recorded.selfTrack === true,
                session: {
                  diffUpdate: session.diffUpdate,
                  nextRetryAt: session.nextRetryAt,
                  unreflectedCount: Effect.map(session.unreflectedRemarks, (remarks) => remarks.length),
                  idle: session.idle,
                  round: Effect.map(session.snapshot, (snapshot) => snapshot.round),
                },
                progress: recorded.progress,
                paused: recorded.paused,
              })(inlet);
              observe = feed.observe;
              return feed;
            }),
          });
          return {
            dir,
            partial: flow.partial,
            final: flow.final,
            speaker: (event) => Effect.andThen(appendRecordedLog(event), flow.speaker(event)),
            speakersRenumbered: flow.renumbered,
            nameSpeaker: ({ label, name }) =>
              Effect.gen(function* () {
                if (!flow.labels().includes(label)) return yield* new SpeakerNameRejected({ reason: "ラベルがない" });
                if (name.trim() === "") return yield* new SpeakerNameRejected({ reason: "名前が空" });
                yield* applyName({ label, name, source: "手入力" });
              }),
            screen: (change) => recorded === undefined
              ? Effect.andThen(flow.screen(change), vocabulary.addScreen(change.lines))
              : Effect.andThen(vocabulary.addScreen(change.lines, change.start), flow.screen(change)),
            screenOff: flow.screenOff,
            addUserVocabulary: vocabulary.addUser,
            drain: flow.drain,
            drainForRestart: Effect.andThen(flow.drainForRestart, Effect.asVoid(flow.feed.prepareRestart)),
            lastRemarkEnds: flow.feed.lastRemarkEnds,
            finishBacklog: flow.feed.finish,
            discardBacklog: flow.feed.discard,
            clearSpeaking: flow.clearSpeaking,
            stopRelays: flow.stop,
            appendLog: appendRecordedLog,
            flush: session.flush,
            // テキストの 3 形式を書けないのは予期しない失敗なので defect にする（撮影・HTML の失敗は writeExportsAndCapture の中で警告にする）
            // 先に溜まりを更新する（ログから導くので、log.jsonl・export.json は書き換えない）。
            // 読み取得中の語彙追加は vocab の行を書き終えてから溜まりに入れる（待たないと、足した語・画面の語が溜まりに入らない）
            exports: Effect.andThen(
              Effect.andThen(vocabulary.settled, updatePoolFromSession(dir, dirname(dir))),
              Effect.flatMap(Effect.all([session.snapshot, Ref.get(names)]), ([snapshot, table]) => writeExportsAndCapture(dir, snapshot, errorMessage, speakerNameMap(table))),
            ).pipe(
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
