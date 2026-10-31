import { TestUpdaterLayer } from "./fixtures/sessionLayers.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { DiffUpdatePaused, DiffUpdater, REVIEW_LOG_ELEMENT_ID, type DiffInput, type Snapshot, type CaptionsFrame, type SupplementInput } from "../src/core/index.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { vocabularyPoolPath } from "../src/vocabularyPool.ts";
import { SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { fakeReadings } from "./fixtures/readings.ts";
import { collectingConsole, failingBuild, failingCapture, fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// Issue #240 段 3（ADR 0008）→ Issue #243 段 6: SessionSinks の実物 Layer を、実 tmpdir + 偽の DiffUpdater／capture で確かめる。
// updater・ログ・いま話している文字・書き出しを開く契約（CT-SINK-SCOPE）
// がこのファイルの対象。段 6 で、SessionSinks は新しいセッション（makeSession）を直接使う。
// 1 秒の途中結果（SETTLE_QUIET_MS）の待ちは、音声の時刻（後続の結果の end）で進める（壁時計では進まない。本物の時間では待たない）。
//
// 想定する契約（server/src/sessionSinks.ts）:
// - `SessionSinks.layer` が実物の Layer を作る。撮影・見返し用の HTML のビルド・mix・FileSystem は Layer の文脈から受け取る（テストの sinksLayer が偽物を渡す）。
//   updaterLayer は core の Service DiffUpdater を作る Layer で、セッションごとに Layer.build(Layer.fresh(...)) して使う
// - `createDir(sessionsDir)` がセッションのフォルダを作る（失敗すれば以後 open を呼ばない。要件3の前提）
// - `open({ dir, title, send })` がセッションの Scope の中で 1 回呼ばれ、updater をそのセッションの Scope で開き、
//   `LiveSink`（partial・final・end・interrupted・stopRelays・appendLog。end の結果が writeOut を持つ）を返す。
//   Scope を閉じると updater が閉じる

// 開いた数・閉じた数・呼ばれた数を数える偽の DiffUpdater の Layer。開くたびに別の実体（id）を作る
function makeFakeUpdater() {
  const state = { opened: 0, closed: 0, calls: 0, callIds: [] as number[] };
  const updaterLayer = Layer.effect(
    DiffUpdater,
    Effect.gen(function* () {
      const id = yield* Effect.acquireRelease(
        Effect.sync(() => ++state.opened),
        () =>
          Effect.sync(() => {
            state.closed++;
          }),
      );
      return DiffUpdater.of({
        update: () =>
          Effect.sync(() => {
            state.calls++;
            state.callIds.push(id);
            return { ops: [] };
          }),
      });
    }),
  );
  return { updaterLayer, state };
}

// 終了時の書き出しが文脈から受け取る Service（撮影・見返し用の HTML のビルド・mix）は偽物の Layer で渡す。
// 撮影は空のファイルを書くだけ、HTML は書き出し（ログの読み込み・埋め込み・書き込み）が本物でビルドだけ偽物
// ログ・export.json は実物の FileSystem で書くので、書き込みの完了は Effect のスケジューラの外にある。
// 時間を進める前後の待ち（settle・waitUntil）は、実行中のファイル操作が終わるまで実時間で待つ（trackedFileSystem）
const fileIo = trackedFileSystem();
const { settle } = fileIo;
const waitUntil = Effect.fnUntraced(function* (condition: string, predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`待機期限を超えました: ${condition}`);
    yield* settle;
  }
});
const sinksLayer = ({ updaterLayer, ...services }: { updaterLayer: Layer.Layer<DiffUpdater> } & ExportServicesOptions) =>
  Layer.merge(SessionSinks.layer, Layer.succeed(TestUpdaterLayer, updaterLayer)).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer, ...services })));

// Issue #1021: 相手の発言は話者の確定区間が揃うまで（最大 3 秒）出ない。話者に関係しない観測のテストは、始めに speaker-off を渡して、相手の発言を待たずに話者なしで出す。
// 話者の決定と待ちは、末尾の describe（speakerOff: false で開く）が対象にする
const SPEAKER_OFF = { type: "speaker-off", start: 0, reason: "モデルなし" } as const;

const withTmpSessionsDir = Effect.fn("withTmpSessionsDir")(function* () {
  return yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-sinks-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
});

