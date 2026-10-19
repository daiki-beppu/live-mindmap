import { defaultClaude } from "../src/modelSelection.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { MapCapture } from "../src/capture.ts";
import { DiffUpdatePaused, DiffUpdater, REVIEW_LOG_ELEMENT_ID, SETTLE_QUIET_MS, type DiffInput, type Snapshot, type CaptionsFrame } from "../src/core/index.ts";
import { ReviewBuild } from "../src/review.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { vocabularyPoolPath } from "../src/vocabularyPool.ts";
import { SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { fakeReadings } from "./fixtures/readings.ts";
import { collectingConsole, failingBuild, failingCapture, FAKE_TEMPLATE, fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// Issue #240 段 3（ADR 0008）→ Issue #243 段 6: SessionSinks の実物 Layer を、実 tmpdir + 偽の DiffUpdater／capture で確かめる。
// updater・ログ・いま話している文字・書き出しを開く契約（CT-SINK-SCOPE）と、録音ファイル名の採番（要件117,127）
// がこのファイルの対象。段 6 で、SessionSinks は新しいセッション（makeSession）を直接使う。
// 1 秒の途中結果（SETTLE_QUIET_MS）の待ちは、音声の時刻（後続の結果の end）で進める（壁時計では進まない。本物の時間では待たない）。
//
// 想定する契約（server/src/sessionSinks.ts）:
// - `SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer }) })` が実物の Layer を作る。撮影・見返し用の HTML のビルド・mix・FileSystem は Layer の文脈から受け取る（テストの sinksLayer が偽物を渡す）。
//   updaterLayer は core の Service DiffUpdater を作る Layer で、セッションごとに Layer.build(Layer.fresh(...)) して使う
// - `createDir(sessionsDir)` がセッションのフォルダを作る（失敗すれば以後 open を呼ばない。要件3の前提）
// - `open({ dir, title, publish, speak })` がセッションの Scope の中で 1 回呼ばれ、updater をそのセッションの Scope で開き、
//   `SessionSink`（partial・final・drain・clearSpeaking・stopRelays・appendLog・flush・exports・audioFileNames）を返す。
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
// 時間を進める前後の待ち（settle・settleUntil）は、実行中のファイル操作が終わるまで実時間で待つ（trackedFileSystem）
const fileIo = trackedFileSystem();
const { settle, settleUntil } = fileIo;
const sinksLayer = ({ updaterLayer, ...services }: { updaterLayer: Layer.Layer<DiffUpdater> } & ExportServicesOptions) =>
  SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer }) }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer, ...services })));

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
  it.effect("準備で取得する推論子はサービス構築時ではなく準備を呼ぶ Scope で閉じる", () => Effect.gen(function* () {
    const state = { opened: 0, closed: 0 };
    const sinks = yield* SessionSinks.pipe(Effect.provide(SessionSinks.layer({
      prepareUpdater: () => Effect.acquireRelease(
        Effect.sync(() => {
          state.opened++;
          return { layer: Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) })) };
        }),
        () => Effect.sync(() => { state.closed++; }),
      ),
    }).pipe(Layer.provide(fakeExportServices()))));
    for (let attempt = 1; attempt <= 2; attempt++) {
      const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
      yield* Scope.provide(sinks.prepare({ kind: "single", model: defaultClaude }), scope);
      expect(state).toMatchObject({ opened: attempt, closed: attempt - 1 });
      yield* Scope.close(scope, Exit.void);
      expect(state).toMatchObject({ opened: attempt, closed: attempt });
    }
  }));

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
      const sink = yield* sinks.open({ dir, title: "終了", model: defaultClaude, updaterLayer, diffUpdate: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void, publish: (s) => Effect.sync(() => { published.push(s); }) });
      yield* sink.speaker(SPEAKER_OFF);
      for (const n of [1, 2]) yield* sink.final({ track: "相手", start: n, end: n + 1, text: `発言${n}` });
      yield* sink.drain;
      yield* sink.flush;
      expect(calls).toBe(1);
      const beforeLog = readFileSync(join(dir, "log.jsonl"), "utf8");
      const beforeExport = readFileSync(join(dir, "export.json"), "utf8");
      expect(beforeLog).toContain("diff-update-paused");
      yield* sink.exports;
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
        sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void }),
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

  it.effect("発言の ID はセッションにつき 1 つのクロージャで、r1 から順に増える（要件125）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);

      yield* sink.final({ track: "相手", start: 0, end: 1, text: "ひとつめ" });
      yield* sink.final({ track: "自分", start: 2, end: 3, text: "ふたつめ" });
      yield* sink.flush;

      const log = yield* Effect.sync(() => readFileSync(join(dir, "log.jsonl"), "utf8"));
      const remarkIds = log.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).filter((e) => e.type === "remark").map((e) => e.remark.id);
      expect(remarkIds).toEqual(["r1", "r2"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  // Issue #438: 画像の ID は s1 から順に増え、image: null は数えない（null を挟んでも次の画像は s2）
  it.effect("画像の ID は s1 から順に増え、image: null は数えない", () => {
    const inputs: DiffInput[] = [];
    const updaterLayer = Layer.succeed(
      DiffUpdater,
      DiffUpdater.of({ update: (input) => Effect.sync(() => { inputs.push(input); return { ops: [] }; }) }),
    );
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);

      yield* sink.screen({ start: 1, image: new Uint8Array([0xff, 0xd8, 0xff, 0x01]) });
      yield* sink.screen({ start: 2, image: null });
      yield* sink.screen({ start: 12, image: new Uint8Array([0xff, 0xd8, 0xff, 0x02]) });
      yield* sink.final({ track: "相手", start: 13, end: 14, text: "採用" });
      yield* sink.flush;

      const ids = inputs.flatMap((input) => input.screens ?? []).map((c) => c.image?.id ?? null);
      expect(ids).toEqual(["s1", null, "s2"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });

      yield* sink.speaker({ type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 1, final: false });
      yield* sink.final({ track: "相手", start: 3, end: 4, text: "採用" });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true });
      yield* sink.speaker({ type: "speaker-off", start: 9, reason: "読み込みに失敗" });
      yield* sink.speaker({ type: "speaker-mixed", track: "相手", slot: 1, start: 95.5 });
      yield* sink.speaker({ type: "speaker-centroid", track: "相手", slot: 1, centroid: [0.25, -0.5, 1] });
      yield* sink.speakersRenumbered;
      yield* sink.speaker({ type: "speaker-centroid", track: "相手", slot: 1, centroid: [3, 2, 1] });
      yield* sink.flush;

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

  it.effect("exports は書き出した 5 パスを返す（4 つ目が map.png、5 つ目が map.html）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      const paths = yield* sink.exports;

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html"]);
      for (const path of paths) expect(existsSync(path)).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  it.effect("録音（相手.m4a・自分.m4a）があるセッションの exports は 6 パスを返し、map.html の後に map-audio.html が並ぶ。map-audio.html には mix の出力が入る", () => {
    const mix = fakeAudioMix();
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;
      writeFileSync(join(dir, "相手.m4a"), "録音");
      writeFileSync(join(dir, "自分.m4a"), "録音");

      const paths = yield* sink.exports;

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html", "map-audio.html"]);
      expect(mix.calls.map((c) => c.session)).toEqual([dir]);
      expect(embeddedAudio(readFileSync(join(dir, "map-audio.html"), "utf8"))).toEqual(FAKE_MIX_BYTES);
      expect(embeddedAudio(readFileSync(join(dir, "map.html"), "utf8"))).toBeNull();
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, mix })));
  });

  it.effect("録音が無いセッションの exports は 5 パスだけで、mix を呼ばず、標準エラーに map-audio の理由を出さない", () => {
    const mix = fakeAudioMix();
    return Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths).toHaveLength(5);
      expect(mix.calls).toEqual([]);
      expect(existsSync(join(dir, "map-audio.html"))).toBe(false);
      expect(warnings.errors.join("")).not.toContain("map-audio");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, mix })));
  });

  it.effect("mix が失敗しても exports は map.html までの 5 パスを返し、標準エラーに「map-audio.html を書き出せませんでした: <理由>」を残す", () => {
    const mix = fakeAudioMix();
    return Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;
      writeFileSync(join(dir, "相手.m4a"), "録音");
      mix.failure.reason = "録音を混ぜられない";

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html"]);
      expect(existsSync(join(dir, "map-audio.html"))).toBe(false);
      expect(warnings.errors.some((s) => s.includes("map-audio.html を書き出せませんでした: 録音を混ぜられない"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, mix })));
  });

  it.effect("撮影が失敗しても exports は map.html を含む 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.html"]);
      expect(existsSync(join(dir, "map.png"))).toBe(false);
      expect(warnings.errors.some((s) => s.includes("map.png を書き出せませんでした: 撮影に失敗"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, capture: failingCapture() }))));

  it.effect("map.html の書き出しが失敗しても exports はほかの 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png"]);
      expect(existsSync(join(dir, "map.html"))).toBe(false);
      expect(warnings.errors.some((s) => s.includes("map.html を書き出せませんでした: ビルドに失敗"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: failingBuild() }))));

  const openWithRemark = Effect.gen(function* () {
    const sessionsDir = yield* withTmpSessionsDir();
    const sinks = yield* SessionSinks;
    const dir = yield* sinks.createDir(sessionsDir);
    const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
    yield* sink.speaker(SPEAKER_OFF);
    yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
    yield* sink.flush;
    return { dir, sink };
  });
  const fileNames = (paths: readonly string[]) => paths.map((p) => p.split("/").pop());

  it.effect("撮影の後始末が defect で失敗しても、exports は map.html を含む 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

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

  it.effect("map.html のビルドが defect で失敗しても、exports はほかの 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { dir, sink } = yield* openWithRemark;

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

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

      const exit = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service), Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(warnings.errors).toEqual([]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, capture: () => Effect.interrupt }))));

  it.effect("サーバーの警告は、撮影の失敗の理由の改行を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(warnings.errors).toHaveLength(1);
      expect(warnings.errors[0]).toContain("map.png を書き出せませんでした: 撮影に失敗\n詳細");
      expect(warnings.errors[0]).not.toContain("pnpm cli install");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, capture: failingCapture("撮影に失敗\n詳細") }))));

  it.effect("サーバーの警告は、map.html の失敗の理由の改行を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(warnings.errors).toContain("map.html を書き出せませんでした: ビルドに失敗\n詳細");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: failingBuild("ビルドに失敗\n詳細") }))));

  it.effect("撮影・HTML のビルド・mix の Service は Layer を作るときに 1 回だけ受け取り、exports のたびに作り直さない", () => {
    const state = { captureBuilt: 0, captured: 0 };
    const countingCapture = Layer.effect(MapCapture)(
      Effect.sync(() => {
        state.captureBuilt++;
        return MapCapture.of({
          capture: (_snapshot, path) =>
            Effect.sync(() => {
              state.captured++;
              writeFileSync(path, "");
            }),
        });
      }),
    );
    const services = Layer.mergeAll(
      countingCapture,
      Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(FAKE_TEMPLATE) })),
      fakeAudioMix().layer,
      fakeReadings().layer,
    ).pipe(Layer.provideMerge(NodeFileSystem.layer));
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      expect(state).toEqual({ captureBuilt: 1, captured: 0 }); // 開いた時点で受け取り済み

      yield* sink.exports;
      yield* sink.exports;

      expect(state).toEqual({ captureBuilt: 1, captured: 2 });
    })).pipe(Effect.provide(SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: makeFakeUpdater().updaterLayer }) }).pipe(Layer.provide(services))));
  });

  it.effect("テキストの 3 形式を書けないときは、失敗の値ではなく defect になる（撮影・HTML の失敗のように諦めない）", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      rmSync(dir, { recursive: true, force: true }); // 書き先のフォルダが無くなる

      const exit = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service), Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true);
      expect(warnings.errors).toEqual([]); // 諦めた警告ではない
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  it.effect("exports で書く map.html には、そのセッションの log.jsonl の出来事がそのまま埋め込まれる", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      yield* sink.exports;

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
      const noop = { publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void };

      const firstScope = yield* Scope.make();
      const first = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "一つ目", ...noop }), firstScope);
      yield* first.speaker(SPEAKER_OFF);
      expect(state).toMatchObject({ opened: 1, closed: 0 });
      yield* first.final({ track: "相手", start: 0, end: 1, text: "ひとつめの発言" });
      yield* first.flush; // 1 つ目の updater で差分更新が呼ばれる
      yield* Scope.close(firstScope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5))); // フォルダ名は開始時刻（実時間のミリ秒）
      const secondScope = yield* Scope.make();
      const second = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "二つ目", ...noop }), secondScope);
      yield* second.speaker(SPEAKER_OFF);
      expect(state).toMatchObject({ opened: 2, closed: 1 }); // 2 つ目は 1 つ目を使い回さず、新しく開く
      yield* second.final({ track: "相手", start: 0, end: 1, text: "ふたつめの発言" });
      yield* second.flush;
      yield* Scope.close(secondScope, Exit.void);

      expect(state).toMatchObject({ opened: 2, closed: 2 });
      expect(state.callIds).toEqual([1, 2]); // それぞれのセッションの差分更新は、そのセッションの updater（別の実体）が受けた
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  describe("録音ファイルの番号（audioFileNames。要件117,127）", () => {
    it.effect("1 回目の名前（相手.m4a・自分.m4a）は変えず、2 回目以降は -2・-3 の番号が付く", () =>
      Effect.scoped(Effect.gen(function* () {
        const sessionsDir = yield* withTmpSessionsDir();
        const sinks = yield* SessionSinks;
        const dir = yield* sinks.createDir(sessionsDir);
        const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });

        expect(sink.audioFileNames(1)).toEqual(["相手.m4a", "自分.m4a"]);
        expect(sink.audioFileNames(2)).toEqual(["相手-2.m4a", "自分-2.m4a"]);
        expect(sink.audioFileNames(3)).toEqual(["相手-3.m4a", "自分-3.m4a"]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));
  });
});

