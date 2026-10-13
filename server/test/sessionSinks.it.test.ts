import { defaultClaude } from "../src/modelSelection.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { MapCapture } from "../src/capture.ts";
import { DiffUpdatePaused, DiffUpdater, QUIET_MS, REVIEW_LOG_ELEMENT_ID, SETTLE_QUIET_MS, type DiffInput, type Snapshot, type SpeakingFrame } from "../src/core/index.ts";
import { ReviewBuild } from "../src/review.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { POOL_DROP_AFTER_SESSIONS } from "../src/core/vocabularyPool.ts";
import { vocabularyPoolPath } from "../src/vocabularyPool.ts";
import { SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { fakeReadings } from "./fixtures/readings.ts";
import { collectingConsole, failingBuild, failingCapture, FAKE_TEMPLATE, fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// Issue #240 段 3（ADR 0008）→ Issue #243 段 6: SessionSinks の実物 Layer を、実 tmpdir + 偽の DiffUpdater／capture で確かめる。
// updater・ログ・いま話している文字・書き出しを開く契約（CT-SINK-SCOPE）と、録音ファイル名の採番（要件117,127）
// がこのファイルの対象。段 6 で、SessionSinks は新しいセッション（makeSession）を直接使う。
// 1 秒の途中結果（SETTLE_QUIET_MS）と QUIET_MS の待ちは TestClock で進める（本物の時間では待たない）。
//
// 想定する契約（server/src/sessionSinks.ts）:
// - `SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer) })` が実物の Layer を作る。撮影・見返し用の HTML のビルド・mix・FileSystem は Layer の文脈から受け取る（テストの sinksLayer が偽物を渡す）。
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
  SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer) }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer, ...services })));

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
          return Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) }));
        }),
        () => Effect.sync(() => { state.closed++; }),
      ),
    }).pipe(Layer.provide(fakeExportServices()))));
    for (let attempt = 1; attempt <= 2; attempt++) {
      const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
      yield* Scope.provide(sinks.prepare(defaultClaude), scope);
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
      const sink = yield* sinks.open({ dir, title: "終了", model: defaultClaude, updaterLayer, diffUpdate: () => Effect.void, speak: () => Effect.void, publish: (s) => Effect.sync(() => { published.push(s); }) });
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
        sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }),
        scope,
      );
      expect(state).toMatchObject({ opened: 1, closed: 0 });

      yield* Scope.close(scope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // TestClock の時刻は 1970 年。Clock に従う書き方に替えると、フォルダ名と at が 1970 年になって落ちる
  it.effect("フォルダ名の時刻と log.jsonl の at は、TestClock の下でも実時刻（Clock に従わない）", () => {
    const { updaterLayer } = makeFakeUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const before = Date.now();
      const dir = yield* sinks.createDir(sessionsDir);
      const folderTime = Date.parse(basename(dir).replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3"));
      expect(folderTime).toBeGreaterThanOrEqual(before);
      expect(folderTime).toBeLessThanOrEqual(Date.now());

      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
      const beforeLog = Date.now();
      yield* sink.appendLog({ type: "intake-restarted", trigger: "auto" });
      yield* sink.flush;
      yield* settleUntil(() => existsSync(join(dir, "log.jsonl")) && readFileSync(join(dir, "log.jsonl"), "utf8").includes("intake-restarted"));
      const entry = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).find((e) => e.type === "intake-restarted");
      const at = Date.parse(entry.at);
      expect(at).toBeGreaterThanOrEqual(beforeLog);
      expect(at).toBeLessThanOrEqual(Date.now());
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

      yield* sink.final({ track: "相手", start: 0, end: 1, text: "ひとつめ" });
      yield* sink.final({ track: "自分", start: 2, end: 3, text: "ふたつめ" });
      yield* sink.flush;

      const log = yield* Effect.sync(() => readFileSync(join(dir, "log.jsonl"), "utf8"));
      const remarkIds = log.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).filter((e) => e.type === "remark").map((e) => e.remark.id);
      expect(remarkIds).toEqual(["r1", "r2"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  // 実物の SessionSink.screen が、画像ありと「なし」（image: null）のどちらも Session.pushScreen へ渡し、
  // log.jsonl の screen の行と差分更新の入力（screens）に同じ start・null が届く
  it.effect("screen は画像ありも image: null も pushScreen へ渡り、log.jsonl と差分更新の入力に start・null のまま届く", () => {
    const inputs: DiffInput[] = [];
    const updaterLayer = Layer.succeed(
      DiffUpdater,
      DiffUpdater.of({
        update: (input) =>
          Effect.sync(() => {
            inputs.push(input);
            return { ops: [] };
          }),
      }),
    );
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

      yield* sink.screen({ start: 1, image: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) });
      yield* sink.screen({ start: 2.5, image: null });
      yield* sink.final({ track: "相手", start: 3, end: 4, text: "採用" });
      yield* sink.flush;

      const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
      const screens = log.filter((e) => e.type === "screen");
      expect(screens).toHaveLength(2);
      expect(screens[0]).toMatchObject({ start: 1 });
      expect(typeof screens[0].image).toBe("string");
      expect(screens[1]).toMatchObject({ type: "screen", start: 2.5, image: null });
      expect(inputs.flatMap((input) => input.screens ?? []).map((c) => [c.start, c.image === null ? null : [...c.image.bytes]])).toEqual([
        [1, [0xff, 0xd8, 0xff, 0x00]],
        [2.5, null],
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("images:false のモデルを渡しても screen は保存され、発言だけが updater に届く（Issue #665）", () => {
    const inputs: DiffInput[] = [];
    const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({
      update: (input) => Effect.sync(() => { inputs.push(input); return { ops: [] }; }),
    }));
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const model = { ...defaultClaude, images: false };
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(model), model, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x80]);

      yield* sink.screen({ start: 1, image: bytes });
      yield* sink.screen({ start: 2, image: null });
      yield* sink.final({ track: "相手", start: 3, end: 4, text: "採用について" });
      yield* sink.flush;

      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.fresh.map((r) => r.text)).toEqual(["採用について"]);
      const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const screens = log.filter((e) => e.type === "screen");
      expect(screens).toHaveLength(2);
      expect(screens[0]).toMatchObject({ start: 1, image: expect.any(String) });
      expect(new Uint8Array(readFileSync(join(dir, "screens", screens[0].image)))).toEqual(bytes);
      expect(screens[1]).toMatchObject({ start: 2, image: null });
      expect("screens" in inputs[0]!).toBe(false);
      expect("previousScreens" in inputs[0]!).toBe(false);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

      yield* sink.screen({ start: 1, image: new Uint8Array([0xff, 0xd8, 0xff, 0x01]) });
      yield* sink.screen({ start: 2, image: null });
      yield* sink.screen({ start: 3, image: new Uint8Array([0xff, 0xd8, 0xff, 0x02]) });
      yield* sink.final({ track: "相手", start: 4, end: 5, text: "採用" });
      yield* sink.flush;

      const ids = inputs.flatMap((input) => input.screens ?? []).map((c) => c.image?.id ?? null);
      expect(ids).toEqual(["s1", null, "s2"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // Issue #280: 実物の SessionSink.screenOff は Session.pushScreenOff へ渡り、受け取った start・reason のまま log.jsonl に 1 行ずつ書く。
  // 差分更新の入力には screen-off が載らない
  it.effect("screenOff は start と reason のまま log.jsonl に受け取った順で書かれ、差分更新の入力に載らない", () => {
    const inputs: DiffInput[] = [];
    const updaterLayer = Layer.succeed(
      DiffUpdater,
      DiffUpdater.of({ update: (input) => Effect.sync(() => { inputs.push(input); return { ops: [] }; }) }),
    );
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

      yield* sink.screenOff({ start: 0, reason: "指定" });
      yield* sink.final({ track: "相手", start: 3, end: 4, text: "採用" });
      yield* sink.screenOff({ start: 7.5, reason: "許可なし" });
      yield* sink.final({ track: "相手", start: 5, end: 6, text: "面接" });
      yield* sink.flush;

      const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
      expect(log.filter((e) => e.type === "screen-off").map(({ type, start, reason }) => ({ type, start, reason }))).toEqual([
        { type: "screen-off", start: 0, reason: "指定" },
        { type: "screen-off", start: 7.5, reason: "許可なし" },
      ]);
      expect(log.map((e) => e.type).filter((t) => t === "start" || t === "screen-off" || t === "remark")).toEqual(["start", "screen-off", "remark", "screen-off", "remark"]);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) expect(input.screens ?? []).toEqual([]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("exports は書き出した 5 パスを返す（4 つ目が map.png、5 つ目が map.html）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
    const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
      expect(state).toEqual({ captureBuilt: 1, captured: 0 }); // 開いた時点で受け取り済み

      yield* sink.exports;
      yield* sink.exports;

      expect(state).toEqual({ captureBuilt: 1, captured: 2 });
    })).pipe(Effect.provide(SessionSinks.layer({ prepareUpdater: () => Effect.succeed(makeFakeUpdater().updaterLayer) }).pipe(Layer.provide(services))));
  });

  it.effect("テキストの 3 形式を書けないときは、失敗の値ではなく defect になる（撮影・HTML の失敗のように諦めない）", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const noop = { publish: () => Effect.void, speak: () => Effect.void };

      const firstScope = yield* Scope.make();
      const first = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "一つ目", ...noop }), firstScope);
      expect(state).toMatchObject({ opened: 1, closed: 0 });
      yield* first.final({ track: "相手", start: 0, end: 1, text: "ひとつめの発言" });
      yield* first.flush; // 1 つ目の updater で差分更新が呼ばれる
      yield* Scope.close(firstScope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5))); // フォルダ名は開始時刻（実時間のミリ秒）
      const secondScope = yield* Scope.make();
      const second = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "二つ目", ...noop }), secondScope);
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
        const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

        expect(sink.audioFileNames(1)).toEqual(["相手.m4a", "自分.m4a"]);
        expect(sink.audioFileNames(2)).toEqual(["相手-2.m4a", "自分-2.m4a"]);
        expect(sink.audioFileNames(3)).toEqual(["相手-3.m4a", "自分-3.m4a"]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));
  });
});