describe("SessionSinks（実物 Layer）", () => {
  it.effect("一時停止中に終了し、書き出しが5分を越えても保存ログと取得済みマップを変えない", () => Effect.gen(function* () {
    let calls = 0;
    const published: Snapshot[] = [];
    const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.suspend(() => {
      calls++;
      return calls === 1 ? Effect.fail(new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "合成の利用上限" })) : Effect.succeed({ ops: [] });
    }) }));
    const exportLayer = sinksLayer({ updaterLayer, capture: (snapshot) => Effect.gen(function* () {
      expect(snapshot).toEqual(published[0]);
      yield* TestClock.adjust(600_000);
      expect(calls).toBe(1);
    }) });
    yield* Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* withTmpSessionsDir());
      const sink = yield* sinks.open({ dir, title: "終了", model: defaultClaude, updaterLayer, send: (frame) => Effect.sync(() => { if (frame.type === "snapshot") published.push(frame.snapshot); }) });
      yield* sink.speaker(SPEAKER_OFF);
      for (const n of [1, 2]) yield* sink.final({ track: "相手", start: n, end: n + 1, text: `発言${n}` });
      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      yield* writeOut;
      expect(calls).toBe(1);
      const beforeLog = readFileSync(join(dir, "log.jsonl"), "utf8");
      const beforeExport = readFileSync(join(dir, "export.json"), "utf8");
      expect(beforeLog).toContain("diff-update-paused");
      yield* writeOut;
      expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toBe(beforeLog);
      expect(readFileSync(join(dir, "export.json"), "utf8")).toBe(beforeExport);
      expect(published).toHaveLength(1);
    }).pipe(Effect.provide(exportLayer));
  }));

  it.effect("updater はセッションの Scope の資源で、Scope を閉じると閉じる（CT-SINK-SCOPE）", () => {
    const { updaterLayer, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      expect(state.opened).toBe(0); // フォルダを作っただけでは開かない

      const scope = yield* Scope.make();
      yield* Scope.provide(
        sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void }),
        scope,
      );
      expect(state).toMatchObject({ opened: 1, closed: 0 });

      yield* Scope.close(scope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("フォルダを作れないと createDir が失敗し、open を呼ばなければ updater も開かない", () => {
    const { updaterLayer, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const tmp = yield* withTmpSessionsDir();
      const blocker = join(tmp, "blocker");
      writeFileSync(blocker, ""); // 親のフォルダの位置に通常ファイルを置き、mkdir できなくする
      const sinks = yield* SessionSinks;

      const result = yield* Effect.exit(sinks.createDir(join(blocker, "sessions")));

      expect(result._tag).toBe("Failure");
      expect(state).toMatchObject({ opened: 0, closed: 0 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // Issue #1020 → #1021: sink.speaker で渡した speaker・speaker-off は、生の値のまま受け取った順で log.jsonl に先に書かれ、at が付く。差分更新の入力には載らない。
  // 相手の発言は話者の確定区間が揃うまで保留されるので、発言の行は保留が解ける speaker-off の後ろに並ぶ。
  // speaker-mixed（Issue #1024）と speaker-centroid（Issue #1025）も同じく生の値のまま残る。起動し直しの合図（speakersRenumbered）は log.jsonl に行を足さない
  it.effect("sink.speaker の speaker・speaker-off は生の値のまま log.jsonl に受け取った順で書かれ、差分更新の入力に載らない", () => {
    const inputs: DiffInput[] = [];
    const updaterLayer = Layer.succeed(
      DiffUpdater,
      DiffUpdater.of({ update: (input) => Effect.sync(() => { inputs.push(input); return { ops: [] }; }) }),
    );
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });

      yield* sink.speaker({ type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 1, final: false });
      yield* sink.final({ track: "相手", start: 3, end: 4, text: "採用" });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true });
      yield* sink.speaker({ type: "speaker-off", start: 9, reason: "読み込みに失敗" });
      yield* sink.speaker({ type: "speaker-mixed", track: "相手", slot: 1, start: 95.5 });
      yield* sink.speaker({ type: "speaker-centroid", track: "相手", slot: 1, centroid: [0.25, -0.5, 1] });
      yield* sink.speakersRenumbered;
      yield* sink.speaker({ type: "speaker-centroid", track: "相手", slot: 1, centroid: [3, 2, 1] });
      yield* waitUntil("話者イベント後の差分更新", () => inputs.length === 1 && logEvents(dir).some((e) => e.type === "diff"));

      const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
      const speakerLines = log.filter((e) => typeof e.type === "string" && e.type.startsWith("speaker"));
      expect(speakerLines.map(({ at, ...rest }) => ({ hasAt: typeof at === "string", rest }))).toEqual([
        { hasAt: true, rest: { type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 1, final: false } },
        { hasAt: true, rest: { type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true } },
        { hasAt: true, rest: { type: "speaker-off", start: 9, reason: "読み込みに失敗" } },
        { hasAt: true, rest: { type: "speaker-mixed", track: "相手", slot: 1, start: 95.5 } },
        { hasAt: true, rest: { type: "speaker-centroid", track: "相手", slot: 1, centroid: [0.25, -0.5, 1] } },
        { hasAt: true, rest: { type: "speaker-centroid", track: "相手", slot: 1, centroid: [3, 2, 1] } },
      ]);
      expect(log.map((e) => e.type).filter((t) => t.includes("restart") || t.includes("renumber"))).toEqual([]);
      expect(log.map((e) => e.type).filter((t) => t === "start" || t === "speaker" || t === "speaker-off" || t === "remark")).toEqual(["start", "speaker", "speaker", "speaker-off", "remark"]);
      for (const input of inputs) expect(JSON.stringify(input)).not.toContain("speaker");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("writeOut は書き出した 5 パスを返す（4 つ目が map.png、5 つ目が map.html）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });

      yield* sink.screen({ start: 0, image: new Uint8Array([1]), ocrFailed: true });
      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths, ocrSummary } = yield* writeOut;

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html"]);
      expect(ocrSummary).toEqual({ images: 1, failed: 1 });
      for (const path of paths) expect(existsSync(path)).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  it.effect("録音（相手.m4a・自分.m4a）があるセッションの writeOut は 6 パスを返し、map.html の後に map-audio.html が並ぶ。map-audio.html には mix の出力が入る", () => {
    const mix = fakeAudioMix();
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      writeFileSync(join(dir, "相手.m4a"), "録音");
      writeFileSync(join(dir, "自分.m4a"), "録音");

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut;

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html", "map-audio.html"]);
      expect(mix.calls.map((c) => c.session)).toEqual([dir]);
      expect(embeddedAudio(readFileSync(join(dir, "map-audio.html"), "utf8"))).toEqual(FAKE_MIX_BYTES);
      expect(embeddedAudio(readFileSync(join(dir, "map.html"), "utf8"))).toBeNull();
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, mix })));
  });

  it.effect("録音が無いセッションの writeOut は 5 パスだけで、mix を呼ばず、標準エラーに map-audio の理由を出さない", () => {
    const mix = fakeAudioMix();
    return Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths).toHaveLength(5);
      expect(mix.calls).toEqual([]);
      expect(existsSync(join(dir, "map-audio.html"))).toBe(false);
      expect(warnings.errors.join("")).not.toContain("map-audio");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, mix })));
  });

  it.effect("mix が失敗しても writeOut は map.html までの 5 パスを返し、標準エラーに「map-audio.html を書き出せませんでした: <理由>」を残す", () => {
    const mix = fakeAudioMix();
    return Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      writeFileSync(join(dir, "相手.m4a"), "録音");
      mix.failure.reason = "録音を混ぜられない";

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html"]);
      expect(existsSync(join(dir, "map-audio.html"))).toBe(false);
      expect(warnings.errors.some((s) => s.includes("map-audio.html を書き出せませんでした: 録音を混ぜられない"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, mix })));
  });

  it.effect("撮影が失敗しても writeOut は map.html を含む 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.html"]);
      expect(existsSync(join(dir, "map.png"))).toBe(false);
      expect(warnings.errors.some((s) => s.includes("map.png を書き出せませんでした: 撮影に失敗"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, capture: failingCapture() }))));

  it.effect("map.html の書き出しが失敗しても writeOut はほかの 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png"]);
      expect(existsSync(join(dir, "map.html"))).toBe(false);
      expect(warnings.errors.some((s) => s.includes("map.html を書き出せませんでした: ビルドに失敗"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: failingBuild() }))));

  const openWithRemark = Effect.gen(function* () {
    const sessionsDir = yield* withTmpSessionsDir();
    const sinks = yield* SessionSinks;
    const dir = yield* sinks.createDir(sessionsDir);
    const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
    yield* sink.speaker(SPEAKER_OFF);
    yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
    return { dir, sink };
  });
  const fileNames = (paths: readonly string[]) => paths.map((p) => p.split("/").pop());

  it.effect("撮影の後始末が defect で失敗しても、writeOut は map.html を含む 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(fileNames(paths)).toEqual(["map.md", "map.json", "map.drawnix", "map.html"]);
      expect(warnings.errors).toHaveLength(1);
      expect(warnings.errors[0]).toContain("map.png を書き出せませんでした: 後始末に失敗");
      expect(warnings.errors[0]).not.toContain("pnpm cli install");
    })).pipe(
      Effect.provide(
        sinksLayer({
          updaterLayer: makeFakeUpdater().updaterLayer,
          capture: () => Effect.scoped(Effect.acquireRelease(Effect.void, () => Effect.die(new Error("後始末に失敗")))),
        }),
      ),
    ));

  it.effect("map.html のビルドが defect で失敗しても、writeOut はほかの 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { dir, sink } = yield* openWithRemark;

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(fileNames(paths)).toEqual(["map.md", "map.json", "map.drawnix", "map.png"]);
      expect(existsSync(join(dir, "map.html"))).toBe(false);
      expect(warnings.errors).toEqual(["map.html を書き出せませんでした: ビルドが落ちた"]);
    })).pipe(
      Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: Effect.die(new Error("ビルドが落ちた")) })),
    ));

  it.effect("撮影が中断されたときは、警告にせず中断のまま伝える", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const exit = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service), Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(warnings.errors).toEqual([]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, capture: () => Effect.interrupt }))));

  it.effect("サーバーの警告は、撮影の失敗の理由の改行を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      yield* (yield* sink.end({ kind: "入れ切る" })).writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(warnings.errors).toHaveLength(1);
      expect(warnings.errors[0]).toContain("map.png を書き出せませんでした: 撮影に失敗\n詳細");
      expect(warnings.errors[0]).not.toContain("pnpm cli install");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, capture: failingCapture("撮影に失敗\n詳細") }))));

  it.effect("サーバーの警告は、map.html の失敗の理由の改行を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      yield* (yield* sink.end({ kind: "入れ切る" })).writeOut.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(warnings.errors).toContain("map.html を書き出せませんでした: ビルドに失敗\n詳細");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: failingBuild("ビルドに失敗\n詳細") }))));

  it.effect("endの後もwriteOutを実行するまで書き出さず、実行ごとに撮影する", () => {
    let captured = 0;
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      expect(captured).toBe(0);
      expect(existsSync(join(dir, "map.md"))).toBe(false);
      yield* writeOut;
      yield* writeOut;
      expect(captured).toBe(2);
      expect(existsSync(join(dir, "map.md"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({
      updaterLayer: makeFakeUpdater().updaterLayer,
      capture: (_snapshot, path) => Effect.sync(() => { captured++; writeFileSync(path, ""); }),
    })));
  });

  it.effect("テキストの 3 形式を書けないときは、失敗の値ではなく defect になる（撮影・HTML の失敗のように諦めない）", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      rmSync(dir, { recursive: true, force: true }); // 書き先のフォルダが無くなる

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const exit = yield* writeOut.pipe(Effect.provideService(Console.Console, warnings.service), Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true);
      expect(warnings.errors).toEqual([]); // 諦めた警告ではない
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  it.effect("writeOut で書く map.html には、そのセッションの log.jsonl の出来事がそのまま埋め込まれる", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });

      yield* (yield* sink.end({ kind: "入れ切る" })).writeOut;

      const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
      const html = readFileSync(join(dir, "map.html"), "utf8");
      const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toEqual(log);
      expect(log.length).toBeGreaterThan(0);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  // Layer はメモ化されるので、サーバーで 1 回だけ作ると 2 つのセッションが 1 つの updater（query）を使い回してしまう。
  // セッションごとに Layer.build(Layer.fresh(updaterLayer)) するので、同じ SessionSinks の上で続けて開いたセッションは別の updater を持つ
  it.live("同じ SessionSinks で 2 つのセッションを続けて開閉すると、updater は別の実体で、開いた回数・閉じた回数がどちらも 2 になる（CT-PER-SESSION-UPDATER）", () => {
    const { updaterLayer, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const noop = { send: () => Effect.void };

      const firstScope = yield* Scope.make();
      const first = yield* Scope.provide(sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "一つ目", ...noop }), firstScope);
      yield* first.speaker(SPEAKER_OFF);
      expect(state).toMatchObject({ opened: 1, closed: 0 });
      yield* first.final({ track: "相手", start: 0, end: 1, text: "ひとつめの発言" });
      yield* (yield* first.end({ kind: "入れ切る" })).writeOut;
      yield* Scope.close(firstScope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5))); // フォルダ名は開始時刻（実時間のミリ秒）
      const secondScope = yield* Scope.make();
      const second = yield* Scope.provide(sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "二つ目", ...noop }), secondScope);
      yield* second.speaker(SPEAKER_OFF);
      expect(state).toMatchObject({ opened: 2, closed: 1 }); // 2 つ目は 1 つ目を使い回さず、新しく開く
      yield* second.final({ track: "相手", start: 0, end: 1, text: "ふたつめの発言" });
      yield* (yield* second.end({ kind: "入れ切る" })).writeOut;
      yield* Scope.close(secondScope, Exit.void);

      expect(state).toMatchObject({ opened: 2, closed: 2 });
      expect(state.callIds).toEqual([1, 2]); // それぞれのセッションの差分更新は、そのセッションの updater（別の実体）が受けた
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

});