// 送った字幕のフレームの読み取り
const hasBubble = (speaks: readonly CaptionsFrame[], track: "相手" | "自分", text: string) => speaks.some((f) => f.bubbles.some((b) => b.track === track && b.text.includes(text)));
const lastTexts = (speaks: readonly CaptionsFrame[], track: "相手" | "自分") => speaks.at(-1)?.bubbles.filter((b) => b.track === track).map((b) => b.text);

// 公開したスナップショット・送った captions を記録する Sink の組み立て
const openRecordingSink = Effect.fn("openRecordingSink")(function* ({ speakerOff = true }: { speakerOff?: boolean } = {}) {
  const sessionsDir = yield* withTmpSessionsDir();
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(sessionsDir);
  const speaks: CaptionsFrame[] = [];
  const published: Snapshot[] = [];
  const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude,
    dir,
    title: "週次",
    publish: (snapshot) => Effect.sync(() => void published.push(snapshot)),
    speak: (frame) => Effect.sync(() => void speaks.push(frame)),
    speakerNames: () => Effect.void,
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
  it.effect("確定結果が来なくても、相手の途中結果は 1 秒更新されなければ、最後の本文・区間で発言が 1 件、差分更新に渡る。ID は r1 で、ログにも残る", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 7.5, text: "あしたの", duplicate: false });
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議は", duplicate: false });

      yield* sink.partial({ track: "自分", start: 0, end: 8 + (SETTLE_QUIET_MS - 1) / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める
      yield* settle;
      expect(logEvents(dir).filter((e) => e.type === "remark")).toEqual([]); // 1 秒の直前まではまだ発言にならない
      yield* sink.partial({ track: "自分", start: 0, end: 8 + SETTLE_QUIET_MS / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める // 音声の時刻で 1 秒更新されなかった: 発言になり、すぐ差分更新に渡る
      yield* settle;
      expect(logEvents(dir).filter((e) => e.type === "remark")).toHaveLength(1);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      expect(calls.flatMap((c) => c.fresh)[0]).toMatchObject({ id: "r1", track: "相手", start: 5, end: 8, text: "あしたの会議は" });

      yield* sink.drain;
      yield* sink.flush;
      expect(calls.flatMap((c) => c.fresh)).toHaveLength(1); // 終了処理で増えない
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議は"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("drain は、まだ出ていない発話を落とさない。途中結果の最後の本文が差分更新に渡る", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "とちゅうでとめた", duplicate: false });

      yield* sink.drain; // 時間は進めない（1 秒を待たずに発言にする）
      yield* sink.flush;

      expect(calls.flatMap((c) => c.fresh).map((u) => [u.id, u.text])).toEqual([["r1", "とちゅうでとめた"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("途中結果は captions として届く。重複の印の付いた自分の途中結果は出ず、印のないものは出る。stopRelays で空の並びになり、以後は送らない", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "はじまりの途中結果", duplicate: false });
      yield* sink.partial({ track: "自分", start: 1, end: 2, text: "もれたあいてのこえ", duplicate: true });
      yield* sink.partial({ track: "自分", start: 3, end: 4, text: "じぶんのこえ", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => hasBubble(speaks, "自分", "じぶんのこえ"));
      expect(hasBubble(speaks, "自分", "じぶんのこえ")).toBe(true);
      expect(speaks[0]).toMatchObject({ type: "captions", bubbles: [{ track: "相手", text: "はじまりの途中結果" }] });
      expect(hasBubble(speaks, "自分", "もれたあいてのこえ")).toBe(false);

      yield* sink.stopRelays;
      expect(speaks.at(-1)).toEqual({ type: "captions", bubbles: [] });
      const sent = speaks.length;
      yield* sink.partial({ track: "相手", start: 9, end: 10, text: "終了後の途中結果", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS + 100);
      yield* settle;
      expect(speaks).toHaveLength(sent);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("文字を送った後、途中結果が増えなくても、話者の区間の更新（speaker / speaker-settled）だけで字幕のラベルが替わる。id と文字は保たれる", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink({ speakerOff: false });
      yield* sink.partial({ track: "相手", start: 10, end: 12, text: "こんにちは", duplicate: false });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 0, final: false });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 12 });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.at(-1)?.bubbles[0]?.label === "仮");
      const first = speaks.at(-1)!.bubbles[0]!;
      expect(first).toMatchObject({ label: "仮", text: "こんにちは" });

      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 1, final: false });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 12 });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.at(-1)?.bubbles[0]?.speaker !== first.speaker);

      const next = speaks.at(-1)!;
      expect(next.bubbles).toHaveLength(1);
      expect(next.bubbles[0]).toMatchObject({ id: first.id, text: "こんにちは", label: "仮" });
      expect(next.bubbles[0]!.speaker).not.toBe(first.speaker);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("clearSpeaking は字幕を空の並びにするが、以後も途中結果を送れる", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "ひとつめ", duplicate: false });
      yield* settleUntil(() => hasBubble(speaks, "相手", "ひとつめ"));
      expect(hasBubble(speaks, "相手", "ひとつめ")).toBe(true);

      yield* sink.clearSpeaking;
      expect(speaks.at(-1)).toEqual({ type: "captions", bubbles: [] });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* sink.partial({ track: "相手", start: 4, end: 5, text: "ふたつめ", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => hasBubble(speaks, "相手", "ふたつめ"));
      expect(hasBubble(speaks, "相手", "ふたつめ")).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("発言が 1 件も来ないセッションでも、exports はそのセッションのマップ（空の会議ノード）を書き出す", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();

      const paths = yield* sink.exports;

      expect(paths).toHaveLength(5);
      expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).root).toMatchObject({ kind: "会議", text: "週次", children: [] });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  // base の server.heavy.test.ts の移動先
  it.effect("flush は最後の差分更新（r3 を含む）が終わるまで待ち、その後に Scope を閉じて updater を閉じる。閉じた後には呼ばれない（base:581）", () => {
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
      const sink = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void }), scope);
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final(finalRemark("相手", 1, 2, "ひとつめ"));
      yield* sink.final(finalRemark("自分", 3, 4, "ふたつめ"));
      yield* sink.final(finalRemark("相手", 5, 6, "みっつめ"));

      const flushing = yield* Effect.forkChild(sink.flush);
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(30); // r1 の反映、続けて（r1 の呼び出し中に届いた）r2+r3 のまとめの反映が、それぞれ 30 ms かかる
        yield* settle;
      }
      yield* Fiber.join(flushing);
      expect(state.calls).toEqual([["r1"], ["r2", "r3"]]); // flush が戻った時点で、3 件とも差分更新に渡っている。r1 はすぐ、r2・r3 は r1 の呼び出し中に届いたので 1 回にまとまる
      expect(state.closed).toBe(0);
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(100);
      yield* settle;

      expect(state).toMatchObject({ closed: 1, callsAfterClose: 0 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("反映前の確定した発言は、自分の captions にも出る（emit が relay.remark へつながる。base:301）", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      updateGate.gate = yield* Deferred.make<void>(); // 差分更新は呼ばれても返らない（反映前のまま）

      yield* sink.final(finalRemark("自分", 1, 2, "面接は何回にしますか"));
      yield* settleUntil(() => calls.length === 1);

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => hasBubble(speaks, "自分", "面接は何回にしますか"));
      expect(hasBubble(speaks, "自分", "面接は何回にしますか")).toBe(true);
      yield* Deferred.succeed(updateGate.gate, undefined);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
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
      yield* settleUntil(() => lastTexts(speaks, "相手")?.[0] === "採用の面接について");
      expect(lastTexts(speaks, "相手")).toEqual(["採用の面接について"]); // 反映前: 確定した発言の本文が出ている
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]); // 発言 1 件ですぐ呼ばれているが、まだ返っていない

      yield* Deferred.succeed(reply, undefined);
      yield* settleUntil(() => lastTexts(speaks, "相手")?.length === 0);
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
      const noop = { publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void };
      const firstDir = yield* sinks.createDir(sessionsDir);
      const first = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir: firstDir, title: "前", ...noop });
      yield* first.speaker(SPEAKER_OFF);
      yield* first.final(finalRemark("相手", 1, 2, "前の発言"));
      yield* first.flush;
      yield* first.exports;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      const secondDir = yield* sinks.createDir(sessionsDir);
      yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir: secondDir, title: "今", ...noop });

      expect(secondDir).not.toBe(firstDir);
      const exported = JSON.parse(readFileSync(join(secondDir, "export.json"), "utf8"));
      expect(JSON.stringify(exported)).toContain("今");
      expect(JSON.stringify(exported)).not.toContain("前の発言");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));
});