// 公開したスナップショット・送った speaking を記録する Sink の組み立て
const openRecordingSink = Effect.fn("openRecordingSink")(function* () {
  const sessionsDir = yield* withTmpSessionsDir();
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(sessionsDir);
  const speaks: SpeakingFrame[] = [];
  const published: Snapshot[] = [];
  const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude,
    dir,
    title: "週次",
    publish: (snapshot) => Effect.sync(() => void published.push(snapshot)),
    speak: (frame) => Effect.sync(() => void speaks.push(frame)),
  });
  return { sink, dir, speaks, published };
});

// 差分更新に渡った入力を記録する偽の DiffUpdater の Layer。
// katakana（英字の語のカタカナの読み。Issue #642）は、table の語だけ答える。呼び出しごとの引数を katakanaCalls に記録する。
// katakana.failure を設定すると失敗し、katakana.gate を設定するとその Deferred が完了するまで答えない
const makeRecordingUpdater = (table: Record<string, string> = {}) => {
  const calls: DiffInput[] = [];
  const katakanaCalls: string[][] = [];
  const katakana: { failure: string | null; gate: Deferred.Deferred<void> | null } = { failure: null, gate: null };
  const updaterLayer = Layer.succeed(
    DiffUpdater,
    DiffUpdater.of({
      update: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { ops: [] };
        }),
      katakana: (words) =>
        Effect.gen(function* () {
          katakanaCalls.push([...words]);
          if (katakana.gate !== null) yield* Deferred.await(katakana.gate);
          if (katakana.failure !== null) return yield* Effect.fail({ _tag: "FakeKatakanaFailed", message: katakana.failure });
          return words.flatMap((surface) => (table[surface] === undefined ? [] : [{ surface, katakana: table[surface]! }]));
        }),
    }),
  );
  return { calls, katakanaCalls, katakana, updaterLayer };
};

const logEvents = (dir: string) =>
  readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

const finalRemark = (track: "相手" | "自分", start: number, end: number, text: string) => ({ track, start, end, text });

