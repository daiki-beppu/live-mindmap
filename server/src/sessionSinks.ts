// セッションの中身（updater・ログ・いま話している文字・書き出し）を開く（ADR 0008）。
// core のセッションを直接使う。updater はセッションの Scope の資源で、Scope を閉じると閉じる。
import { Context, DateTime, Effect, FiberSet, FileSystem, Layer, Ref, Scope } from "effect";
import { dirname } from "node:path";
import type { JudgeModel } from "./judgeSelection.ts";
import { MapCapture } from "./capture.ts";
import { COMMON_WORDS_PATH, loadCommonWords } from "./commonWords.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { createSessionDir, openRecordedSession, writeExportsAndCapture } from "./sessionFiles.ts";
import { correctRemark, DiffUpdater, requestScreenWords, wordsForKatakana, katakanaTable, type DiffUpdateFrame, type HelperPartial, type ScreenVocabularyState, type IntakeLogEvent, type Remark, type SelfPauseLogEvent, type SettledRemark, type Snapshot, type SpeakingFrame, type Track, type VocabularyWord } from "./core/index.ts";
import { startPoolSession, updatePoolFromSession } from "./vocabularyPool.ts";
import { AudioMix } from "./audioMix.ts";
import { Readings } from "./readings.ts";
import { createRecordedBacklog } from "./recordedBacklog.ts";
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
  // セッションの pushScreen へ渡す。log.jsonl の記録・screens/ への書き出し・Claude へのメッセージはセッションが行う。
  // lines はヘルパーが Vision で読んだ文字の行（無い旧ヘルパーと、画像が null のときは undefined）。screen の行に残し、規則で取った候補を語彙に入れる
  screen: (change: { start: number; image: Uint8Array | null; lines?: ReadonlyArray<string> | undefined }) => Effect.Effect<void>;
  // 共有画面を見ていない印（start は発言と同じ原点からの秒。指定はサーバーが開始時に、許可なしはヘルパーが流す）。
  // セッションの pushScreenOff へ渡す。log.jsonl に 1 行書くだけで、差分更新・Claude へのメッセージには載らない
  screenOff: (off: { start: number; reason: "指定" | "許可なし" }) => Effect.Effect<void>;
  // 確定結果に覆われなかった最後の発話を発言にする
  drain: Effect.Effect<void>;
  // 利用者が足した語（cli start --vocab）を語彙に入れる。開始のときにだけ呼ぶ。
  // 読みは返った後に非同期で作る（開始を待たせない）。読みができた後に締めた発言から、その語で直る（すでに出した発言は直し直さない）。
  // 英字の語（略語でないもの）はモデルにカタカナの読みを聞いてから読みを作る。
  // 読みが作れなかった語・読みの取得（モデルを含む）に失敗した語は補正に使わない（セッションは止めない）。足した語は読みの有無によらず vocab の行に残す
  addUserVocabulary: (words: ReadonlyArray<string>) => Effect.Effect<void>;
  // いま話している文字を空にする（以後も送れる。取り込みの途切れの瞬間に使う）
  clearSpeaking: Effect.Effect<void>;
  // 予約を取り消し、いま話している文字を空にして、以後は何も送らない
  stopRelays: Effect.Effect<void>;
  // log.jsonl へ、取り込みの途切れ・自分の休止等の記録を追記する
  appendLog: (event: IntakeLogEvent | SelfPauseLogEvent) => Effect.Effect<void>;
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
  prepareUpdater: (model: ExecutableModel, judge?: JudgeModel) => Effect.Effect<Layer.Layer<DiffUpdater, UpdaterUnavailable>, UpdaterUnavailable, R | Scope.Scope>;
};