// Issue #639: 発言の語ごとの読み（words）を log.jsonl の remark の行に残す。
// 補正はしないので、直す前の本文（raw）は関所を通った後の本文（remark.text）と同じ。
// words は Remark に入れず、差分更新への入力・スナップショット・書き出しには載らない。words の無いイベントの行は今までと同じ
describe("SessionSinks（実物 Layer）: 発言の語ごとの読み（Issue #639）", () => {
  const word = (surface: string, location: number) => ({ surface, romaji: `r:${surface}`, location, length: surface.length });
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");

  it.effect("words 付きの確定結果は、log.jsonl の remark の行に直す前の本文（raw）と words が残る。remark 自体に words・raw は入らない", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      const words = [word("明日", 0), word("の", 2), word("会議", 3)];
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", words });
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].raw).toBe("明日の会議");
      expect(lines[0].words).toEqual(words);
      expect(lines[0].remark).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("words の無いイベントから作った発言の行は今までと同じ（raw・words のキーが無い）", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 2, text: "確定" });
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "途中", duplicate: false });
      yield* TestClock.adjust(SETTLE_QUIET_MS);
      yield* settle;
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(Object.keys(line).sort()).toEqual(["at", "remark", "type"].filter((k) => k in line));
      for (const line of lines) {
        expect(line).not.toHaveProperty("raw");
        expect(line).not.toHaveProperty("words");
      }
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("words は差分更新への入力・書き出しに載らない（Remark の契約は変わらない）", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", words: [word("明日", 0), word("の", 2), word("会議", 3)] });
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

      expect(calls.flatMap((c) => c.fresh)[0]).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
      expect(JSON.stringify(calls)).not.toContain("words");
      yield* sink.drain;
      yield* sink.flush;
      yield* sink.exports;
      expect(readFileSync(join(dir, "export.json"), "utf8")).not.toContain("\"words\"");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });
});