describe("SessionSinks（実物 Layer）: 発言の確定・途中結果・書き出し", () => {
  it.effect("確定結果が来なくても、相手の途中結果は 1 秒更新されなければ、最後の本文・区間で発言が 1 件、差分更新に渡る。ID は r1 で、ログにも残る", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "あしたの", duplicate: false });
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議は", duplicate: false });

      yield* TestClock.adjust(SETTLE_QUIET_MS - 1);
      yield* settle;
      expect(logEvents(dir).filter((e) => e.type === "remark")).toEqual([]); // 1 秒の直前まではまだ発言にならない
      yield* TestClock.adjust(1); // 1 秒更新されなかった: 発言になる。1 件だけなので、差分更新は QUIET_MS 後
      yield* settle;
      expect(logEvents(dir).filter((e) => e.type === "remark")).toHaveLength(1);
      expect(calls).toHaveLength(0);
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      expect(calls.flatMap((c) => c.fresh)[0]).toMatchObject({ id: "r1", track: "相手", start: 5, end: 8, text: "あしたの会議は" });

      yield* sink.drain;
      yield* sink.flush;
      expect(calls.flatMap((c) => c.fresh)).toHaveLength(1); // 終了処理で増えない
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議は"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("出した後に届いた確定結果は捨てる。発言は増えず、次の発言の ID は r2 で番号が飛ばない", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議", duplicate: false });
      yield* TestClock.adjust(SETTLE_QUIET_MS + QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

      yield* sink.final(finalRemark("相手", 5.2, 8.2, "明日の会議は十時です。")); // r1 を覆う確定結果。本文が違っても捨てる
      yield* sink.final(finalRemark("相手", 30, 32, "べつの確定結果"));
      yield* sink.drain;
      yield* sink.flush;

      const fresh = calls.flatMap((c) => c.fresh);
      expect(fresh.map((u) => u.id)).toEqual(["r1", "r2"]);
      expect(fresh.some((u) => u.text.includes("十時です"))).toBe(false);
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議"], ["r2", "べつの確定結果"]]);
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

  it.effect("自分の途中結果は、1 秒を超えても発言にならない（相手の同じ入力は発言になる）。自分の発言は確定結果だけから作られる", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "あいてのとちゅう", duplicate: false });
      yield* sink.partial({ track: "自分", start: 5, end: 6, text: "じぶんのとちゅう", duplicate: false });
      yield* sink.final(finalRemark("自分", 20, 22, "じぶんの確定結果"));

      // 守っている状態に到達する: 相手の途中結果は 1 秒経って出ている（自分の途中結果は同時に届いており、出るなら同じ時刻に出る）
      yield* TestClock.adjust(SETTLE_QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).some((u) => u.text === "あいてのとちゅう"));
      yield* sink.drain;
      yield* sink.flush;

      const fresh = calls.flatMap((c) => c.fresh);
      expect(fresh.map((u) => [u.track, u.text])).toEqual(expect.arrayContaining([["相手", "あいてのとちゅう"], ["自分", "じぶんの確定結果"]]));
      expect(fresh).toHaveLength(2);
      expect(fresh.some((u) => u.text === "じぶんのとちゅう")).toBe(false);
      expect(logEvents(dir).filter((e) => e.type === "remark")).toHaveLength(2);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("発言が 1 件だけ届き QUIET_MS 新しい発言が来ないとき、flush を待たずにその 1 件で差分更新が呼ばれ、反映後のマップが公開される", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, published } = yield* openRecordingSink();
      yield* sink.final(finalRemark("相手", 1, 5, "採用の面接について"));

      yield* TestClock.adjust(QUIET_MS - 1);
      yield* settle;
      expect(calls).toHaveLength(0); // QUIET_MS の直前まではまだ呼ばない
      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls.length > 0);
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]);
      yield* settleUntil(() => published.length >= 2);
      expect(published.map((s) => s.round)).toEqual([0, 1]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("途中結果は speaking として届く。重複の印の付いた自分の途中結果は出ず、印のないものは出る。stopRelays で両トラックとも空になり、以後は送らない", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "はじまりの途中結果", duplicate: false });
      yield* sink.partial({ track: "自分", start: 1, end: 2, text: "もれたあいてのこえ", duplicate: true });
      yield* sink.partial({ track: "自分", start: 3, end: 4, text: "じぶんのこえ", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.some((f) => f.track === "自分" && f.text.includes("じぶんのこえ")));
      expect(speaks.some((f) => f.track === "自分" && f.text.includes("じぶんのこえ"))).toBe(true);
      expect(speaks[0]).toEqual({ type: "speaking", track: "相手", text: "はじまりの途中結果" });
      expect(speaks.filter((f) => f.track === "自分").some((f) => f.text.includes("もれたあいてのこえ"))).toBe(false);

      yield* sink.stopRelays;
      for (const track of ["相手", "自分"] as const) expect(speaks.filter((f) => f.track === track).at(-1)?.text).toBe("");
      const sent = speaks.length;
      yield* sink.partial({ track: "相手", start: 9, end: 10, text: "終了後の途中結果", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS + 100);
      yield* settle;
      expect(speaks).toHaveLength(sent);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("clearSpeaking は両トラックを空にするが、以後も途中結果を送れる", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "ひとつめ", duplicate: false });
      yield* settleUntil(() => speaks.some((f) => f.text === "ひとつめ"));
      expect(speaks.some((f) => f.text === "ひとつめ")).toBe(true);

      yield* sink.clearSpeaking;
      expect(speaks.filter((f) => f.track === "相手").at(-1)?.text).toBe("");
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* sink.partial({ track: "相手", start: 4, end: 5, text: "ふたつめ", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.some((f) => f.text === "ふたつめ"));
      expect(speaks.some((f) => f.text === "ふたつめ")).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("発言が 1 件も来ないセッションでも、exports はそのセッションのマップ（空の会議ノード）を書き出す", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();

      const paths = yield* sink.exports;

      expect(paths).toHaveLength(5);
      expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).root).toMatchObject({ kind: "会議", text: "週次", children: [] });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("撮影に渡すスナップショットは 1 回だけで、書き出した map.png が 4 つ目のパスになる", () => {
    const captured: Snapshot[] = [];
    const capture = (snapshot: Snapshot, path: string) =>
      Effect.sync(() => {
        captured.push(snapshot);
        writeFileSync(path, "png");
      });
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final(finalRemark("相手", 1, 2, "採用"));
      yield* sink.flush;

      const paths = yield* sink.exports;

      expect(captured).toHaveLength(1);
      expect(paths[3]).toBe(join(dir, "map.png"));
      expect(readFileSync(join(dir, "map.png"), "utf8")).toBe("png");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer, capture })));
  });

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
      const sink = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }), scope);
      yield* sink.final(finalRemark("相手", 1, 2, "ひとつめ"));
      yield* sink.final(finalRemark("自分", 3, 4, "ふたつめ"));
      yield* sink.final(finalRemark("相手", 5, 6, "みっつめ"));

      const flushing = yield* Effect.forkChild(sink.flush);
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(30); // r1+r2 の反映、続けて r3 の反映が、それぞれ 30 ms かかる
        yield* settle;
      }
      yield* Fiber.join(flushing);
      expect(state.calls.flat().sort()).toEqual(["r1", "r2", "r3"]); // flush が戻った時点で、3 件とも差分更新に渡っている
      expect(state.closed).toBe(0);
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(100);
      yield* settle;

      expect(state).toMatchObject({ closed: 1, callsAfterClose: 0 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("反映前の確定した発言は、自分の speaking にも出る（emit が relay.remark へつながる。base:301）", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();

      yield* sink.final(finalRemark("自分", 1, 2, "面接は何回にしますか"));

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.some((f) => f.track === "自分" && f.text.includes("面接は何回にしますか")));
      expect(speaks.some((f) => f.track === "自分" && f.text.includes("面接は何回にしますか"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("差分更新で反映された発言は、相手の最後の speaking から消える（onDiff が relay.flushAll につながる）。反映前は本文が出ている", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      const lastText = (track: "相手" | "自分") => speaks.filter((f) => f.track === track).at(-1)?.text;

      yield* sink.partial({ track: "自分", start: 5, end: 6, text: "じぶんのとちゅう", duplicate: false });
      yield* sink.final(finalRemark("相手", 1, 5, "採用の面接について"));
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => lastText("相手") === "採用の面接について");
      expect(lastText("相手")).toBe("採用の面接について"); // 反映前: 確定した発言の本文が出ている
      expect(calls).toHaveLength(0);

      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.length > 0);
      yield* settleUntil(() => lastText("相手") === "");
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]);
      expect(lastText("相手")).toBe(""); // 反映後: 処理済みの発言が消えている
      expect(lastText("自分")).toBe("じぶんのとちゅう"); // 反映に渡していない途中結果は残る
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // フォルダ名は開始時刻（実時間のミリ秒）なので、このテストだけ実時間の短い待ち（5 ms）を使う
  it.live("同じ sessionsDir の 2 つ目のセッションは、発言が 1 件も無くても、作成直後の export.json がそのセッションのマップ（前のセッションではない。base:510）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const noop = { publish: () => Effect.void, speak: () => Effect.void };
      const firstDir = yield* sinks.createDir(sessionsDir);
      const first = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: firstDir, title: "前", ...noop });
      yield* first.final(finalRemark("相手", 1, 2, "前の発言"));
      yield* first.flush;
      yield* first.exports;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      const secondDir = yield* sinks.createDir(sessionsDir);
      yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: secondDir, title: "今", ...noop });

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

  it.effect("途中結果から作った発言にも words が付き、行の raw は発言の本文と同じ", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "あした", duplicate: false, words: [word("あした", 0)] });
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議", duplicate: false, words: [word("あした", 0), word("の", 3), word("会議", 4)] });
      yield* TestClock.adjust(SETTLE_QUIET_MS);
      yield* settle;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].remark.text).toBe("あしたの会議");
      expect(lines[0].raw).toBe("あしたの会議");
      expect(lines[0].words).toEqual([word("あした", 0), word("の", 3), word("会議", 4)]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("関所が頭を切った発言の行は、raw が切った後の本文と同じで、words は切った後の本文の位置に合う", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 10, end: 12, text: "あいう", words: [word("あいう", 0)] });
      yield* sink.final({ track: "相手", start: 11, end: 15, text: "あいうえお", words: [word("あい", 0), word("うえ", 2), word("お", 4)] });
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines.map((e) => [e.remark.id, e.remark.text, e.raw])).toEqual([["r1", "あいう", "あいう"], ["r2", "えお", "えお"]]);
      // 切る位置は 3。"うえ" は途中で切れるので落ち、"お" は切った後の本文の位置 1 になる
      expect(lines[1].words).toEqual([word("お", 1)]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("自分の確定結果の行にも words が残る", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "自分", start: 0, end: 1, text: "はい", words: [word("はい", 0)] });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir)[0]).toMatchObject({ raw: "はい", words: [word("はい", 0)] });
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
      yield* TestClock.adjust(QUIET_MS);
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