// 送った字幕のフレームの読み取り
const lastTexts = (speaks: readonly CaptionsFrame[], track: "相手" | "自分") => speaks.at(-1)?.bubbles.filter((b) => b.track === track).map((b) => b.text);

// 公開したスナップショット・送った captions を記録する Sink の組み立て
const openRecordingSink = Effect.fn("openRecordingSink")(function* ({ speakerOff = true, vocab = [] }: { speakerOff?: boolean; vocab?: ReadonlyArray<string> } = {}) {
  const sessionsDir = yield* withTmpSessionsDir();
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(sessionsDir);
  const speaks: CaptionsFrame[] = [];
  const published: Snapshot[] = [];
  const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude,
    dir,
    title: "週次",
    vocab,
    send: (frame) => Effect.sync(() => {
      if (frame.type === "snapshot") published.push(frame.snapshot);
      else if (frame.type === "captions") speaks.push(frame);
    }),
  });
  if (speakerOff) yield* sink.speaker(SPEAKER_OFF);
  return { sink, dir, speaks, published };
});

// 差分更新に渡った入力を記録する偽の DiffUpdater の Layer。
// katakana（英字の語のカタカナの読み。Issue #642）は、table の語だけ答える。
// updateGate.gate を設定すると、差分更新はその Deferred が完了するまで返らない（呼び出し中のまま止めて、反映前の状態を見る）
const makeRecordingUpdater = (table: Record<string, string> = {}) => {
  const calls: DiffInput[] = [];
  const updateGate: { gate: Deferred.Deferred<void> | null } = { gate: null };
  const updaterLayer = Layer.succeed(
    DiffUpdater,
    DiffUpdater.of({
      update: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          if (updateGate.gate !== null) yield* Deferred.await(updateGate.gate);
          return { ops: [] };
        }),
      katakana: (words) => Effect.succeed(words.flatMap((surface) => (table[surface] === undefined ? [] : [{ surface, katakana: table[surface]! }]))),
    }),
  );
  return { calls, updateGate, updaterLayer };
};