// Issue #1019: 語ごとの区間（wordTimes）を log.jsonl の remark の行に残す。
// wordTimes は Remark に入れず、差分更新への入力・スナップショット・書き出しには載らない。wordTimes の無いイベントの行は今までと同じ
describe("SessionSinks（実物 Layer）: 発言の語ごとの区間（Issue #1019）", () => {
  const span = (location: number, length: number, start: number, end: number) => ({ location, length, start, end });
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");

  it.effect("wordTimes 付きの確定結果は、log.jsonl の remark の行に wordTimes が残る。remark 自体には入らない", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      const wordTimes = [span(0, 2, 1, 1.5), span(2, 1, 1.5, 1.75), span(3, 2, 1.75, 3)];
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", wordTimes });
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].wordTimes).toEqual(wordTimes);
      expect(lines[0].remark).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // 字幕: 未反映の発言になっても、表示済みの文字は同じ id の吹き出しに残る（発言の語の時刻を、字幕の盤へ渡す）
  it.effect("途中結果で仮 A・仮 B に分かれて出た文字は、全文が 1 件の未反映の発言になっても、同じ id・同じ文字の 2 つの吹き出しのまま残り、反映後に消える", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink({ speakerOff: false });
      const wordTimes = [span(0, 6, 10, 12), span(6, 5, 12, 14)];
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 0, final: true });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 12, end: 14, slot: 1, final: false });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 12 });
      yield* sink.partial({ track: "相手", start: 10, end: 14, text: "こんにちは、ありがとう", wordTimes, duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.at(-1)?.bubbles.length === 2 && speaks.at(-1)!.bubbles.every((b) => b.label === "仮"));
      const shown = speaks.at(-1)!.bubbles.map((b) => [b.id, b.text]);
      expect(shown.map(([, text]) => text)).toEqual(["こんにちは、", "ありがとう"]);

      const reply = yield* Deferred.make<void>();
      updateGate.gate = reply; // 差分更新は呼ばれても返らない（発言が未反映のまま）
      yield* sink.final({ track: "相手", start: 10, end: 14, text: "こんにちは、ありがとう", wordTimes });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 14, slot: 0, final: true }); // 全文が 1 人の確定区間になる
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 14 });
      yield* settleUntil(() => calls.length === 1);
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settle;

      expect(speaks.at(-1)!.bubbles.map((b) => [b.id, b.text])).toEqual(shown);

      yield* Deferred.succeed(reply, undefined);
      yield* settleUntil(() => lastTexts(speaks, "相手")?.length === 0);
      expect(lastTexts(speaks, "相手")).toEqual([]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("wordTimes の無いイベントから作った発言の行には wordTimes のキーが無い", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 2, text: "確定" });
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "途中", duplicate: false });
      yield* TestClock.adjust(SETTLE_QUIET_MS);
      yield* settle;
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).not.toHaveProperty("wordTimes");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("wordTimes は差分更新への入力・書き出しに載らない（Remark の契約は変わらない）", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", wordTimes: [span(0, 5, 1, 3)] });
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

      expect(calls.flatMap((c) => c.fresh)[0]).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
      expect(JSON.stringify(calls)).not.toContain("wordTimes");
      yield* sink.drain;
      yield* sink.flush;
      yield* sink.exports;
      expect(readFileSync(join(dir, "export.json"), "utf8")).not.toContain("wordTimes");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });
});