// Issue #640: 利用者が足した語で発言を直す。
// SessionSink の addUserVocabulary(words) が、語を Readings（読みのサブコマンド）にまとめて 1 回渡して読みを作り、
// log.jsonl に vocab の行（表記・読み・出どころ user。読みが無い語は romaji: null）を書いてから、語彙に読みのある語を足す。
// 開始を待たせないため、読みは addUserVocabulary が返った後に非同期で作られる。
// 関所を通った後の本文を補正して発言にする（確定結果・1 秒更新されなかった途中結果・drain のどの出口でも）。途中結果（speaking）は直さない。
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
  // 英字の語はモデルのカタカナの読みを読みのサブコマンドに渡してローマ字にする（Issue #642）
  const KATAKANA = { Zendesk: "ゼンデスク", notion: "ノーション", a: "エー" };
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

  it.effect("足した語は、まとめて 1 回だけ読みを作り、時刻つきの vocab の行に表記・読み・出どころ user で残る。読みが返らない語は romaji: null で残る", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { dir } = yield* openWithVocabulary(["港南店", "Zendesk", "読めない語", "港南店"]);

      expect(readings.calls).toEqual([["港南店", "読めない語", "ゼンデスク"]]); // 重複は 1 語にして、英字でない語とモデルが返したカタカナを 1 回の呼び出しで読む
      const lines = vocabLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveProperty("at");
      expect(lines[0].words).toEqual([
        { surface: "港南店", romaji: "kounanten", source: "user" },
        { surface: "Zendesk", romaji: "zendesuku", source: "user" },
        { surface: "読めない語", romaji: null, source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("足した語には候補を取る規則をかけない。小文字だけの英字の語・1 文字の語も、そのまま vocab の行に入る", () => {
    const readings = fakeReadings({ ノーション: "nooshon", エー: "e" });
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { dir } = yield* openWithVocabulary(["notion", "a"]);

      expect(readings.calls).toEqual([["ノーション", "エー"]]);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "notion", romaji: "nooshon", source: "user" },
        { surface: "a", romaji: "e", source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("崩れた確定結果は直った本文が発言になる。remark の行は text が直した本文で、raw が直す前の本文、words は直す前の本文の位置のまま。差分更新・字幕にも直った表記が渡る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, speaks } = yield* openWithVocabulary();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* settleUntil(() => speaks.some((f) => f.text === "港南店に行きます"));
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
      expect(speaks.some((f) => f.text === "港南店に行きます")).toBe(true);
      expect(speaks.some((f) => f.text.includes("江南店"))).toBe(false); // 字幕に直す前の本文は出ない。印も付かない
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  // Issue #641: 同梱のふつうの語の一覧（開発 を含む）が補正に渡る。語彙の 改札 と読みが近くても、ふつうの語の 開発 は直さない
  it.effect("同梱のふつうの語の一覧が補正に渡る。語彙に読みの近い語があっても、一覧に載る語の発言は直さず、log と字幕に届いた本文のまま出る", () => {
    const readings = fakeReadings({ 改札: "kaisatsu" });
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    const common = utterance(["開発", "kaihatsu"]);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, speaks } = yield* openWithVocabulary(["改札"]);
      yield* sink.final({ track: "相手", start: 1, end: 2, text: common.text, words: common.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].remark.text).toBe("開発");
      expect(lines[0].raw).toBe("開発");
      expect(speaks.some((f) => f.text === "開発")).toBe(true);
      expect(speaks.some((f) => f.text.includes("改札"))).toBe(false);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("1 秒更新されなかった途中結果から作った発言と、drain で出す発言も直る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openWithVocabulary();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: garbled.text, words: garbled.words, duplicate: false });
      yield* TestClock.adjust(SETTLE_QUIET_MS + QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* TestClock.adjust(QUIET_MS); // 発言を出した後の QUIET_MS の待ちは、出した時刻から数え直される
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

  it.effect("自分の確定結果も直る", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openWithVocabulary();
      yield* sink.final({ track: "自分", start: 0, end: 1, text: garbled.text, words: garbled.words });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir)[0]).toMatchObject({ remark: { track: "自分", text: "港南店に行きます" }, raw: "江南店に行きます" });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("途中結果（いま話している文字）は直らない。語彙があっても、字幕には届いた本文がそのまま出る", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openWithVocabulary();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: garbled.text, words: garbled.words, duplicate: false });
      yield* settleUntil(() => speaks.some((f) => f.text === garbled.text));

      expect(speaks.some((f) => f.text === "江南店に行きます")).toBe(true);
      expect(speaks.some((f) => f.text.includes("港南店"))).toBe(false);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("語彙に無い崩れや、直す語が無い発言は直さない。raw と text は同じ", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openWithVocabulary();
      const plain = utterance(["今日", "kyou"], ["は", "ha"], ["会議", "kaigi"], ["です", "desu"]);
      yield* sink.final({ track: "相手", start: 1, end: 3, text: plain.text, words: plain.words });
      yield* sink.final({ track: "相手", start: 10, end: 12, text: "wordsなし" }); // words の無いイベントは直さない
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines.map((e) => e.remark.text)).toEqual(["今日は会議です", "wordsなし"]);
      expect(lines[0].raw).toBe("今日は会議です");
      expect(lines[1]).not.toHaveProperty("raw");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("足した語が無ければ、vocab の行は書かず、Readings も呼ばない（発言は今までどおり）", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      yield* sink.drain;
      yield* sink.flush;

      expect(readings.calls).toEqual([]);
      expect(vocabLines(dir)).toEqual([]);
      expect(remarkLines(dir)[0].remark.text).toBe("江南店に行きます");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("読みが返らなかった語では直さない。読みが返った語は直る", () => {
    const readings = fakeReadings({ ゼンデスク: "zendesuku" }); // 港南店の読みは返らない
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openWithVocabulary();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      yield* sink.final({ track: "相手", start: 10, end: 12, text: garbledZendesk.text, words: garbledZendesk.words });
      yield* sink.drain;
      yield* sink.flush;

      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: null, source: "user" },
        { surface: "Zendesk", romaji: "zendesuku", source: "user" },
      ]);
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["江南店に行きます", "Zendeskを使う"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("読みの呼び出しが失敗しても、セッションは止まらない。全語が読みなし（romaji: null）で残り、発言は直さずに出る", () => {
    const readings = fakeReadings(READINGS);
    readings.failure.reason = "ヘルパーが 0 以外で終わった";
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openWithVocabulary();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* sink.drain;
      yield* sink.flush;

      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: null, source: "user" },
        { surface: "Zendesk", romaji: null, source: "user" },
      ]);
      expect(remarkLines(dir).map((e) => [e.remark.text, e.raw])).toEqual([["江南店に行きます", "江南店に行きます"]]);
      expect(calls.flatMap((c) => c.fresh)[0]?.text).toBe("江南店に行きます");
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

  // 読み取得の途中で止める（Scope を閉じる）。tmpdir の削除は外側の Scope に残し、閉じた後に log.jsonl を読む
  const openThenCloseSink = Effect.fn("openThenCloseSink")(function* (afterVocabulary: (dir: string) => Effect.Effect<void>) {
    const sessionsDir = yield* withTmpSessionsDir();
    const sinks = yield* SessionSinks;
    const dir = yield* sinks.createDir(sessionsDir);
    const inner = yield* Scope.make();
    const sink = yield* Scope.provide(
      sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }),
      inner,
    );
    yield* sink.addUserVocabulary(["港南店", "Zendesk"]);
    yield* afterVocabulary(dir);
    yield* Scope.close(inner, Exit.void);
    return dir;
  });

  it.effect("読みを作っている途中で止めても、vocab の行はちょうど 1 行残る。全語が出どころ user で、読みなし（romaji: null）", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      readings.gate.current = yield* Deferred.make<void>(); // 完了させない
      const dir = yield* openThenCloseSink(() => settle);

      expect(vocabLines(dir)).toHaveLength(1);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: null, source: "user" },
        { surface: "Zendesk", romaji: null, source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("読みができた後に止めても、vocab の行は 1 行のまま（読みつき）で、重複しない", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const dir = yield* openThenCloseSink((d) => settleUntil(() => vocabLines(d).length === 1));

      expect(vocabLines(dir)).toHaveLength(1);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: "kounanten", source: "user" },
        { surface: "Zendesk", romaji: "zendesuku", source: "user" },
      ]);
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
  const READINGS = { 港南店: "kounanten", ゼンデスク: "zendesuku", 葛西: "kasai" };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const vocabLines = (dir: string) => logEvents(dir).filter((e) => e.type === "vocab");
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");
  const typesOf = (dir: string) => logEvents(dir).map((e) => (e.type === "remark" ? `remark:${e.remark.id}` : e.type === "screen" ? `screen:${e.start}` : e.type));
  type Sink = Effect.Success<ReturnType<typeof openRecordingSink>>["sink"];
  const showScreen = (sink: Sink, start: number, lines?: ReadonlyArray<string>) =>
    sink.screen({ start, image: jpeg, ...(lines === undefined ? {} : { lines }) });

  it.effect("送った画面の候補は規則で取り、まとめて 1 回だけ読みを作る。screen の行（lines つき）→ vocab の行（出どころ screen）の順に残り、1on1 とひらがなだけの行は取らない", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      const lines = ["港南店の出店", "Zendesk", "1on1", "ひらがなだけ"];
      yield* showScreen(sink, 3, lines);
      yield* settleUntil(() => vocabLines(dir).length === 1);

      expect(readings.calls).toEqual([["港南店", "ゼンデスク"]]);
      expect(vocabLines(dir)[0]).toHaveProperty("at");
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: "kounanten", source: "screen" },
        { surface: "Zendesk", romaji: "zendesuku", source: "screen" },
      ]);
      expect(logEvents(dir).find((e) => e.type === "screen")?.lines).toEqual(lines);
      expect(typesOf(dir).indexOf("screen:3")).toBeLessThan(typesOf(dir).indexOf("vocab"));
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("画面から入った語で、その後に締めた発言が直る。remark の行は text が直した本文、raw が直す前の本文で、差分更新と字幕には直った表記が渡る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, speaks } = yield* openRecordingSink();
      yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* settleUntil(() => speaks.some((f) => f.text === "港南店に行きます"));
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir)).toHaveLength(1);
      expect(remarkLines(dir)[0].remark).toMatchObject({ id: "r1", text: "港南店に行きます" });
      expect(remarkLines(dir)[0].raw).toBe("江南店に行きます");
      expect(calls.flatMap((c) => c.fresh)[0]?.text).toBe("港南店に行きます");
      expect(speaks.some((f) => f.text.includes("江南店"))).toBe(false);
      expect(typesOf(dir).indexOf("vocab")).toBeLessThan(typesOf(dir).indexOf("remark:r1"));
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("読みができる前に締めた発言は直し直さない。読みができた後の発言は直り、先の発言の行は変わらない（同じ sink で画面 → 発言 → 読み完了 → 発言）", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      readings.gate.current = yield* Deferred.make<void>();
      const { sink, dir } = yield* openRecordingSink();
      yield* showScreen(sink, 1, ["港南店"]); // 読みが返るまで待たずに返る
      yield* settle;
      expect(vocabLines(dir)).toEqual([]); // まだ読みができていない

      yield* sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words });
      yield* sink.drain;
      yield* sink.flush;
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["江南店に行きます"]);

      yield* Deferred.succeed(readings.gate.current, undefined);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 10, end: 12, text: garbled.text, words: garbled.words });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir).map((e) => [e.remark.id, e.remark.text, e.raw])).toEqual([
        ["r1", "江南店に行きます", "江南店に行きます"],
        ["r2", "港南店に行きます", "江南店に行きます"],
      ]);
      const types = typesOf(dir);
      expect(types.indexOf("remark:r1")).toBeLessThan(types.indexOf("vocab"));
      expect(types.indexOf("vocab")).toBeLessThan(types.indexOf("remark:r2"));
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("画面が変わっても、前の画面から取った語は終わりまで残る。画面 A（港南店）→ 画面 B（別の内容）→ 崩れた発言が直る", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* showScreen(sink, 1, ["港南店"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* showScreen(sink, 5, ["来週の予定", "議事録"]);
      yield* sink.screen({ start: 6, image: null });
      yield* settle;
      yield* sink.final({ track: "相手", start: 7, end: 9, text: garbled.text, words: garbled.words });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir)[0]).toMatchObject({ remark: { text: "港南店に行きます" }, raw: "江南店に行きます" });
      // 前の画面の語を二重に頼まず、vocab の行も重ねて書かない（画面 B の 来週の予定・議事録 は別の語として頼まれる）
      expect(readings.calls.filter((c) => c.includes("港南店"))).toHaveLength(1);
      expect(vocabLines(dir).flatMap((l) => l.words).filter((w: { surface: string }) => w.surface === "港南店")).toHaveLength(1);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("3 画面以上に出た短い行（小窓の名前）が語彙に入る。2 画面までは入らず、ひらがなだけの短い行は 3 画面でも入らない", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* showScreen(sink, 1, ["葛西", "さくら"]);
      yield* showScreen(sink, 2, ["葛西", "さくら", "資料"]);
      yield* settle;
      expect(readings.calls).toEqual([]);
      expect(vocabLines(dir)).toEqual([]);

      yield* showScreen(sink, 3, ["さくら", "葛西"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      expect(readings.calls).toEqual([["葛西"]]);
      expect(vocabLines(dir)[0].words).toEqual([{ surface: "葛西", romaji: "kasai", source: "screen" }]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("利用者が足した語や前の画面で頼んだ語は、画面にまた映っても読みを頼み直さず、vocab の行を重ねない", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["港南店"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* showScreen(sink, 1, ["港南店"]); // 足した語は頼み直さない
      yield* showScreen(sink, 2, ["Zendesk"]);
      yield* settleUntil(() => vocabLines(dir).length === 2);
      yield* showScreen(sink, 3, ["Zendesk", "港南店"]); // 前の画面の語も頼み直さない
      yield* settle;

      expect(readings.calls).toEqual([["港南店"], ["ゼンデスク"]]);
      expect(vocabLines(dir).map((l) => l.words)).toEqual([
        [{ surface: "港南店", romaji: "kounanten", source: "user" }],
        [{ surface: "Zendesk", romaji: "zendesuku", source: "screen" }],
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("lines が空でも、lines が無い画面（古い helper）でも、語彙は増えず Readings も呼ばない。screen の行は残り、その後の発言はそのまま流れる", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* showScreen(sink, 1, []);
      yield* showScreen(sink, 2);
      yield* sink.screen({ start: 3, image: null });
      yield* sink.final({ track: "相手", start: 4, end: 6, text: garbled.text, words: garbled.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* sink.drain;
      yield* sink.flush;

      expect(readings.calls).toEqual([]);
      expect(vocabLines(dir)).toEqual([]);
      const screens = logEvents(dir).filter((e) => e.type === "screen");
      expect(screens).toHaveLength(3);
      expect(screens[0].lines).toEqual([]);
      expect("lines" in screens[1]).toBe(false);
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["江南店に行きます"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("読みの呼び出しが失敗しても、セッションは止まらない。語は出どころ screen・読みなし（romaji: null）で vocab の行に残り、発言は直さずに出る", () => {
    const readings = fakeReadings(READINGS);
    readings.failure.reason = "ヘルパーが 0 以外で終わった";
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* sink.drain;
      yield* sink.flush;

      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: null, source: "screen" },
        { surface: "Zendesk", romaji: null, source: "screen" },
      ]);
      expect(remarkLines(dir).map((e) => [e.remark.text, e.raw])).toEqual([["江南店に行きます", "江南店に行きます"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("読みが返らなかった語は romaji: null で残り、補正には使われない。読みが返った語は直る", () => {
    const readings = fakeReadings({ ゼンデスク: "zendesuku" }); // 港南店の読みは返らない
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    const zendesk = utterance(["全", "zen"], ["デスク", "desuku"], ["を", "wo"], ["使う", "tsukau"]);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words });
      yield* sink.final({ track: "相手", start: 10, end: 12, text: zendesk.text, words: zendesk.words });
      yield* sink.drain;
      yield* sink.flush;

      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: null, source: "screen" },
        { surface: "Zendesk", romaji: "zendesuku", source: "screen" },
      ]);
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["江南店に行きます", "Zendeskを使う"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("読みを作っている途中で止めても、vocab の行はちょうど 1 行残る。出どころ screen で、読みなし（romaji: null）", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      readings.gate.current = yield* Deferred.make<void>(); // 完了させない
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const inner = yield* Scope.make();
      const sink = yield* Scope.provide(
        sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }),
        inner,
      );
      yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
      yield* settle;
      yield* Scope.close(inner, Exit.void);

      expect(vocabLines(dir)).toHaveLength(1);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "港南店", romaji: null, source: "screen" },
        { surface: "Zendesk", romaji: null, source: "screen" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });
});

// Issue #642: 英字の語（略語でないもの）の読みを、差分更新のモデルにまとめて 1 度だけ聞く。
// 語彙に新しく入る語のうち、略語（大文字だけで 5 字以下）でない英字の語は、updater.katakana に 1 回だけまとめて渡してカタカナの読みを得る。
// 返ったカタカナと、英字でない語・略語を合わせて 1 回だけ Readings に渡し、ローマ字の読みにする。読みは 1 語に 1 つ。
// モデルが失敗した語・読みが返らない語は romaji: null で残り、補正に使わない。セッションは止めない。
// katakana の呼び出しは差分更新（update）とは別で、katakana の待ちは差分更新を止めない。
describe("SessionSinks（実物 Layer）: 英字の語の読みをモデルにまとめて聞く（Issue #642）", () => {
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
  // ノーションを開く（Notion の STT の書き方）
  const katakanaNotion = utterance(["ノーション", "nooshon"], ["を", "wo"], ["開く", "hiraku"]);
  // 江南店に行きます（港南店の崩れ）
  const garbled = utterance(["江南", "kounan"], ["店", "ten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]);
  const KATAKANA = { Notion: "ノーション", Figma: "フィグマ" };
  const READINGS = { ノーション: "nooshon", フィグマ: "figuma", OJT: "oojiitii", KPI: "keipiai", 港南店: "kounanten" };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const vocabLines = (dir: string) => logEvents(dir).filter((e) => e.type === "vocab");
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");

  it.effect("[Notion, Figma, OJT, 港南店] を足すと、英字の語 2 つだけが 1 回のまとめた呼び出しでモデルに聞かれる。略語と港南店は聞かれず、読みのサブコマンドへは 1 回で、英字でない語・略語とモデルが返したカタカナが渡る", () => {
    const readings = fakeReadings(READINGS);
    const { katakanaCalls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["Notion", "Figma", "OJT", "港南店"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);

      expect(katakanaCalls).toEqual([["Notion", "Figma"]]);
      expect(readings.calls).toEqual([["OJT", "港南店", "ノーション", "フィグマ"]]);
      expect(vocabLines(dir)).toHaveLength(1);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "Notion", romaji: "nooshon", source: "user" },
        { surface: "Figma", romaji: "figuma", source: "user" },
        { surface: "OJT", romaji: "oojiitii", source: "user" },
        { surface: "港南店", romaji: "kounanten", source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("カタカナで出た発言が英字に直る。remark の行は text が直した本文、raw が直す前の本文で、差分更新と字幕には直った表記が渡る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, speaks } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["Notion", "Figma"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 1, end: 3, text: katakanaNotion.text, words: katakanaNotion.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* settleUntil(() => speaks.some((f) => f.text === "Notionを開く"));
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir)).toHaveLength(1);
      expect(remarkLines(dir)[0].remark).toMatchObject({ id: "r1", text: "Notionを開く" });
      expect(remarkLines(dir)[0].raw).toBe("ノーションを開く");
      expect(calls.flatMap((c) => c.fresh)[0]?.text).toBe("Notionを開く");
      expect(speaks.some((f) => f.text.includes("ノーション"))).toBe(false);
      const types = logEvents(dir).map((e) => e.type);
      expect(types.indexOf("vocab")).toBeLessThan(types.indexOf("remark"));
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("略語だけ（OJT・KPI）を足したときは、モデルに聞かれない。読みのサブコマンドには直接渡る", () => {
    const readings = fakeReadings(READINGS);
    const { katakanaCalls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["OJT", "KPI"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);

      expect(katakanaCalls).toEqual([]);
      expect(readings.calls).toEqual([["OJT", "KPI"]]);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "OJT", romaji: "oojiitii", source: "user" },
        { surface: "KPI", romaji: "keipiai", source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("英字の語がなければ、モデルは聞かれない（英字でない語だけ）", () => {
    const readings = fakeReadings(READINGS);
    const { katakanaCalls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["港南店"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);

      expect(katakanaCalls).toEqual([]);
      expect(readings.calls).toEqual([["港南店"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("2 語が同じカタカナの読みになっても、読みのサブコマンドへ渡すカタカナは重複させず、どちらの語にも読みが付く", () => {
    const readings = fakeReadings(READINGS);
    const { updaterLayer } = makeRecordingUpdater({ Notion: "ノーション", notion: "ノーション" });
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["Notion", "notion"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);

      expect(readings.calls).toEqual([["ノーション"]]);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "Notion", romaji: "nooshon", source: "user" },
        { surface: "notion", romaji: "nooshon", source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("モデルが読みを返している間も差分更新は止まらない。発言を締めて update と flush が終わり、その発言は直し直されない。モデルが返した後に vocab の行が出て、後の発言は直る（同じ sink で、待ちの前 → 解除 → 後）", () => {
    const readings = fakeReadings(READINGS);
    const { calls, katakana, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      katakana.gate = yield* Deferred.make<void>();
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["Notion"]); // 読みが返るまで待たずに返る
      yield* settle;
      expect(vocabLines(dir)).toEqual([]);

      yield* sink.final({ track: "相手", start: 1, end: 3, text: katakanaNotion.text, words: katakanaNotion.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1); // 差分更新はモデルの読みを待たずに走る
      yield* sink.drain;
      yield* sink.flush;
      expect(vocabLines(dir)).toEqual([]); // モデルはまだ待たされている
      expect(remarkLines(dir).map((e) => e.remark.text)).toEqual(["ノーションを開く"]);

      yield* Deferred.succeed(katakana.gate, undefined);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 10, end: 12, text: katakanaNotion.text, words: katakanaNotion.words });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir).map((e) => [e.remark.id, e.remark.text, e.raw])).toEqual([
        ["r1", "ノーションを開く", "ノーションを開く"],
        ["r2", "Notionを開く", "ノーションを開く"],
      ]);
      const types = logEvents(dir).map((e) => (e.type === "remark" ? `remark:${e.remark.id}` : e.type));
      expect(types.indexOf("remark:r1")).toBeLessThan(types.indexOf("vocab"));
      expect(types.indexOf("vocab")).toBeLessThan(types.indexOf("remark:r2"));
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("モデルが失敗しても、セッションは続く。英字の語だけ romaji: null で、読みのサブコマンドには直接渡さない。港南店・OJT には読みが付き、ノーションの発言は直らず、江南店の発言は直る", () => {
    const readings = fakeReadings(READINGS);
    const { calls, katakana, updaterLayer } = makeRecordingUpdater(KATAKANA);
    katakana.failure = "モデルが落ちた";
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["Notion", "OJT", "港南店"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 1, end: 3, text: katakanaNotion.text, words: katakanaNotion.words });
      yield* sink.final({ track: "相手", start: 10, end: 12, text: garbled.text, words: garbled.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 2);
      yield* sink.drain;
      yield* sink.flush;

      expect(readings.calls).toEqual([["OJT", "港南店"]]);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "Notion", romaji: null, source: "user" },
        { surface: "OJT", romaji: "oojiitii", source: "user" },
        { surface: "港南店", romaji: "kounanten", source: "user" },
      ]);
      expect(remarkLines(dir).map((e) => [e.remark.text, e.raw])).toEqual([
        ["ノーションを開く", "ノーションを開く"],
        ["港南店に行きます", "江南店に行きます"],
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("渡す語が 1 つもなくなったとき（英字の語だけでモデルが失敗）は、読みのサブコマンドを呼ばず、vocab の行は全語 romaji: null で 1 行残る", () => {
    const readings = fakeReadings(READINGS);
    const { katakana, updaterLayer } = makeRecordingUpdater(KATAKANA);
    katakana.failure = "モデルが落ちた";
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["Notion", "Figma"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);

      expect(readings.calls).toEqual([]);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "Notion", romaji: null, source: "user" },
        { surface: "Figma", romaji: null, source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("モデルが一部の語の読みを返さない・カタカナでない値を返したときは、その語だけ romaji: null。返った語は読みが付き、読みのサブコマンドへはその語のカタカナだけが渡る", () => {
    const readings = fakeReadings({ ...READINGS, スラック: "surakku" });
    const { calls, updaterLayer } = makeRecordingUpdater({ Notion: "ノーション", Figma: "ふぃぐま" }); // Slack は答えが無い・Figma はひらがな
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.addUserVocabulary(["Notion", "Figma", "Slack"]);
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* settle;
      yield* sink.final({ track: "相手", start: 1, end: 3, text: katakanaNotion.text, words: katakanaNotion.words });
      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      yield* sink.drain;
      yield* sink.flush;

      expect(readings.calls).toEqual([["ノーション"]]);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "Notion", romaji: "nooshon", source: "user" },
        { surface: "Figma", romaji: null, source: "user" },
        { surface: "Slack", romaji: null, source: "user" },
      ]);
      expect(remarkLines(dir)[0].remark.text).toBe("Notionを開く");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("共有画面の lines に英字の語があるときも、出どころ screen として、まとめて 1 回だけモデルに聞かれる。同じ語がまた映っても聞き直さない", () => {
    const readings = fakeReadings(READINGS);
    const { katakanaCalls, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.screen({ start: 1, image: jpeg, lines: ["Notion", "Figma", "OJT", "港南店の出店"] });
      yield* settleUntil(() => vocabLines(dir).length === 1);
      yield* sink.screen({ start: 2, image: jpeg, lines: ["Notion", "Figma"] });
      yield* settle;

      expect(katakanaCalls).toEqual([["Notion", "Figma"]]);
      expect(vocabLines(dir)).toHaveLength(1);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "Notion", romaji: "nooshon", source: "screen" },
        { surface: "Figma", romaji: "figuma", source: "screen" },
        { surface: "OJT", romaji: "oojiitii", source: "screen" },
        { surface: "港南店", romaji: "kounanten", source: "screen" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });

  it.effect("モデルの読みを待っている途中で止めても、vocab の行はちょうど 1 行残る。全語が出どころ user で、読みなし（romaji: null）", () => {
    const readings = fakeReadings(READINGS);
    const { katakana, updaterLayer } = makeRecordingUpdater(KATAKANA);
    return Effect.scoped(Effect.gen(function* () {
      katakana.gate = yield* Deferred.make<void>(); // 完了させない
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const inner = yield* Scope.make();
      const sink = yield* Scope.provide(
        sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }),
        inner,
      );
      yield* sink.addUserVocabulary(["Notion", "港南店"]);
      yield* settle;
      yield* Scope.close(inner, Exit.void);

      expect(readings.calls).toEqual([]);
      expect(vocabLines(dir)).toHaveLength(1);
      expect(vocabLines(dir)[0].words).toEqual([
        { surface: "Notion", romaji: null, source: "user" },
        { surface: "港南店", romaji: null, source: "user" },
      ]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer, readings })));
  });
});

// Issue #645: 過去のセッションの語彙を引き継ぐ。
// セッションの置き場（LIVE_MINDMAP_SESSIONS = createDir に渡す sessionsDir）の中に、全セッションをまたぐ溜まりのファイルを 1 つ置く。
// 開始（open）で溜まりの語を読みごと vocab の行（出どころ carried）として語彙に入れ（読みは作り直さない）、
// 終了（exports）で、直した後の発言に出た語と利用者が足した語を溜まりへ入れ、共有画面に映っただけの語は入れない。
// 最後に話されてから POOL_DROP_AFTER_SESSIONS セッション話されなかった語（足した語を除く）は落ちる。
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
  const poolWords = (sessionsDir: string): string[] => readPool(sessionsDir).words.map((w: { surface: string }) => w.surface).sort();
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
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
  const idle = (_context: Context) => Effect.void;
  const layerWith = (readings = fakeReadings(READINGS)) => ({ readings, layer: sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer, readings }) });

  it.effect("1 回目に話された語は、2 回目の開始時に読みごと vocab の行（出どころ carried）で語彙に入り、読みは作り直さず、2 回目の崩れた発言が直る。ログには各セッションの番号が残る", () => {
    const { readings, layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const first = yield* runSession(sessionsDir, spokeOnlyKounan);
      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] });
      expect(logEvents(first).filter((e) => e.type === "vocab-pool")).toEqual([expect.objectContaining({ session: 1 })]);
      const callsAfterFirst = readings.calls.length;
      expect(callsAfterFirst).toBe(1);

      let second = "";
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        second = dir;
        yield* awaitVocabLines(dir, 1);
        expect(vocabLines(dir)[0]).toHaveProperty("at");
        expect(vocabLines(dir)[0].words).toEqual([{ surface: "港南店", romaji: "kounanten", source: "carried" }]);
        expect(readings.calls.length).toBe(callsAfterFirst); // 読みのサブコマンドは呼ばない
        yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      }));

      const lines = remarkLines(second);
      expect(lines).toHaveLength(1);
      expect(lines[0].remark.text).toBe("港南店に行きます");
      expect(lines[0].raw).toBe("江南店に行きます");
      const types = logEvents(second).map((e) => e.type);
      expect(types.indexOf("vocab")).toBeLessThan(types.indexOf("remark")); // 発言の行は vocab の行より後ろ
      expect(logEvents(second).filter((e) => e.type === "vocab-pool")).toEqual([expect.objectContaining({ session: 2 })]);
      expect(readings.calls.length).toBe(callsAfterFirst); // 最後まで、読みは作り直されない
    }).pipe(Effect.provide(layer));
  });

  it.effect("1 回目に画面に映っただけで話されなかった語（Zendesk）は、溜まりに入らず、2 回目の語彙（carried）にも入らない", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, spokeOnlyKounan);
      expect(poolWords(sessionsDir)).toEqual(["港南店"]);
      const second = yield* runSession(sessionsDir, ({ dir }) => awaitVocabLines(dir, 1));
      const carried = vocabLines(second).flatMap((e) => e.words);
      expect(carried.map((w: { surface: string }) => w.surface)).toEqual(["港南店"]);
      expect(poolWords(sessionsDir)).toEqual(["港南店"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("語彙で直して出た語（画面の語を崩れて話し、直った発言）も、溜まりに入る。映っただけの語は入らない", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* showScreen(sink, 1, ["港南店", "Zendesk"]);
        yield* awaitVocabLines(dir, 1);
        yield* settle;
        yield* sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words });
      }));
      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("語彙に無い崩れた発言は直らないので、その語は話された語にならず、溜まりに入らない", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, ({ sink }) => sink.final({ track: "相手", start: 2, end: 4, text: garbled.text, words: garbled.words }));
      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("利用者が足した語は、話されなくても溜まりへ残り、次のセッションの語彙に carried で入る。読みは作り直さない", () => {
    const { readings, layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* sink.addUserVocabulary(["葛西"]);
        yield* awaitVocabLines(dir, 1);
      }));
      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [{ surface: "葛西", romaji: "kasai", source: "user", lastSpoken: 0 }] });
      const callsAfterFirst = readings.calls.length;

      const second = yield* runSession(sessionsDir, ({ dir }) => awaitVocabLines(dir, 1));
      expect(vocabLines(second)[0].words).toEqual([{ surface: "葛西", romaji: "kasai", source: "carried" }]);
      expect(readings.calls.length).toBe(callsAfterFirst);
      expect(readPool(sessionsDir)).toEqual({ sessions: 2, words: [{ surface: "葛西", romaji: "kasai", source: "user", lastSpoken: 0 }] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("読みが作れなかった足した語も、溜まりに user・読みなし（romaji: null）で残り、次の開始時に carried・読みなしの vocab の行になる。読みは作り直さず、補正には使わない", () => {
    const { readings, layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* sink.addUserVocabulary(["読めない語"]); // READINGS に無い語は読みが返らない
        yield* awaitVocabLines(dir, 1);
      }));
      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [{ surface: "読めない語", romaji: null, source: "user", lastSpoken: 0 }] });
      const callsAfterFirst = readings.calls.length;

      const second = yield* runSession(sessionsDir, ({ dir }) => awaitVocabLines(dir, 1));
      expect(vocabLines(second)[0].words).toEqual([{ surface: "読めない語", romaji: null, source: "carried" }]);
      expect(readings.calls.length).toBe(callsAfterFirst);
      expect(readPool(sessionsDir).words).toEqual([{ surface: "読めない語", romaji: null, source: "user", lastSpoken: 0 }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("読み取得の途中で停止（exports）しても、読み取得が終わって vocab の行を書き終えてから溜まりを更新する。溜まりに spoken の語を足した語にすると user になる", () => {
    const { readings, layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, spokeOnlyKounan);
      expect(readPool(sessionsDir).words[0]).toMatchObject({ surface: "港南店", source: "spoken" });

      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* awaitVocabLines(dir, 1);
        readings.gate.current = yield* Deferred.make<void>(); // 読みの取得を保留する
        yield* sink.addUserVocabulary(["港南店"]);
        yield* sink.drain;
        yield* sink.flush;
        const stopping = yield* Effect.forkChild(sink.exports);
        yield* settle;
        expect(vocabLines(dir)).toHaveLength(1); // 足した語の記録はまだ無い
        expect(readPool(sessionsDir).words[0]).toMatchObject({ source: "spoken" }); // 溜まりは記録を待っている
        yield* Deferred.succeed(readings.gate.current, undefined);
        yield* Fiber.join(stopping);
        expect(vocabLines(dir).flatMap((e) => e.words)).toContainEqual({ surface: "港南店", romaji: "kounanten", source: "user" });
      }), { exports: false });

      expect(readPool(sessionsDir).words).toEqual([{ surface: "港南店", romaji: "kounanten", source: "user", lastSpoken: 1 }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("読み取得の途中で停止（exports）しても、正しい表記で話された画面の語は、読み取得が終わるのを待って溜まりに spoken で入る", () => {
    const { readings, layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        readings.gate.current = yield* Deferred.make<void>(); // 読みの取得を保留する
        yield* showScreen(sink, 1, ["港南店"]);
        yield* sink.final({ track: "相手", start: 2, end: 4, text: correct.text, words: correct.words });
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;
        const stopping = yield* Effect.forkChild(sink.exports);
        yield* settle;
        expect(vocabLines(dir)).toHaveLength(0);
        expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [] });
        yield* Deferred.succeed(readings.gate.current, undefined);
        yield* Fiber.join(stopping);
      }), { exports: false });

      expect(readPool(sessionsDir)).toEqual({ sessions: 1, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("話された語は、その後 POOL_DROP_AFTER_SESSIONS セッション話されないと溜まりから落ちる。足した語は同じだけ過ぎても落ちない（carried で入るだけでは話されたことにならない）", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, (context) => Effect.gen(function* () {
        yield* context.sink.addUserVocabulary(["Zendesk"]);
        yield* spokeOnlyKounan(context);
        yield* awaitVocabLines(context.dir, 2);
      }));
      expect(poolWords(sessionsDir)).toEqual(["Zendesk", "港南店"]);

      for (let n = 2; n <= POOL_DROP_AFTER_SESSIONS; n++) yield* runSession(sessionsDir, idle);
      // セッション 20 の終了後: 最後に話されてから 19 セッションなので、まだ残る
      expect(readPool(sessionsDir).sessions).toBe(POOL_DROP_AFTER_SESSIONS);
      expect(poolWords(sessionsDir)).toEqual(["Zendesk", "港南店"]);

      yield* runSession(sessionsDir, idle); // セッション 21: 最後に話されてから 20 セッション
      expect(readPool(sessionsDir).sessions).toBe(POOL_DROP_AFTER_SESSIONS + 1);
      expect(poolWords(sessionsDir)).toEqual(["Zendesk"]); // 話された語だけが落ち、足した語は残る
      expect(readPool(sessionsDir).words[0]).toMatchObject({ surface: "Zendesk", source: "user" });
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

  it.effect("会議中に forget しても、今のセッションの語彙と字幕は変わらない（崩れた発言は直り、vocab の行は増えない）。話されたので終了時に溜まりへ入り直す", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, spokeOnlyKounan);
      expect(poolWords(sessionsDir)).toEqual(["港南店"]);

      let second = "";
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        second = dir;
        yield* awaitVocabLines(dir, 1);
        forgetFromFile(sessionsDir, "港南店");
        expect(poolWords(sessionsDir)).toEqual([]);
        yield* sink.final({ track: "相手", start: 1, end: 3, text: garbled.text, words: garbled.words });
      }));

      expect(remarkLines(second).map((e) => e.remark.text)).toEqual(["港南店に行きます"]); // 今のセッションの語彙は変わらず、直る
      expect(vocabLines(second)).toHaveLength(1);
      expect(vocabLines(second)[0].words).toEqual([{ surface: "港南店", romaji: "kounanten", source: "carried" }]);
      expect(readPool(sessionsDir)).toEqual({ sessions: 2, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 2 }] }); // 話されたので入り直す
    }).pipe(Effect.provide(layer));
  });

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

  it.effect("セッションの間に forget した語は、次のセッションの語彙（carried）に入らない。次のセッションで画面に映して話せば、終了時に溜まりへ入り直す", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, spokeOnlyKounan);
      forgetFromFile(sessionsDir, "港南店");

      const second = yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* settle;
        expect(vocabLines(dir)).toEqual([]); // carried で入らない
        yield* spokeOnlyKounan({ sink, dir });
      }));

      expect(vocabLines(second).flatMap((e) => e.words)).toEqual(expect.arrayContaining([{ surface: "港南店", romaji: "kounanten", source: "screen" }]));
      expect(readPool(sessionsDir)).toEqual({ sessions: 2, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 2 }] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("セッションの間に forget した足した語も、次のセッションで --vocab（addUserVocabulary）で足されれば、終了時に溜まりへ入り直す", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* sink.addUserVocabulary(["葛西"]);
        yield* awaitVocabLines(dir, 1);
      }));
      forgetFromFile(sessionsDir, "葛西");
      expect(poolWords(sessionsDir)).toEqual([]);

      yield* runSession(sessionsDir, ({ dir }) => Effect.gen(function* () {
        yield* settle;
        expect(vocabLines(dir)).toEqual([]);
      }));
      expect(poolWords(sessionsDir)).toEqual([]); // 足されなければ戻らない

      yield* runSession(sessionsDir, ({ sink, dir }) => Effect.gen(function* () {
        yield* sink.addUserVocabulary(["葛西"]);
        yield* awaitVocabLines(dir, 1);
      }));
      expect(readPool(sessionsDir).words).toEqual([{ surface: "葛西", romaji: "kasai", source: "user", lastSpoken: 0 }]);
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