const logEvents = (dir: string) =>
  readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

const finalRemark = (track: "相手" | "自分", start: number, end: number, text: string) => ({ track, start, end, text });

describe("SessionSinks（実物 Layer）: 発言の確定・途中結果・書き出し", () => {

  it.effect("中断は保留発言を一度だけ投入してから字幕を消し、同じ sink で受信を続けて停止できる", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const reply = yield* Deferred.make<void>();
      updateGate.gate = reply;
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* withTmpSessionsDir());
      const speaks: CaptionsFrame[] = [];
      const remarksAtClear: string[][] = [];
      const remarks = () => logEvents(dir).filter((event) => event.type === "remark").map((event) => event.remark);
      const sink = yield* sinks.open({
        updaterLayer, model: defaultClaude, dir, title: "途切れる会議",
        send: (frame) => Effect.sync(() => {
          if (frame.type !== "captions") return;
          speaks.push(frame);
          if (frame.bubbles.length === 0) remarksAtClear.push(remarks().map((remark) => remark.text));
        }),
      });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.partial({ track: "相手", start: 1, end: 2, text: "途切れる前", duplicate: false });
      expect(lastTexts(speaks, "相手")).toEqual(["途切れる前"]);
      expect(remarks()).toEqual([]);
      const clearsBefore = remarksAtClear.length;

      yield* sink.interrupted;

      const cleared = remarksAtClear.slice(clearsBefore);
      expect(cleared.length).toBeGreaterThan(0);
      for (const texts of cleared) expect(texts).toEqual(["途切れる前"]);
      expect(speaks.at(-1)?.bubbles).toEqual([]);
      expect(remarks()).toMatchObject([{ id: "r1", text: "途切れる前" }]);

      yield* sink.partial({ track: "相手", start: 3, end: 4, text: "再開した後", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* waitUntil("lastTexts(speaks, \"相手\")?.includes(\"再開した後\") === true", () => lastTexts(speaks, "相手")?.includes("再開した後") === true);
      expect(lastTexts(speaks, "相手")).toContain("再開した後");
      yield* sink.final(finalRemark("相手", 3, 4, "再開した後"));
      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      yield* Deferred.succeed(reply, undefined);
      yield* writeOut;
      yield* sink.stopRelays;

      expect(remarks().map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "r1", text: "途切れる前" },
        { id: "r2", text: "再開した後" },
      ]);
      expect(calls.flatMap((input) => input.fresh).map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "r1", text: "途切れる前" },
        { id: "r2", text: "再開した後" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("発言が 1 件も来ないセッションでも、writeOut はそのセッションのマップ（空の会議ノード）を書き出す", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const { paths } = yield* writeOut;

      expect(paths).toHaveLength(5);
      expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).root).toMatchObject({ kind: "会議", text: "週次", children: [] });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  // base の server.heavy.test.ts の移動先
  it.effect("writeOut は最後の差分更新（r3 を含む）が終わるまで待ち、その後に Scope を閉じて updater を閉じる。閉じた後には呼ばれない（base:581）", () => {
    const state = { calls: [] as string[][], closed: 0, callsAfterClose: 0 };
    const updaterLayer = Layer.effect(
      DiffUpdater,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.closed++;
          }),
        );
        return DiffUpdater.of({
          update: (input) =>
            Effect.gen(function* () {
              yield* Effect.sleep(30); // 反映に時間がかかる（TestClock で進める）
              if (state.closed > 0) state.callsAfterClose++;
              state.calls.push(input.fresh.map((u) => u.id));
              return { ops: [] };
            }),
        });
      }),
    );
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const scope = yield* Scope.make();
      const sink = yield* Scope.provide(sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", send: () => Effect.void }), scope);
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final(finalRemark("相手", 1, 2, "ひとつめ"));
      yield* sink.final(finalRemark("自分", 3, 4, "ふたつめ"));
      yield* sink.final(finalRemark("相手", 5, 6, "みっつめ"));

      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      const flushing = yield* Effect.forkChild(writeOut);
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(30); // r1 の反映、続けて（r1 の呼び出し中に届いた）r2+r3 のまとめの反映が、それぞれ 30 ms かかる
        yield* settle;
      }
      yield* Fiber.join(flushing);
      expect(state.calls).toEqual([["r1"], ["r2", "r3"]]); // writeOut が戻った時点で、3 件とも差分更新に渡っている。r1 はすぐ、r2・r3 は r1 の呼び出し中に届いたので 1 回にまとまる
      expect(state.closed).toBe(0);
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(100);
      yield* settle;

      expect(state).toMatchObject({ closed: 1, callsAfterClose: 0 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("差分更新で反映された発言は、相手の最後の captions から消える（onDiff が relay.flushAll につながる）。反映前は本文が出ている", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      const reply = yield* Deferred.make<void>();
      updateGate.gate = reply; // 差分更新は呼ばれても返らない（反映前のまま）

      yield* sink.partial({ track: "自分", start: 5, end: 6, text: "じぶんのとちゅう", duplicate: false });
      yield* sink.final(finalRemark("相手", 1, 5, "採用の面接について"));
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* waitUntil("lastTexts(speaks, \"相手\")?.[0] === \"採用の面接について\"", () => lastTexts(speaks, "相手")?.[0] === "採用の面接について");
      expect(lastTexts(speaks, "相手")).toEqual(["採用の面接について"]); // 反映前: 確定した発言の本文が出ている
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]); // 発言 1 件ですぐ呼ばれているが、まだ返っていない

      yield* Deferred.succeed(reply, undefined);
      yield* waitUntil("lastTexts(speaks, \"相手\")?.length === 0", () => lastTexts(speaks, "相手")?.length === 0);
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]);
      expect(lastTexts(speaks, "相手")).toEqual([]); // 反映後: 処理済みの発言が消えている
      expect(lastTexts(speaks, "自分")).toEqual(["じぶんのとちゅう"]); // 反映に渡していない途中結果は残る
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // フォルダ名は開始時刻（実時間のミリ秒）なので、このテストだけ実時間の短い待ち（5 ms）を使う
  it.live("同じ sessionsDir の 2 つ目のセッションは、発言が 1 件も無くても、作成直後の export.json がそのセッションのマップ（前のセッションではない。base:510）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const noop = { send: () => Effect.void };
      const firstDir = yield* sinks.createDir(sessionsDir);
      const first = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir: firstDir, title: "前", ...noop });
      yield* first.speaker(SPEAKER_OFF);
      yield* first.final(finalRemark("相手", 1, 2, "前の発言"));
      yield* (yield* first.end({ kind: "入れ切る" })).writeOut;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      const secondDir = yield* sinks.createDir(sessionsDir);
      yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir: secondDir, title: "今", ...noop });

      expect(secondDir).not.toBe(firstDir);
      const exported = JSON.parse(readFileSync(join(secondDir, "export.json"), "utf8"));
      expect(JSON.stringify(exported)).toContain("今");
      expect(JSON.stringify(exported)).not.toContain("前の発言");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));
});