// Issue #640: 利用者が足した語で発言を直す。
// SessionSink の addUserVocabulary(words) が、語を Readings（読みのサブコマンド）にまとめて 1 回渡して読みを作り、
// log.jsonl に vocab の行（表記・読み・出どころ user。読みが無い語は romaji: null）を書いてから、語彙に読みのある語を足す。
// 開始を待たせないため、読みは addUserVocabulary が返った後に非同期で作られる。
// 関所を通った後の本文を補正して発言にする（確定結果・1 秒更新されなかった途中結果・drain のどの出口でも）。途中結果（captions）は直さない。
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
  // 全デスクを使う（Zendesk の崩れ）
  const garbledZendesk = utterance(["全", "zen"], ["デスク", "desuku"], ["を", "wo"], ["使う", "tsukau"]);
  const garbledZendeskWithComma = utterance(["はい", "hai"], ["、", ""], ["全", "zen"], ["デスク", "desuku"], ["を", "wo"]);
  // 英字の語はモデルのカタカナの読みを読みのサブコマンドに渡してローマ字にする（Issue #642）
  const KATAKANA = { Zendesk: "ゼンデスク" };
  const READINGS = { 港南店: "kounanten", ゼンデスク: "zendesuku" };
  const vocabLines = (dir: string) => logEvents(dir).filter((e) => e.type === "vocab");
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");

  // vocab の行が見えても書き込み後の語彙更新はまだ終わっていないので、I/O の完了後にも譲る
  const openWithVocabulary = Effect.fn("openWithVocabulary")(function* (words: ReadonlyArray<string> = ["港南店", "Zendesk"]) {
    const opened = yield* openRecordingSink();
    yield* opened.sink.addUserVocabulary(words);
    yield* settleUntil(() => vocabLines(opened.dir).length === 1);
    yield* settle;
    return opened;
  });

  it.effect("崩れた確定結果は直った本文が発言になる。remark の行は text が直した本文で、raw が直す前の本文、words は直す前の本文の位置のまま。差分更新・字幕にも直った表記が渡る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, speaks } = yield* openWithVocabulary();
      const reply = yield* Deferred.make<void>();
      updateGate.gate = reply; // 差分更新は呼ばれても返らない（字幕が反映前の本文を出している間）
      yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.some((f) => f.bubbles.some((b) => b.text === "港南店に行きます")));
      yield* Deferred.succeed(reply, undefined);
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].remark).toMatchObject({ id: "r1", track: "相手", start: 1, end: 3, text: "港南店に行きます" });
      expect(lines[0].raw).toBe("江南店に行きます");
      expect(lines[0].words).toEqual(garbled.words);
      // 発言の行は、語彙に入った時点（vocab の行）より後ろに並ぶ
      const types = logEvents(dir).map((e) => e.type);
      expect(types.indexOf("remark")).toBeGreaterThan(types.indexOf("vocab"));
      expect(calls.flatMap((c) => c.fresh)[0]).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "港南店に行きます" });
      expect(speaks.some((f) => f.bubbles.some((b) => b.text === "港南店に行きます"))).toBe(true);
      expect(speaks.some((f) => f.bubbles.some((b) => b.text.includes("江南店")))).toBe(false); // 字幕に直す前の本文は出ない。印も付かない
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("語彙の補正で本文の長さが変わった未反映の発言でも、後ろの語の文字は後ろの吹き出しに残る（語の時刻の位置を、直した本文の位置へ付け替える）", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, speaks } = yield* openRecordingSink({ speakerOff: false });
      yield* sink.addUserVocabulary(["Zendesk"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      const text = "はい、全デスクを";
      const wordTimes = [{ location: 0, length: 3, start: 10, end: 12 }, { location: 3, length: 4, start: 12, end: 14 }, { location: 7, length: 1, start: 14, end: 15 }];
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 0, final: true });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 12, end: 14, slot: 1, final: true });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 14, end: 15, slot: 2, final: false });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 14 });
      yield* sink.partial({ track: "相手", start: 10, end: 15, text, wordTimes, duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.at(-1)?.bubbles.length === 3);
      const shown = speaks.at(-1)!.bubbles.map((b) => [b.id, b.text]);
      expect(shown.map(([, t]) => t)).toEqual(["はい、", "全デスク", "を"]);

      const reply = yield* Deferred.make<void>();
      updateGate.gate = reply;
      const { words } = garbledZendeskWithComma;
      yield* sink.final({ track: "相手", start: 10, end: 15, text, words, wordTimes });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 15, slot: 0, final: true });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 15 });
      yield* settleUntil(() => calls.length === 1);
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settle;

      expect(speaks.at(-1)!.bubbles.map((b) => [b.id, b.text])).toEqual([[shown[0]![0], "はい、"], [shown[1]![0], "Zendesk"], [shown[2]![0], "を"]]);
      yield* Deferred.succeed(reply, undefined);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("1 秒更新されなかった途中結果から作った発言と、drain で出す発言も直る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openWithVocabulary();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: garbled.text, words: garbled.words, duplicate: false });
      yield* sink.partial({ track: "自分", start: 0, end: 6 + SETTLE_QUIET_MS / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      expect(calls.flatMap((c) => c.fresh)[0]).toMatchObject({ id: "r1", text: "港南店に行きます" });

      yield* sink.partial({ track: "相手", start: 20, end: 21, text: garbledZendesk.text, words: garbledZendesk.words, duplicate: false });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir).map((e) => [e.remark.id, e.remark.text, e.raw])).toEqual([
        ["r1", "港南店に行きます", "江南店に行きます"],
        ["r2", "Zendeskを使う", "全デスクを使う"],
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("途中結果（いま話している文字）は直らない。語彙があっても、字幕には届いた本文がそのまま出る", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openWithVocabulary();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: garbled.text, words: garbled.words, duplicate: false });
      yield* settleUntil(() => speaks.some((f) => f.bubbles.some((b) => b.text === garbled.text)));

      expect(speaks.some((f) => f.bubbles.some((b) => b.text === "江南店に行きます"))).toBe(true);
      expect(speaks.some((f) => f.bubbles.some((b) => b.text.includes("港南店")))).toBe(false);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("語の読みができる前に締めた発言は直し直さない。読みができた後の発言は直り、先の発言の行は変わらない", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      readings.gate.current = yield* Deferred.make<void>();
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["港南店", "Zendesk"]); // 読みが返るまで待たずに返る
      yield* settle;
      expect(vocabLines(dir)).toEqual([]); // まだ読みができていない

      yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      yield* sink.drain;
      yield* sink.flush;
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["江南店に行きます"]);

      yield* Deferred.succeed(readings.gate.current, undefined);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 10, end: 12, text: garbled.text, words: garbled.words });
      yield* sink.drain;
      yield* sink.flush;

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
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words });
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* settleUntil(() => speaks.some((f) => f.bubbles.some((b) => b.text === "港南店に行きます")));
      yield* sink.drain;
      yield* sink.flush;

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

