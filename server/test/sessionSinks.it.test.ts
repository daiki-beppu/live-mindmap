import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { MapCapture } from "../src/capture.ts";
import { DiffUpdater, QUIET_MS, REVIEW_LOG_ELEMENT_ID, SETTLE_QUIET_MS, type DiffInput, type Snapshot, type SpeakingFrame } from "../src/core/index.ts";
import { ReviewBuild } from "../src/review.ts";
import { SessionSinks, type SessionSinksDeps } from "../src/sessionSinks.ts";
import { SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { collectingConsole, failingBuild, failingCapture, FAKE_TEMPLATE, fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// Issue #240 段 3（ADR 0008）→ Issue #243 段 6: SessionSinks の実物 Layer を、実 tmpdir + 偽の DiffUpdater／capture で確かめる。
// updater・ログ・いま話している文字・書き出しを開く契約（CT-SINK-SCOPE）と、録音ファイル名の採番（要件117,127）
// がこのファイルの対象。段 6 で、SessionSinks は新しいセッション（makeSession）を直接使う。
// 1 秒の途中結果（SETTLE_QUIET_MS）と QUIET_MS の待ちは TestClock で進める（本物の時間では待たない）。
//
// 想定する契約（server/src/sessionSinks.ts）:
// - `SessionSinks.layer({ updaterLayer })` が実物の Layer を作る。撮影・見返し用の HTML のビルド・mix・FileSystem は Layer の文脈から受け取る（テストの sinksLayer が偽物を渡す）。
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
const sinksLayer = ({ updaterLayer, ...services }: Pick<SessionSinksDeps, "updaterLayer"> & ExportServicesOptions) =>
  SessionSinks.layer({ updaterLayer }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer, ...services })));

const withTmpSessionsDir = Effect.fn("withTmpSessionsDir")(function* () {
  return yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-sinks-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
});

describe("SessionSinks（実物 Layer）", () => {
  it.effect("updater はセッションの Scope の資源で、Scope を閉じると閉じる（CT-SINK-SCOPE）", () => {
    const { updaterLayer, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      expect(state.opened).toBe(0); // フォルダを作っただけでは開かない

      const scope = yield* Scope.make();
      yield* Scope.provide(
        sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }),
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

      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
    const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      expect(warnings.errors).toEqual(["map.png を書き出せませんでした: 後始末に失敗"]);
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

      expect(warnings.errors).toContain("map.png を書き出せませんでした: 撮影に失敗\n詳細");
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
    ).pipe(Layer.provideMerge(NodeFileSystem.layer));
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
      expect(state).toEqual({ captureBuilt: 1, captured: 0 }); // 開いた時点で受け取り済み

      yield* sink.exports;
      yield* sink.exports;

      expect(state).toEqual({ captureBuilt: 1, captured: 2 });
    })).pipe(Effect.provide(SessionSinks.layer({ updaterLayer: makeFakeUpdater().updaterLayer }).pipe(Layer.provide(services))));
  });

  it.effect("テキストの 3 形式を書けないときは、失敗の値ではなく defect になる（撮影・HTML の失敗のように諦めない）", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
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
      const first = yield* Scope.provide(sinks.open({ dir: yield* sinks.createDir(sessionsDir), title: "一つ目", ...noop }), firstScope);
      expect(state).toMatchObject({ opened: 1, closed: 0 });
      yield* first.final({ track: "相手", start: 0, end: 1, text: "ひとつめの発言" });
      yield* first.flush; // 1 つ目の updater で差分更新が呼ばれる
      yield* Scope.close(firstScope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5))); // フォルダ名は開始時刻（実時間のミリ秒）
      const secondScope = yield* Scope.make();
      const second = yield* Scope.provide(sinks.open({ dir: yield* sinks.createDir(sessionsDir), title: "二つ目", ...noop }), secondScope);
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
        const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

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
  const sink = yield* sinks.open({
    dir,
    title: "週次",
    publish: (snapshot) => Effect.sync(() => void published.push(snapshot)),
    speak: (frame) => Effect.sync(() => void speaks.push(frame)),
  });
  return { sink, dir, speaks, published };
});

// 差分更新に渡った入力を記録する偽の DiffUpdater の Layer
const makeRecordingUpdater = () => {
  const calls: DiffInput[] = [];
  const updaterLayer = Layer.succeed(
    DiffUpdater,
    DiffUpdater.of({
      update: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { ops: [] };
        }),
    }),
  );
  return { calls, updaterLayer };
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
      const sink = yield* Scope.provide(sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }), scope);
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
      const first = yield* sinks.open({ dir: firstDir, title: "前", ...noop });
      yield* first.final(finalRemark("相手", 1, 2, "前の発言"));
      yield* first.flush;
      yield* first.exports;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      const secondDir = yield* sinks.createDir(sessionsDir);
      yield* sinks.open({ dir: secondDir, title: "今", ...noop });

      expect(secondDir).not.toBe(firstDir);
      const exported = JSON.parse(readFileSync(join(secondDir, "export.json"), "utf8"));
      expect(JSON.stringify(exported)).toContain("今");
      expect(JSON.stringify(exported)).not.toContain("前の発言");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));
});