export type OpenSessionSink = {
  model: ExecutableModel;
  updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable>;
  dir: string; // createDir で作ったセッションのフォルダ
  title: string | undefined; // 省略したときは、セッションのフォルダ名（開始時刻）
  logShiftMs?: number; // log.jsonl の時刻に足す幅（録画からのセッションが作成日時へそろえる）。省略は 0
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  speak: (frame: SpeakingFrame) => Effect.Effect<void>;
  diffUpdate: (frame: DiffUpdateFrame) => Effect.Effect<void>;
  // 録画からのセッションのとき（cli recorded）だけ渡す。締めた発言はすぐ入れず溜め、1 発言入れて差分更新が終わるたびに progress を呼ぶ。
  // いま話している文字（字幕）はヘルパーの途中結果ではなく、入れた位置で出す
  recorded?: { progress: (progress: { position: number; rounds: number }) => Effect.Effect<void> };
};

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
        prepare: (model, judge) => Effect.gen(function* () {
          const scope = yield* Effect.scope;
          return yield* prepareUpdater(model, judge).pipe(Effect.provideContext(Context.add(preparationServices, Scope.Scope, scope)));
        }),
        createDir: (sessionsDir, at) => createSessionDir(sessionsDir, at).pipe(Effect.provideContext(exportServices), Effect.orDie),
        open: Effect.fnUntraced(function* ({ dir, title, logShiftMs, publish, speak, diffUpdate, model, updaterLayer, recorded }) {
          // updater を開く。Layer はメモ化されるので、Layer.fresh でセッションごとに別の実体にする（query を使い回さない）。
          // 最後の消費者は session.flush の差分更新で、Scope の後始末はそれより後に走る。開けなければ defect
          const updaterContext = yield* Layer.build(Layer.fresh(updaterLayer)).pipe(Effect.orDie);
          // relay を先に作る。unreflected は session ができた後（onDiff が走るとき）にだけ評価されるので、Effect.suspend で遅らせる
          // （onDiff は diff の反映後にしか呼ばれず、openRecordedSession が返る前には呼ばれない）
          const relay = yield* createSpeakingRelay({ unreflected: Effect.suspend((): Effect.Effect<Remark[]> => session.unreflectedRemarks), send: speak });
          // 記録つきセッションは、反映が終わるたびに onDiff を知らせる。未反映の発言が変わるので、いま話している文字を送り直す
          const { session, appendLog: appendRecordedLog } = yield* openRecordedSession({
            dir,
            title,
            logShiftMs,
            model,
            publish,
            diffUpdate,
            onDiff: relay.flushAll,
          }).pipe(Effect.provideService(DiffUpdater, Context.get(updaterContext, DiffUpdater)), Effect.provideContext(exportServices));
          // 語彙追加（読み取得つき）の処理の集まり。ログを開いた後に作るので、後始末（登録の逆順）ではログを閉じる前に中断される。
          // exports が溜まりを更新する前に、書き終わるのを待つために使う
          const vocabularyAdds = yield* FiberSet.make();
          // ID の採番はセッションにつき 1 回だけ作る。起動し直しでは作り直さない
          const count = yield* Ref.make(0);
          // 語彙（読みのある語だけ）。セッションの中では減らさない。出口は発言を締めるたびにその時点の語彙を読む
          const vocabulary = yield* Ref.make<ReadonlyArray<VocabularyWord>>([]);
          // 締めた発言を、語彙で直してセッションへ入れる（ログの remark の行・差分更新・字幕）
          const admit = (settled: SettledRemark) =>
              Effect.gen(function* () {
                const n = yield* Ref.updateAndGet(count, (c) => c + 1);
                // words は Remark に入れず、ログの行にだけ残す。関所を通った後の本文を語彙で直し、直した本文を発言の本文にする
                // （ログの raw には直す前の本文、words には直す前の位置のままを残す）。words が無い発言は直さない
                // wordTimes（Issue #1019）も Remark に入れず、ログの行にだけ残す（本文の位置は直す前のまま）
                const { words, wordTimes, ...rest } = settled;
                const text = words === undefined ? rest.text : correctRemark(yield* Ref.get(vocabulary), rest.text, words, commonWords).text;
                yield* session.push({ ...rest, text, id: `r${n}` }, words === undefined ? undefined : { raw: rest.text, words }, wordTimes);
                yield* relay.remark(settled.track);
              });
          // 録画からのセッションは、入れたあと差分更新の終わりを待ってから次の発言を入れる
          const backlog = recorded === undefined
            ? undefined
            : yield* createRecordedBacklog({
                deliver: (settled: SettledRemark) =>
                  Effect.gen(function* () {
                    yield* admit(settled);
                    yield* session.idle;
                    yield* recorded.progress({ position: settled.end, rounds: (yield* session.snapshot).round });
                  }),
              });
          const settling = yield* createRemarkSettling({ emit: backlog === undefined ? admit : backlog.offer });
          // 画面から語彙の候補を取るための状態。短い行が出た画面の数と、読みを頼んだ語（利用者の語・画面の語）。
          // 並んで届いた画面で同じ語を二重に頼まないよう、1 回の Ref.modify で更新する
          const screenVocabulary = yield* Ref.make<ScreenVocabularyState>({ seen: new Map(), requested: new Set() });
          // 画像の ID も、セッションにつき 1 回だけ作るクロージャで採番する
          const screenCount = yield* Ref.make(0);

          // 開始時に、全セッションをまたぐ溜まり（セッションの置き場の直下）の語を読みごと語彙に入れる（Issue #645）。読みは作り直さない。
          // 番号の行（終了時と cli restore がこのセッションの番号を知る）→ carried の vocab の行の順に書き、open が返る前に語彙へ足す
          // （最初の発言から効く。直した発言の行は必ず vocab の行より後ろに並ぶ）。溜まりが使えないときは警告だけ出して何もしない
          const started = yield* startPoolSession(dirname(dir)).pipe(Effect.provideContext(exportServices));
          if (started !== undefined) {
            yield* appendRecordedLog({ type: "vocab-pool", session: started.session });
            if (started.words.length > 0) {
              const carried = started.words.map((w) => ({ surface: w.surface, romaji: w.romaji, source: "carried" as const }));
              yield* appendRecordedLog({ type: "vocab", words: carried });
              yield* Ref.set(vocabulary, started.words.flatMap((w) => (w.romaji === null ? [] : [{ surface: w.surface, romaji: w.romaji }])));
              yield* Ref.update(screenVocabulary, (state) => ({ ...state, requested: new Set([...state.requested, ...started.words.map((w) => w.surface)]) }));
            }
          }
          // 登録の逆順に走る: 予約を止めてから updater を閉じる
          yield* Effect.addFinalizer(() => Effect.andThen(relay.stop, settling.stop));

          // 足した語の読みを作り、vocab の行を書いてから語彙に足す（直した発言の行が、必ず vocab の行より後ろに並ぶ）。
          // 英字の語（略語でないもの）は、まとめて 1 度だけ updater.katakana にカタカナの読みを聞き、返ったカタカナを読みのサブコマンドでローマ字にする。
          // 英字でない語と略語は、そのまま読みのサブコマンドへ渡す。モデルが失敗した語・読みを返さない語は読みなし（直接読んで補わない）。
          // 読み取得の待ち（モデル・読みのサブコマンド）だけが中断できる。停止（Scope の閉鎖）で中断されても、足した語の記録は失いたくないので、
          // 中断のときは読みなし（全語 romaji: null）で vocab の行を 1 行書く。読み取得が返った後の処理は中断されない
          const updater = Context.get(updaterContext, DiffUpdater);
          const addVocabulary = (surfaces: ReadonlyArray<string>, source: "user" | "screen") =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const noReadings = surfaces.map((surface) => ({ surface, romaji: null, source }));
                const asked = wordsForKatakana(surfaces);
                const askedSet = new Set(asked);
                const found = yield* restore(
                  Effect.gen(function* () {
                    const answered = asked.length > 0 && updater.katakana !== undefined
                      ? yield* updater.katakana(asked).pipe(Effect.catch(() => Effect.succeed([])))
                      : [];
                    const katakana = katakanaTable(asked, answered);
                    const toRead = [...new Set([...surfaces.filter((surface) => !askedSet.has(surface)), ...katakana.values()])];
                    const read = toRead.length === 0
                      ? []
                      : yield* readings.readings(toRead).pipe(Effect.catchTag("ReadingsFailed", () => Effect.succeed([])));
                    const romajiOf = new Map(read.map((r) => [r.surface, r.romaji] as const));
                    return new Map(surfaces.map((surface) => {
                      const key = askedSet.has(surface) ? katakana.get(surface) : surface;
                      return [surface, key === undefined ? undefined : romajiOf.get(key)] as const;
                    }));
                  }).pipe(Effect.onInterrupt(() => appendRecordedLog({ type: "vocab", words: noReadings }))),
                );
                const added = surfaces.map((surface) => ({ surface, romaji: found.get(surface) || null, source }));
                yield* appendRecordedLog({ type: "vocab", words: added });
                const usable = added.flatMap((w) => (w.romaji === null ? [] : [{ surface: w.surface, romaji: w.romaji }]));
                yield* Ref.update(vocabulary, (current) => [...current, ...usable.filter((u) => !current.some((c) => c.surface === u.surface))]);
              }),
            );

          return {
            dir,
            partial: (p) => backlog === undefined ? Effect.andThen(relay.partial(p.track, p.text, p.duplicate), settling.partial(p)) : settling.partial(p),
            final: (r) => settling.final(r),
            screen: ({ start, image, lines }) =>
              Effect.gen(function* () {
                if (image === null) {
                  yield* session.pushScreen({ start, image: null }, lines);
                } else {
                  const n = yield* Ref.updateAndGet(screenCount, (c) => c + 1);
                  yield* session.pushScreen({ start, image: { id: `s${n}`, bytes: image } }, lines);
                }
                if (lines === undefined || lines.length === 0) return;
                // 規則で取った候補のうち、まだ読みを頼んでいない語だけを、まとめて 1 度だけ語彙に入れる
                const news = yield* Ref.modify(screenVocabulary, (state) => requestScreenWords(state, lines));
                if (news.length > 0) yield* FiberSet.run(vocabularyAdds, addVocabulary(news, "screen"), { startImmediately: true });
              }),
            screenOff: (off) => session.pushScreenOff(off),
            addUserVocabulary: (words) => {
              const surfaces = [...new Set(words.filter((w) => w !== ""))];
              if (surfaces.length === 0) return Effect.void;
              return Effect.andThen(
                Ref.update(screenVocabulary, (state) => ({ ...state, requested: new Set([...state.requested, ...surfaces]) })),
                Effect.asVoid(FiberSet.run(vocabularyAdds, addVocabulary(surfaces, "user"), { startImmediately: true })),
              );
            },
            drain: settling.drain,
            finishBacklog: backlog === undefined ? Effect.void : backlog.finish,
            discardBacklog: backlog === undefined ? Effect.void : backlog.discard,
            clearSpeaking: relay.clear,
            stopRelays: Effect.andThen(relay.stop, settling.stop),
            appendLog: appendRecordedLog,
            flush: session.flush,
            // テキストの 3 形式を書けないのは予期しない失敗なので defect にする（撮影・HTML の失敗は writeExportsAndCapture の中で警告にする）
            // 先に溜まりを更新する（ログから導くので、log.jsonl・export.json は書き換えない）。
            // 読み取得中の語彙追加は vocab の行を書き終えてから溜まりに入れる（待たないと、足した語・画面の語が溜まりに入らない）
            exports: Effect.andThen(
              Effect.andThen(FiberSet.awaitEmpty(vocabularyAdds), updatePoolFromSession(dir, dirname(dir))),
              Effect.flatMap(session.snapshot, (snapshot) => writeExportsAndCapture(dir, snapshot, errorMessage)),
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