describe("SessionSinks（実物 Layer）: 録画の画面語彙の組み立て", () => {
  it.effect("画面を投入する前に読みを取得し画面のstartを補正のfromへ渡す", () => {
    const readings = fakeReadings({ 港南店: "kounanten" });
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* withTmpSessionsDir());
      const sink = yield* sinks.open({
        dir, title: "録画", model: defaultClaude, updaterLayer,
        diffUpdate: () => Effect.void, publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void,
        recorded: { realtime: false, selfTrack: false, progress: () => Effect.void, paused: () => Effect.void },
      });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.screen({ start: 6, image: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), lines: ["港南店"] });
      yield* settleUntil(() => logEvents(dir).some((e) => e.type === "vocab"));
      yield* settle;
      expect(readings.calls).toEqual([["港南店"]]);
      expect(logEvents(dir).filter((e) => e.type === "screen")).toEqual([]);
      const words = [{ surface: "江南", romaji: "kounan", location: 0, length: 2 }, { surface: "店", romaji: "ten", location: 2, length: 1 }];
      yield* sink.final({ track: "相手", start: 0, end: 2, text: "江南店", words });
      yield* sink.final({ track: "相手", start: 10, end: 12, text: "江南店", words });
      yield* sink.drain;
      yield* sink.finishBacklog;
      yield* sink.flush;
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => e.remark.text)).toEqual(["江南店", "港南店"]);
      expect(logEvents(dir).filter((e) => e.type === "screen").map((e) => e.start)).toEqual([6]);
    }).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });
});

