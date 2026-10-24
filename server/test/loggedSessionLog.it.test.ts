import { defaultClaude } from "../src/modelSelection.ts";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Layer } from "effect";
import type { DiffInput, IntakeLogEvent, Remark } from "../src/core/index.ts";
import { createSessionDir, openLoggedSession } from "../src/sessionFiles.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import type { ViewerFrame } from "../src/viewers.ts";

// セッションのフォルダへの書き込み（log.jsonl の追記・export.json・フォルダ名）の契約。
// 書き込みは FileSystem 経由の非同期になるので、同期の書き込みで自然に成り立っていた次の性質を固定する:
// 呼んだ順に行が並ぶこと、最後に書かれた export.json が最新であること、時刻は Effect を実行した時点の実時刻であること、
// ログが書けないのは defect であること。

const sessionsDir = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-log-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}` });
const note = (n: number): IntakeLogEvent => ({ type: "intake-stopped", code: n, signal: null, stderrTail: [`行${n}`] });
const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const open = Effect.fn("open")(function* () {
  const root = yield* sessionsDir;
  const dir = yield* createSessionDir(root).pipe(Effect.provide(NodeFileSystem.layer));
  const inputs: DiffInput[] = [];
  const published: number[] = [];
  const frames: ViewerFrame[] = [];
  const opened = yield* openLoggedSession({ model: defaultClaude, dir, title: "定例", send: (frame) => Effect.sync(() => {
    frames.push(frame);
    if (!("type" in frame)) published.push(frame.nodes.length);
  }) }).pipe(
    Effect.provide(Layer.mergeAll(updaterLayer((input) => Effect.sync(() => (inputs.push(input), { ops: [] }))), NodeFileSystem.layer)),
  );
  const lines = () => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const exported = () => JSON.parse(readFileSync(join(dir, "export.json"), "utf8")) as unknown;
  return { root, dir, ...opened, inputs, published, frames, lines, exported };
});

describe("createSessionDir", () => {
  it.effect("フォルダ名は Effect を実行した時点の実時刻（TestClock の下でも実時刻）から付け、同じ Effect を実行し直すと別のフォルダを作る", () =>
    Effect.gen(function* () {
      const root = yield* sessionsDir;
      const create = createSessionDir(root).pipe(Effect.provide(NodeFileSystem.layer));
      const before = Date.now();
      const first = yield* create;
      yield* realSleep(20);
      const second = yield* create;
      const after = Date.now();

      expect(first).not.toBe(second);
      expect(readdirSync(root)).toHaveLength(2);
      for (const dir of [first, second]) {
        expect(basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
        const time = Date.parse(basename(dir).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));
        expect(time).toBeGreaterThanOrEqual(before - 1);
        expect(time).toBeLessThanOrEqual(after + 1);
      }
    }).pipe(Effect.scoped));

  it.effect("時刻を渡すと、フォルダ名はその時刻になる（今の時刻ではない）", () =>
    Effect.gen(function* () {
      const root = yield* sessionsDir;
      const dir = yield* createSessionDir(root, DateTime.makeUnsafe("2026-10-01T01:02:03Z")).pipe(Effect.provide(NodeFileSystem.layer));
      expect(basename(dir)).toBe("2026-10-01T01-02-03.000Z");
      expect(readdirSync(root)).toEqual(["2026-10-01T01-02-03.000Z"]);
    }).pipe(Effect.scoped));

  it.effect("同じ名前のフォルダが既にあるときは使い回さず、-2、-3 を付けた新しいフォルダを作る。既にあるフォルダの中身は変わらない", () =>
    Effect.gen(function* () {
      const root = yield* sessionsDir;
      const at = DateTime.makeUnsafe("2026-10-01T01:02:03Z");
      const create = createSessionDir(root, at).pipe(Effect.provide(NodeFileSystem.layer));
      const first = yield* create;
      writeFileSync(join(first, "log.jsonl"), "前のセッション\n");
      writeFileSync(join(first, "相手.m4a"), "前の音声");
      const second = yield* create;
      const third = yield* create;

      expect([first, second, third].map((dir) => basename(dir))).toEqual(["2026-10-01T01-02-03.000Z", "2026-10-01T01-02-03.000Z-2", "2026-10-01T01-02-03.000Z-3"]);
      expect(readFileSync(join(first, "log.jsonl"), "utf8")).toBe("前のセッション\n");
      expect(readFileSync(join(first, "相手.m4a"), "utf8")).toBe("前の音声");
      expect(readdirSync(second)).toEqual([]);
      expect(readdirSync(third)).toEqual([]);
    }).pipe(Effect.scoped));

  it.effect("sessionsDir がまだ無くても、親のフォルダごと作る", () =>
    Effect.gen(function* () {
      const root = yield* sessionsDir;
      const dir = yield* createSessionDir(join(root, "a", "b")).pipe(Effect.provide(NodeFileSystem.layer));
      expect(readdirSync(dir)).toEqual([]);
    }).pipe(Effect.scoped));
});

describe("openLoggedSession のログと export.json", () => {
  it.effect("作成直後に、start の行（at・type・title）と、そのセッションのマップの export.json がある", () =>
    Effect.gen(function* () {
      const before = Date.now();
      const { lines, exported, session, published, frames } = yield* open();

      const [first] = lines();
      expect(first).toMatchObject({ type: "start", title: "定例" });
      expect(Object.keys(first!)).toEqual(["at", "type", "title", "model"]);
      expect(new Date(first!.at as string).toISOString()).toBe(first!.at); // ISO 文字列
      expect(Date.parse(first!.at as string)).toBeGreaterThanOrEqual(before - 1);
      expect(Date.parse(first!.at as string)).toBeLessThanOrEqual(Date.now() + 1);
      expect(exported()).toEqual(JSON.parse(JSON.stringify(yield* session.exportJson)));
      expect(published).toHaveLength(1); // 最初のルート
      expect(frames.filter((frame) => "type" in frame && frame.type === "speaker-names")).toEqual([
        { type: "speaker-names", names: [] },
      ]);
      expect(frames.filter((frame) => "type" in frame && frame.type === "diff-update")).toEqual([
        { type: "diff-update", state: { status: "running" } },
      ]);
    }).pipe(Effect.scoped));

  it.effect("logShiftMs を渡すと、log.jsonl の at と diff の call の時刻が、実時刻にそのずらし幅を足した値になる", () =>
    Effect.gen(function* () {
      const shift = -3 * 24 * 3_600_000;
      const root = yield* sessionsDir;
      const dir = yield* createSessionDir(root).pipe(Effect.provide(NodeFileSystem.layer));
      const open = yield* openLoggedSession({ model: defaultClaude, dir, title: "定例", logShiftMs: shift }).pipe(
        Effect.provide(Layer.mergeAll(updaterLayer(() => Effect.succeed({ ops: [] })), NodeFileSystem.layer)),
      );
      const before = Date.now();
      yield* open.session.push(remark(1));
      yield* open.session.idle;
      yield* open.appendLog(note(1));
      const after = Date.now();

      const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const diff = lines.find((l) => l.type === "diff")!;
      const call = diff.call as { startedAt: string; endedAt: string };
      const times = [...lines.map((l) => l.at as string), call.startedAt, call.endedAt].map((t) => Date.parse(t));
      expect(lines.map((l) => l.type)).toEqual(["start", "remark", "diff", "intake-stopped"]);
      // どの時刻も、実行の間の実時刻から 3 日前にずれている（at だけでなく call も）
      for (const time of times) {
        expect(time).toBeGreaterThanOrEqual(Date.parse(lines[0]!.at as string));
        expect(time).toBeLessThanOrEqual(after + shift + 1);
      }
      expect(Date.parse(call.startedAt)).toBeGreaterThanOrEqual(before + shift - 1);
      expect(Date.parse(lines[3]!.at as string)).toBeGreaterThanOrEqual(before + shift - 1);
      expect(existsSync(join(dir, "export.json"))).toBe(true);
    }).pipe(Effect.scoped));

  it.effect("at は行を書く時点の実時刻で、同じ appendLog を後から実行し直すと新しい時刻になる。export.json は書き直さない", () =>
    Effect.gen(function* () {
      const { appendLog, lines, dir } = yield* open();
      const exportBefore = readFileSync(join(dir, "export.json"), "utf8");
      const append = appendLog(note(1));
      yield* append;
      yield* realSleep(20);
      yield* append;

      const [, a, b] = lines();
      expect(a).toMatchObject({ type: "intake-stopped", code: 1, signal: null, stderrTail: ["行1"] });
      expect(Date.parse(b!.at as string)).toBeGreaterThan(Date.parse(a!.at as string));
      expect(readFileSync(join(dir, "export.json"), "utf8")).toBe(exportBefore);
    }).pipe(Effect.scoped));

  it.effect("同時に呼んだ appendLog は、呼んだ順に 1 行ずつ並ぶ（行が混ざらない・追い越さない）", () =>
    Effect.gen(function* () {
      const { appendLog, lines } = yield* open();
      yield* Effect.forEach(Array.from({ length: 60 }, (_, i) => i), (i) => appendLog(note(i)), { concurrency: "unbounded", discard: true });

      expect(lines().slice(1).map((l) => l.code)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    }).pipe(Effect.scoped));

  it.effect("同時に push した発言は、push した順に log.jsonl へ並び、最後の export.json が最終のマップと発言を表す", () =>
    Effect.gen(function* () {
      const { session, lines, exported } = yield* open();
      const count = 30;
      yield* Effect.forEach(Array.from({ length: count }, (_, i) => i), (i) => session.push(remark(i)), { concurrency: "unbounded", discard: true });
      yield* session.idle;

      const remarkIds = lines().filter((l) => l.type === "remark").map((l) => (l.remark as Remark).id);
      expect(remarkIds).toEqual(Array.from({ length: count }, (_, i) => `r${i}`));
      expect(exported()).toEqual(JSON.parse(JSON.stringify(yield* session.exportJson)));
    }).pipe(Effect.scoped));

  it.effect("ログが書けない（フォルダが無い）ときは、型付きの失敗ではなく defect になる", () =>
    Effect.gen(function* () {
      const { appendLog, dir } = yield* open();
      rmSync(dir, { recursive: true, force: true });

      const exit = yield* Effect.exit(appendLog(note(1)));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true);
    }).pipe(Effect.scoped));
});