// Issue #640: 利用者が足した語で発言を直す。
// open の vocab が、語を Readings（読みのサブコマンド）にまとめて 1 回渡して読みを作り、
// log.jsonl に vocab の行（表記・読み・出どころ user。読みが無い語は romaji: null）を書いてから、語彙に読みのある語を足す。
// 開始を待たせないため、読みは open が返った後に非同期で作られる。
// 関所を通った後の本文を補正して発言にする（確定結果・1 秒更新されなかった途中結果・end のどの出口でも）。途中結果（captions）は直さない。
// 読みの語は実際のトークナイザの出力。remark の行の text は直した本文、raw は直す前の本文、words は直す前の本文の位置のまま
describe("SessionSinks（実物 Layer）: 利用者が足した語で発言を直す（Issue #640）", () => {
  type Token = readonly [surface: string, romaji: string];
  const utterance = (...tokens: Token[]) => {
    let location = 0;
    const words = tokens.map(([surface, romaji]) => {
      const word = { surface, romaji, location, length: surface.length };
      location += surface.length;
      return word;
    });
    return { text: tokens.map(([surface]) => surface).join(""), words };
  };
  // 江南店に行きます（港南店の崩れ）
  const garbled = utterance(["江南", "kounan"], ["店", "ten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]);
  // 英字の語はモデルのカタカナの読みを読みのサブコマンドに渡してローマ字にする（Issue #642）
  const KATAKANA = { Zendesk: "ゼンデスク" };
  const READINGS = { 港南店: "kounanten", ゼンデスク: "zendesuku" };
  const vocabLines = (dir: string) => logEvents(dir).filter((e) => e.type === "vocab");
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");

  it.effect("語の読みができる前に締めた発言は直し直さない。読みができた後の発言は直り、先の発言の行は変わらない", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      readings.gate.current = yield* Deferred.make<void>();
      const { sink, dir } = yield* openRecordingSink({ vocab: ["港南店", "Zendesk"] });
      yield* settle;
      expect(vocabLines(dir)).toEqual([]); // まだ読みができていない

      yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      yield* waitUntil("読み取得前の発言がログへ届く", () => remarkLines(dir).length === 1);
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["江南店に行きます"]);

      yield* Deferred.succeed(readings.gate.current, undefined);
      yield* waitUntil("vocabLines(dir).length === 1", () => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 10, end: 12, text: garbled.text, words: garbled.words });
      yield* waitUntil("読み取得後の発言がログへ届く", () => remarkLines(dir).length === 2);

      // 先の発言は直し直されず、後の発言だけが直る。先の発言の行は vocab の行より前にある
      expect(remarkLines(dir).map((e) => [e.remark.id, e.remark.text, e.raw])).toEqual([
        ["r1", "江南店に行きます", "江南店に行きます"],
        ["r2", "港南店に行きます", "江南店に行きます"],
      ]);
      const types = logEvents(dir).map((e) => (e.type === "remark" ? `remark:${e.remark.id}` : e.type));
      expect(types.indexOf("remark:r1")).toBeLessThan(types.indexOf("vocab"));
      expect(types.indexOf("vocab")).toBeLessThan(types.indexOf("remark:r2"));
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

});

// Issue #643: 共有画面の文字（screen の lines）から語彙に入る。
// SessionSink.screen({ start, image, lines }) が、lines から規則で候補を取り、まだ読みを頼んでいない語だけを Readings にまとめて 1 回渡す。
// log.jsonl には screen の行（lines つき）→ vocab の行（出どころ screen。読みが作れなかった語は romaji: null）の順に書き、
// その後に語彙へ足す。画面が変わっても語彙は減らさず、足す前に締めた発言は直し直さない。lines が空でも、読みが失敗しても、セッションは続く。
describe("SessionSinks（実物 Layer）: 共有画面の文字から語彙に入る（Issue #643）", () => {
  type Token = readonly [surface: string, romaji: string];
  const utterance = (...tokens: Token[]) => {
    let location = 0;
    const words = tokens.map(([surface, romaji]) => {
      const word = { surface, romaji, location, length: surface.length };
      location += surface.length;
      return word;
    });
    return { text: tokens.map(([surface]) => surface).join(""), words };
  };
  // 江南店に行きます（港南店の崩れ）
  const garbled = utterance(["江南", "kounan"], ["店", "ten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]);
  const KATAKANA = { Zendesk: "ゼンデスク" };
  const READINGS = { 港南店: "kounanten", ゼンデスク: "zendesuku" };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const vocabLines = (dir: string) => logEvents(dir).filter((e) => e.type === "vocab");
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");
  const typesOf = (dir: string) => logEvents(dir).map((e) => (e.type === "remark" ? `remark:${e.remark.id}` : e.type === "screen" ? `screen:${e.start}` : e.type));
  type Sink = Effect.Success<ReturnType<typeof openRecordingSink>>["sink"];
  const showScreen = (sink: Sink, start: number, lines: ReadonlyArray<string>) => sink.screen({ start, image: jpeg, lines });

  it.effect("画面から入った語で、その後に締めた発言が直る。remark の行は text が直した本文、raw が直す前の本文で、差分更新と字幕には直った表記が渡る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, speaks } = yield* openRecordingSink();
      yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
      yield* waitUntil("vocabLines(dir).length === 1", () => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words });
      yield* waitUntil("calls.flatMap((c) => c.fresh).length === 1", () => calls.flatMap((c) => c.fresh).length === 1);
      yield* waitUntil("speaks.some((f) => f.bubbles.some((b) => b.text === \"港南店に行きます\"))", () => speaks.some((f) => f.bubbles.some((b) => b.text === "港南店に行きます")));
      yield* waitUntil("補正した発言のログ", () => remarkLines(dir).length === 1);

      expect(remarkLines(dir)).toHaveLength(1);
      expect(remarkLines(dir)[0].remark).toMatchObject({ id: "r1", text: "港南店に行きます" });
      expect(remarkLines(dir)[0].raw).toBe("江南店に行きます");
      expect(calls.flatMap((c) => c.fresh)[0]?.text).toBe("港南店に行きます");
      expect(speaks.some((f) => f.bubbles.some((b) => b.text.includes("江南店")))).toBe(false);
      expect(typesOf(dir).indexOf("screen:1")).toBeLessThan(typesOf(dir).indexOf("vocab"));
      expect(vocabLines(dir)[0]).toHaveProperty("at");
      expect(logEvents(dir).find((e) => e.type === "screen")?.lines).toEqual(["港南店", "Zendesk"]);
      expect(typesOf(dir).indexOf("vocab")).toBeLessThan(typesOf(dir).indexOf("remark:r1"));
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

});

describe("SessionSinks（実物 Layer）: 録画の組み立て", () => {
  it.effect("再起動準備は途中結果を締めてendを返し、画面のstart以降だけ補正し、投入した発言だけ字幕へ出す", () => {
    const readings = fakeReadings({ 港南店: "kounanten" });
    const { updaterLayer, updateGate, calls } = makeRecordingUpdater();
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      updateGate.gate = gate;
      const speaks: CaptionsFrame[] = [];
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* withTmpSessionsDir());
      const sink = yield* sinks.openRecorded({
        dir, title: "録画", model: defaultClaude, updaterLayer,
        send: (frame) => Effect.sync(() => { if ("type" in frame && frame.type === "captions") speaks.push(frame); }),
        recorded: { realtime: false, selfTrack: false, progress: () => Effect.void, paused: () => Effect.void },
      });
      yield* sink.speaker(SPEAKER_OFF);
      const words = [{ surface: "江南", romaji: "kounan", location: 0, length: 2 }, { surface: "店", romaji: "ten", location: 2, length: 1 }];
      yield* sink.final({ track: "相手", start: 590, end: 600, text: "江南店", words });
      yield* waitUntil("calls.length === 1 && lastTexts(speaks, \"相手\")?.[0] === \"江南店\"", () => calls.length === 1 && lastTexts(speaks, "相手")?.[0] === "江南店");
      expect(yield* sink.drainForRestart).toEqual({ 相手: 600 });
      yield* sink.screen({ start: 650, image: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), lines: ["港南店"] });
      yield* waitUntil("logEvents(dir).some((e) => e.type === \"vocab\")", () => logEvents(dir).some((e) => e.type === "vocab"));
      yield* settle;
      expect(readings.calls).toEqual([["港南店"]]);
      expect(logEvents(dir).filter((e) => e.type === "screen")).toEqual([]);
      yield* sink.final({ track: "相手", start: 610, end: 620, text: "江南店", words });
      yield* sink.partial({ track: "相手", start: 760, end: 770, text: "江南店", words, duplicate: false });
      expect(yield* sink.drainForRestart).toEqual({ 相手: 770 });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settle;
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => e.remark.end)).toEqual([600]);
      expect(speaks.flatMap((frame) => frame.bubbles).every((bubble) => bubble.end <= 600)).toBe(true);
      expect(lastTexts(speaks, "相手")).toEqual(["江南店"]);
      yield* sink.final({ track: "相手", start: 760, end: 770, text: "江南店", words });
      yield* sink.final({ track: "相手", start: 800, end: 810, text: "続きの発言です" });
      yield* Deferred.succeed(gate, undefined);
      const { writeOut } = yield* sink.end({ kind: "入れ切る" });
      yield* writeOut;
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.start, e.remark.end, e.remark.text])).toEqual([
        ["r1", 590, 600, "江南店"], ["r2", 610, 620, "江南店"], ["r3", 760, 770, "港南店"], ["r4", 800, 810, "続きの発言です"],
      ]);
      expect(logEvents(dir).filter((e) => e.type === "screen").map((e) => e.start)).toEqual([650]);
    }).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });
});