// Issue #645: 過去のセッションの語彙を引き継ぐ。
// セッションの置き場（LIVE_MINDMAP_SESSIONS = createDir に渡す sessionsDir）の中に、全セッションをまたぐ溜まりのファイルを 1 つ置く。
// 開始（open）で溜まりの語を読みごと vocab の行（出どころ carried）として語彙に入れ（読みは作り直さない）、
// 終了（exports）で、直した後の発言に出た語と利用者が足した語を溜まりへ入れ、共有画面に映っただけの語は入れない。
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
  const runSession = Effect.fn("runSession")(function* (sessionsDir: string, script: (context: Context) => Effect.Effect<void>, options: { exports?: boolean } = {}) {
    // セッションのフォルダ名は開始時刻（ミリ秒）。続けて開いても重ならないよう実時間で少し待つ
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 3)));
    return yield* Effect.scoped(Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* script({ sink, dir });
      yield* sink.drain;
      yield* sink.flush;
      yield* settle;
      if (options.exports !== false) yield* sink.exports;
      return dir;
    }));
  });

  const showScreen = (sink: Sink, start: number, lines: ReadonlyArray<string>) => sink.screen({ start, image: jpeg, lines });
  // 画面に映った語が語彙に入る（vocab の行が n 行になる）まで待つ
  const awaitVocabLines = (dir: string, n: number) => settleUntil(() => existsSync(join(dir, "log.jsonl")) && vocabLines(dir).length === n);

  // 港南店と Zendesk が画面に映り、港南店だけが話される（Zendesk は映っただけ）
  const spokeOnlyKounan = ({ sink, dir }: Context) =>
    Effect.gen(function* () {
      yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
      yield* awaitVocabLines(dir, 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 2, end: 4, text: correct.text, words: correct.words });
    });
  const layerWith = (readings = fakeReadings(READINGS)) => ({ readings, layer: sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer, readings }) });

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

  it.effect("読み取得の途中で停止（exports）してもvocabを書き終えてから新しい語を溜まりへ入れる", () => {
    const { readings, layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, spokeOnlyKounan);
      expect(readPool(sessionsDir).words[0]).toMatchObject({ surface: "港南店", source: "spoken" });

      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* awaitVocabLines(dir, 1);
        readings.gate.current = yield* Deferred.make<void>(); // 読みの取得を保留する
        yield* sink.addUserVocabulary(["葛西"]);
        yield* settleUntil(() => readings.calls.some((c) => c.includes("葛西")));
        expect(readings.calls.at(-1)).toEqual(["葛西"]);
        yield* sink.drain;
        yield* sink.flush;
        const started = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const stopping = yield* Effect.forkChild(Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* sink.exports;
          yield* Deferred.succeed(finished, undefined);
        }));
        yield* Deferred.await(started);
        yield* settle;
        expect(vocabLines(dir)).toHaveLength(1); // 足した語の記録はまだ無い
        expect(readPool(sessionsDir).words[0]).toMatchObject({ source: "spoken" }); // 溜まりは記録を待っている
        expect(readPool(sessionsDir).words.map((w: { surface: string }) => w.surface)).toEqual(["港南店"]);
        expect(yield* Deferred.isDone(finished)).toBe(false);
        yield* Deferred.succeed(readings.gate.current, undefined);
        yield* Fiber.join(stopping);
        expect(vocabLines(dir).flatMap((e) => e.words)).toContainEqual({ surface: "葛西", romaji: "kasai", source: "user" });
      }), { exports: false });

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

// Issue #1021: 相手の発言の話者。実物の SessionSink に、ヘルパーの speaker / speaker-off と発言を流して確かめる。
// 発言を締める時計と同じく、3 秒の待ちも音声の時刻（届いた結果の end）で進める。壁時計（TestClock）では進まない。
// 秒の値は、ミリ秒に直したとき端数が出ない値にそろえる（14.999 × 1000 = 14999、15 × 1000 = 15000）
describe("SessionSink: 相手の発言の話者を決める（Issue #1021）", () => {
  const segment = (slot: number, start: number, end: number) => ({ type: "speaker", track: "相手", start, end, slot, final: true }) as const;
  const settledAt = (to: number) => ({ type: "speaker-settled", track: "相手", to }) as const;
  const open = () => openRecordingSink({ speakerOff: false });
  type Sink = Effect.Success<ReturnType<typeof openRecordingSink>>["sink"];
  // 自分の途中結果は発言にならず、音声の時計だけを進める
  const loggedRemarks = (dir: string) => logEvents(dir).filter((e) => e.type === "remark").map((e) => e.remark);
  const brief = (dir: string) => loggedRemarks(dir).map((r) => [r.id, r.speaker, r.text]);

  describe("確定を待って出す", () => {
    it.effect("確定した区間が発言の終わりまで揃うと、ラベルを付けて出る。log.jsonl の行にも差分更新への入力にも同じ話者が載る", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.final(finalRemark("相手", 10, 12, "来週に開催します"));
        yield* sink.speaker(segment(2, 10, 11.5));
        yield* sink.speaker(settledAt(11.5));
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]); // 終わり（12 秒）まで確定していない
        expect(calls).toEqual([]);

        yield* sink.speaker(segment(2, 11.5, 12)); // 区間の end が発言の end に届いても、位置が届くまでは出さない
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]);

        yield* sink.speaker(settledAt(12));
        yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

        const expected = { id: "r1", track: "相手", start: 10, end: 12, text: "来週に開催します", speaker: "相手 A" };
        expect(loggedRemarks(dir)).toEqual([expected]);
        expect(calls.flatMap((c) => c.fresh)).toEqual([expected]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

  });

  describe("話者が替わったところで切る", () => {
    it.effect("1 つの確定結果が 2 人分に切れると r1・r2 になり、次の発言は r3 になる（番号が重ならず飛ばない）。差分更新にも同じ ID・話者で渡る", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(3, 10, 11));
        yield* sink.speaker(segment(1, 11, 14));
        yield* sink.speaker(settledAt(14));
        yield* sink.final({
          track: "相手", start: 10, end: 14, text: "はい、ありがとう",
          wordTimes: [{ location: 0, length: 3, start: 10, end: 11 }, { location: 3, length: 5, start: 11, end: 14 }],
        });
        yield* sink.speaker(segment(1, 20, 22));
        yield* sink.speaker(settledAt(22));
        yield* sink.final(finalRemark("相手", 20, 22, "つぎ"));
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        expect(loggedRemarks(dir).map((r) => [r.id, r.speaker, r.text, r.start, r.end])).toEqual([
          ["r1", "相手 A", "はい、", 10, 11],
          ["r2", "相手 B", "ありがとう", 11, 14],
          ["r3", "相手 B", "つぎ", 20, 22],
        ]);
        // r1「はい、」はフィラーだけで中身がないので、ログには残るが差分更新には渡らない（hasContent）
        expect(calls.flatMap((c) => c.fresh).map((r) => [r.id, r.speaker])).toEqual([["r2", "相手 B"], ["r3", "相手 B"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });

  // Issue #1025: ヘルパーを起動し直すと Sortformer の枠は振り直される。SessionSink は起動し直しをまたいで同じもの。
  // 起動し直しは sink.speakersRenumbered で起こし、同じ sink の上で「起動し直す前 → 起動し直し → 起動し直した後」を一続きに見る
  describe("起動し直しをまたいだ話者のつなぎ直し（speaker-centroid。Issue #1025）", () => {
    const centroid = (slot: number, vector: readonly number[]) => ({ type: "speaker-centroid", track: "相手", slot, centroid: [...vector] }) as const;
    const A = [1, 0, 0];
    const B = [0, 1, 0];
    const NEAR_A = [0.95, Math.sqrt(1 - 0.95 ** 2), 0];

    // 1 回目のヘルパー: 枠 0 が 相手 A（10〜13）、枠 1 が 相手 B（13〜16）。重心は区間と同じ更新で届く
    const firstRun = (sink: Sink) =>
      Effect.gen(function* () {
        yield* sink.speaker(segment(0, 10, 13));
        yield* sink.speaker(centroid(0, A));
        yield* sink.speaker(segment(1, 13, 16));
        yield* sink.speaker(centroid(1, B));
        yield* sink.speaker(settledAt(16));
        yield* sink.final(finalRemark("相手", 10, 13, "ひとつめ"));
        yield* sink.final(finalRemark("相手", 13, 16, "ふたつめ"));
        yield* settle;
      });
    // 起動し直した後の、ある枠の発言（[start, start + 3] を話した）
    const speak = (sink: Sink, slot: number, start: number, text: string) =>
      Effect.gen(function* () {
        yield* sink.speaker(segment(slot, start, start + 3));
        yield* sink.speaker(settledAt(start + 3));
        yield* sink.final(finalRemark("相手", start, start + 3, text));
        yield* settle;
      });
    const finish = (sink: Sink) =>
      Effect.gen(function* () {
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;
      });

    it.effect("起動し直したとき、まだ揃っていない保留の発言は話者なしで出て、新しい世代の区間は前の世代の区間と混ざらない", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.final(finalRemark("相手", 20, 22, "揃う前に起動し直し")); // 区間が揃っていない
        yield* settle;
        expect(brief(dir)).toHaveLength(2);

        yield* sink.speakersRenumbered;
        yield* settle;
        expect(brief(dir).slice(2)).toEqual([["r3", undefined, "揃う前に起動し直し"]]);

        yield* sink.speaker(centroid(0, NEAR_A));
        yield* speak(sink, 0, 30, "新しい世代");
        yield* finish(sink);
        expect(brief(dir).slice(3)).toEqual([["r4", "相手 A", "新しい世代"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });
});