// Issue #645: 過去のセッションの語彙を引き継ぐ。
// セッションの置き場（LIVE_MINDMAP_SESSIONS = createDir に渡す sessionsDir）の中に、全セッションをまたぐ溜まりのファイルを 1 つ置く。
// 開始（open）で溜まりの語を読みごと vocab の行（出どころ carried）として語彙に入れ（読みは作り直さない）、
// 終了（writeOut）で、直した後の発言に出た語と利用者が足した語を溜まりへ入れ、共有画面に映っただけの語は入れない。
// 最後に話されてから一定のセッション数だけ話されなかった語（足した語を除く）は落ちる。
describe("SessionSinks（実物 Layer）: 過去のセッションの語彙を引き継ぐ（Issue #645）", () => {
  type Token = readonly [surface: string, romaji: string];
  const utterance = (...tokens: Token[]) => {
    let location = 0;
    const words = tokens.map(([surface, romaji]) => {
      const word = { surface, romaji, location, length: surface.length };
      location += surface.length;
      return word;
    });
    return { text: tokens.map(([surface]) => surface).join(""), words };
  };
  // 江南店に行きます（港南店の崩れ）／港南店に行きます（正しい表記）
  const garbled = utterance(["江南", "kounan"], ["店", "ten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]);
  const correct = utterance(["港南店", "kounanten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]);
  const READINGS = { 港南店: "kounanten", Zendesk: "zendesuku", 葛西: "kasai" };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const vocabLines = (dir: string) => logEvents(dir).filter((e) => e.type === "vocab");
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");
  const readPool = (sessionsDir: string) => JSON.parse(readFileSync(vocabularyPoolPath(sessionsDir), "utf8"));
  type Sink = Effect.Success<ReturnType<typeof openRecordingSink>>["sink"];
  type Context = { sink: Sink; dir: string };

  // セッションを 1 つ流す: 開く → script → 発言を締める → 書き出し（終了の処理）→ 閉じる。同じ sessionsDir で続けて呼ぶと、前のセッションの溜まりを引き継ぐ。
  // exports: false は、終了の処理を通らなかったセッション（書き出しを呼ばずに閉じる）
  const runSession = Effect.fn("runSession")(function* (sessionsDir: string, script: (context: Context) => Effect.Effect<void>, options: { exports?: boolean; vocab?: ReadonlyArray<string> } = {}) {
    // セッションのフォルダ名は開始時刻（ミリ秒）。続けて開いても重ならないよう実時間で少し待つ
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 3)));
    return yield* Effect.scoped(Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次", vocab: options.vocab, send: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* script({ sink, dir });
      if (options.exports !== false) {
        const { writeOut } = yield* sink.end({ kind: "入れ切る" });
        yield* writeOut;
      }
      return dir;
    }));
  });

  const showScreen = (sink: Sink, start: number, lines: ReadonlyArray<string>) => sink.screen({ start, image: jpeg, lines });
  // 画面に映った語が語彙に入る（vocab の行が n 行になる）まで待つ
  const awaitVocabLines = (dir: string, n: number) => waitUntil("existsSync(join(dir, \"log.jsonl\")) && vocabLines(dir).length === n", () => existsSync(join(dir, "log.jsonl")) && vocabLines(dir).length === n);

  // 港南店と Zendesk が画面に映り、港南店だけが話される（Zendesk は映っただけ）
  const spokeOnlyKounan = ({ sink, dir }: Context) =>
    Effect.gen(function* () {
      yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
      yield* awaitVocabLines(dir, 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 2, end: 4, text: correct.text, words: correct.words });
    });
  const layerWith = (readings = fakeReadings(READINGS)) => ({ readings, layer: sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer, readings }) });

  it.effect("補足には溜まりのspokenとuserだけを渡し、この会議の入力語彙と画面語彙を混ぜない", () => {
    const calls: SupplementInput[] = [];
    const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({
      update: (input) => Effect.succeed({ ops: [{ op: "add", ref: "topic", parent: "root", kind: "議題", text: "港南店", evidence: [input.fresh[0]!.id] }] }),
      supplement: (input) => Effect.sync(() => { calls.push(input); return { op: null, category: null }; }),
    }));
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      writeFileSync(vocabularyPoolPath(sessionsDir), JSON.stringify({ sessions: 1, words: [
        { surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 },
        { surface: "Zendesk", romaji: "zendesuku", source: "user", lastSpoken: 0 },
      ] }));
      yield* runSession(sessionsDir, ({ sink }) => Effect.gen(function* () {
        yield* showScreen(sink, 1, ["画面だけ"]);
        yield* sink.final({ track: "相手", start: 2, end: 4, text: correct.text, words: correct.words });
      }), { vocab: ["今回入力"] });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.carriedTerms).toEqual(["港南店", "Zendesk"]);
    }).pipe(Effect.provide(sinksLayer({ updaterLayer, readings: fakeReadings(READINGS) })));
  });

  it.effect("溜まりのファイルを次のセッションへ引き継ぎ番号とcarriedの行を記録する", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const first = yield* runSession(sessionsDir, spokeOnlyKounan);
      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] });
      expect(logEvents(first).filter((e) => e.type === "vocab-pool")).toEqual([expect.objectContaining({ session: 1 })]);
      const second = yield* runSession(sessionsDir, () => Effect.void);
      expect(vocabLines(second)).toEqual([expect.objectContaining({ at: expect.any(String), words: [{ surface: "港南店", romaji: "kounanten", source: "carried" }] })]);
      expect(logEvents(second).filter((e) => e.type === "vocab-pool")).toEqual([expect.objectContaining({ session: 2 })]);
      expect(readPool(sessionsDir)).toEqual({ sessions: 2, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("読み取得の途中で停止（writeOut）してもvocabを書き終えてから新しい語を溜まりへ入れる", () => {
    const { readings, layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, spokeOnlyKounan);
      expect(readPool(sessionsDir).words[0]).toMatchObject({ surface: "港南店", source: "spoken" });

      const readingGate = yield* Deferred.make<void>();
      readings.gate.current = readingGate;
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* awaitVocabLines(dir, 1);
        yield* waitUntil("readings.calls.some((c) => c.includes(\"葛西\"))", () => readings.calls.some((c) => c.includes("葛西")));
        expect(readings.calls.at(-1)).toEqual(["葛西"]);
        const { writeOut } = yield* sink.end({ kind: "入れ切る" });
        const started = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const stopping = yield* Effect.forkChild(Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* writeOut;
          yield* Deferred.succeed(finished, undefined);
        }));
        yield* Deferred.await(started);
        yield* settle;
        expect(vocabLines(dir)).toHaveLength(1); // 足した語の記録はまだ無い
        expect(readPool(sessionsDir).words[0]).toMatchObject({ source: "spoken" }); // 溜まりは記録を待っている
        expect(readPool(sessionsDir).words.map((w: { surface: string }) => w.surface)).toEqual(["港南店"]);
        expect(yield* Deferred.isDone(finished)).toBe(false);
        yield* Deferred.succeed(readingGate, undefined);
        yield* Fiber.join(stopping);
        expect(vocabLines(dir).flatMap((e) => e.words)).toContainEqual({ surface: "葛西", romaji: "kasai", source: "user" });
      }), { exports: false, vocab: ["葛西"] });

      expect(readPool(sessionsDir).words).toEqual([
        { surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 },
        { surface: "葛西", romaji: "kasai", source: "user", lastSpoken: 0 },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("終了の処理を通らなかったセッションは、始めたセッションの数だけが増え、話された語は溜まりに入らない（cli restore が組み直す前提）", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const dir = yield* runSession(sessionsDir, spokeOnlyKounan, { exports: false });
      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [] });
      expect(logEvents(dir).filter((e) => e.type === "vocab-pool")).toEqual([expect.objectContaining({ session: 1 })]);
    }).pipe(Effect.provide(layer));
  });

  // Issue #646: cli vocab forget はファイルだけを書き換える（実行中のサーバーには何も送らない）。ここでは forget に当たる書き換えをファイルへ直接行う
  const forgetFromFile = (sessionsDir: string, surface: string) => {
    const pool = readPool(sessionsDir);
    writeFileSync(vocabularyPoolPath(sessionsDir), JSON.stringify({ ...pool, words: pool.words.filter((w: { surface: string }) => w.surface !== surface) }));
  };

  it.effect("会議中に forget して、そのセッションでは話されなかった語は、終了時にも溜まりへ戻らない（消した語は覚えない）", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, spokeOnlyKounan);

      const second = yield* runSession(sessionsDir, ({ dir }) => Effect.gen(function* () {
        yield* awaitVocabLines(dir, 1);
        forgetFromFile(sessionsDir, "港南店");
      }));

      expect(vocabLines(second)).toHaveLength(1); // 今のセッションの語彙はそのまま
      expect(readPool(sessionsDir)).toEqual({ sessions: 2, words: [] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("溜まりのファイルが壊れていても、セッションは止まらず（発言は残り、書き出しも通る）、警告を 1 行以上出し、語彙には何も入れない", () => {
    const { layer } = layerWith();
    const warned = collectingConsole();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      writeFileSync(vocabularyPoolPath(sessionsDir), "{壊れた");
      const dir = yield* runSession(sessionsDir, ({ sink }) => sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words }));
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["江南店に行きます"]);
      expect(vocabLines(dir)).toEqual([]);
      expect(existsSync(join(dir, "export.json"))).toBe(true);
      expect(warned.errors.length).toBeGreaterThan(0);
    }).pipe(Effect.provideService(Console.Console, warned.service), Effect.provide(layer));
  });
});
