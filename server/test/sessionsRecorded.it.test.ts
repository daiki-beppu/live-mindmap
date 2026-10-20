import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Fiber, FileSystem, Layer, Result, Stream } from "effect";
import { vi } from "vitest";
import type { DiffInput } from "../src/core/index.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { Sessions, SessionsDir, type RecordedStart } from "../src/sessions.ts";
import { Viewers } from "../src/viewers.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { fakeHelpers, HELPER_AUDIO, HELPER_SELF_AUDIO, remarkEvents, type Remark, type Script } from "./fixtures/recordedHelper.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

function failingLogWrite() {
  const writes = { armed: true, failed: 0 };
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return new Proxy(fs, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "writeFileString") return value;
          return (path: string, data: string, options?: unknown) => {
            if (writes.armed && path.endsWith("log.jsonl") && data.includes('"type":"remark"') && data.includes("次の発言です")) {
              writes.armed = false;
              writes.failed += 1;
              return Effect.fail(new Error("ディスクに書けない"));
            }
            return (value as (...args: unknown[]) => Effect.Effect<void>).call(target, path, data, options);
          };
        },
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return { writes, layer };
}

const resource = Effect.fnUntraced(function* (script: Script, options: { attempts?: readonly Script[]; fileSystem?: Layer.Layer<FileSystem.FileSystem> } = {}) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-recorded-sessions-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const sessionsDir = join(root, "sessions");
  const file = join(root, "meeting.m4a");
  const selfFile = join(root, "me.m4a");
  const helpers = fakeHelpers(script, options.attempts);
  const inputs: DiffInput[] = [];
  const updater = updaterLayer((input) => Effect.sync(() => { inputs.push(input); return { ops: [] }; }));
  const layer = Sessions.layer.pipe(Layer.provide(Layer.mergeAll(
    readyManagedDeps, helpers.layer, Viewers.layer, Layer.succeed(SessionsDir, sessionsDir),
    SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updater }) }).pipe(Layer.provide(fakeExportServices({ ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }) }))),
  )));
  const context = yield* Layer.build(layer);
  const sessions = Context.get(context, Sessions);
  const run = Effect.fnUntraced(function* (input: Partial<RecordedStart> = {}) {
    const started = yield* sessions.startRecorded({ file, title: undefined, vocab: [], realtime: false, model: defaultClaude, ...input });
    const events = yield* Stream.runCollect(started.events);
    expect(events.at(-1)?.type).toBe("finished");
    return { dir: started.dir, events };
  });
  return { root, sessionsDir, file, selfFile, helpers, sessions, run, updater: { inputs } };
});

type Line = Record<string, unknown> & { type: string };
const logLines = (dir: string): Line[] => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
const onlySession = (sessionsDir: string) => {
  const names = readdirSync(sessionsDir).filter((name) => existsSync(join(sessionsDir, name, "log.jsonl")));
  expect(names).toHaveLength(1);
  return join(sessionsDir, names[0]!);
};
const remarksOf = (lines: Line[]) => lines.filter((line) => line.type === "remark").map((line) => line.remark as { id: string; track: string; start: number; end: number; text: string });
const THREE: Script = { duration: 3484, remarks: [
  { start: 590, end: 600, text: "最初の発言です" },
  { start: 600, end: 660, text: "次の発言です" },
  { start: 700, end: 750, text: "三つ目の発言です" },
] };
const flagOf = (flag: string) => (args: string[]) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const fromOf = flagOf("--from");
const selfFromOf = flagOf("--self-from");
const expectNoOverlap = (remarks: { start: number; end: number; text: string }[]) => {
  for (const [i, remark] of remarks.entries()) if (i > 0) expect(remark.start).toBeGreaterThanOrEqual(remarks[i - 1]!.end);
  expect(new Set(remarks.map((x) => x.text)).size).toBe(remarks.length);
};
const spoken = (track: "相手" | "自分", r: Remark): unknown[] => remarkEvents(r, track);

describe("Sessions と録画 sink の保存・再起動", () => {
  describe("フォルダ名と log.jsonl の時刻の基準", () => {
    const CREATED = "2026-10-01T01:02:03Z";
    const FOLDER = "2026-10-01T01-02-03.000Z";
    const folderTime = (dir: string) => Date.parse(basename(dir).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));
    // log.jsonl に書かれた時刻のすべて: 各行の at と、diff の call の startedAt・endedAt
    const loggedTimes = (lines: Line[]) => lines.flatMap((l) => [
      l.at as string,
      ...(l.type === "diff" && l.call !== undefined ? [(l.call as { startedAt: string }).startedAt, (l.call as { endedAt: string }).endedAt] : []),
    ]).map((t) => Date.parse(t));

    it.live("作成日時を持つファイルでは、フォルダ名がその日時になり、log.jsonl のすべての時刻（at と diff の call）がその日時から数分以内になる。問い合わせはそのファイルの絶対パス", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, creationDate: CREATED });
      yield* r.run();

      expect(r.helpers.creationDateCalls).toEqual([resolve(r.file)]);
      const dir = onlySession(r.sessionsDir);
      expect(basename(dir)).toBe(FOLDER);
      const lines = logLines(dir);
      expect(lines.some((l) => l.type === "diff" && l.call !== undefined)).toBe(true);
      const created = Date.parse(CREATED);
      const times = loggedTimes(lines);
      expect(times.length).toBeGreaterThan(lines.length);
      for (const time of times) {
        expect(time).toBeGreaterThanOrEqual(created);
        expect(time).toBeLessThan(created + 5 * 60_000);
      }
    }).pipe(Effect.scoped));

    it.live.each([
      { name: "作成日時を持たないファイル（null）", creationDate: null },
      { name: "作成日時を読めないファイル（問い合わせの失敗）", creationDate: "fail" as const },
    ])("$name では、フォルダ名と log.jsonl のすべての時刻が、流し始めた今の時刻になり、セッションは止まらない", ({ creationDate }) => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, creationDate });
      const before = Date.now();
      yield* r.run();
      const after = Date.now();

      const dir = onlySession(r.sessionsDir);
      expect(basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
      expect(folderTime(dir)).toBeGreaterThanOrEqual(before - 1);
      expect(folderTime(dir)).toBeLessThanOrEqual(after + 1);
      const lines = logLines(dir);
      expect(remarksOf(lines)).toHaveLength(3);
      for (const time of loggedTimes(lines)) {
        expect(time).toBeGreaterThanOrEqual(before - 1);
        expect(time).toBeLessThanOrEqual(after + 1);
      }
      expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
    }).pipe(Effect.scoped));

    it.live("同じ名前のフォルダが既にあるときは使い回さず、-2 を付けた新しいフォルダに書く。既にあるフォルダの log.jsonl と 相手.m4a は変わらない", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, creationDate: CREATED });
      const existing = join(r.sessionsDir, FOLDER);
      mkdirSync(existing, { recursive: true });
      writeFileSync(join(existing, "log.jsonl"), "前のセッション\n");
      writeFileSync(join(existing, "相手.m4a"), "前の音声");

      yield* r.run();

      expect(readdirSync(r.sessionsDir).filter((name) => name !== "vocabulary.json").sort()).toEqual([FOLDER, `${FOLDER}-2`]);
      expect(readFileSync(join(existing, "log.jsonl"), "utf8")).toBe("前のセッション\n");
      expect(readFileSync(join(existing, "相手.m4a"), "utf8")).toBe("前の音声");
      const dir = join(r.sessionsDir, `${FOLDER}-2`);
      expect(r.helpers.calls[0]).toEqual(["transcribe-file", "--file", resolve(r.file), "--audio-dir", dir]);
      expect(remarksOf(logLines(dir))).toHaveLength(3);
      expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
    }).pipe(Effect.scoped));
  });

  it.live.each([
    { name: "終了コード 1", exit: { code: 1, signal: null } },
  ])("ヘルパーが $name で落ちると、最後に作った発言の end（660）から読み直す。--audio-dir は渡さない。発言は重ならず抜けもなく、番号も続く。同じセッションへ続ける", ({ exit }) => Effect.gen(function* () {
    const r = yield* resource(THREE, { attempts: [{ duration: 3484, remarks: THREE.remarks.slice(0, 2), exit }] });
    yield* r.run();

    const dir = onlySession(r.sessionsDir);
    expect(r.helpers.calls).toHaveLength(2);
    expect(r.helpers.calls[0]).toEqual(["transcribe-file", "--file", resolve(r.file), "--audio-dir", dir]);
    expect(r.helpers.calls[1]).toEqual(expect.arrayContaining(["transcribe-file", "--file", resolve(r.file), "--from", "660"]));
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    expect(fromOf(r.helpers.calls[1]!)).toBe("660");

    const lines = logLines(dir);
    const remarks = remarksOf(lines);
    expect(remarks.map((x) => ({ id: x.id, start: x.start, end: x.end, text: x.text }))).toEqual([
      { id: "r1", start: 590, end: 600, text: "最初の発言です" },
      { id: "r2", start: 600, end: 660, text: "次の発言です" },
      { id: "r3", start: 700, end: 750, text: "三つ目の発言です" },
    ]);
    expectNoOverlap(remarks);
    expect(r.updater.inputs.map((input) => input.fresh.map((remark) => remark.id))).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(lines.filter((l) => l.type === "intake-stopped")).toEqual([expect.objectContaining({ code: exit.code, signal: exit.signal })]);
    expect(lines.filter((l) => l.type === "intake-restarted")).toHaveLength(1);
    expect(lines.some((l) => l.type === "intake-gave-up")).toBe(false);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
    expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
  }).pipe(Effect.scoped));

  it.live("作った発言がまだ無いうちに落ちたら、--from は渡さず頭から読み直す。何も捨てない", () => Effect.gen(function* () {
    const r = yield* resource(THREE, { attempts: [{ duration: 3484, remarks: [], exit: { code: 1, signal: null } }] });
    yield* r.run();

    expect(r.helpers.calls).toHaveLength(2);
    expect(r.helpers.calls[1]).not.toContain("--from");
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    expect(remarksOf(logLines(onlySession(r.sessionsDir))).map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
  }).pipe(Effect.scoped));

  it.live("--self の 2 トラックでは、トラックごとに最後に作った発言の end（相手 10・自分 6）から読み直す（--from と --self-from）。--self-file も渡し、--audio-dir は渡さない", () => Effect.gen(function* () {
    const mine = { start: 5, end: 6, text: "自分の発言です" };
    const theirs = { start: 8, end: 10, text: "相手の発言です" };
    const next = { start: 12, end: 14, text: "続きの発言です" };
    const r = yield* resource(THREE, {
      attempts: [
        { duration: 20, remarks: [], events: [...spoken("相手", theirs), ...spoken("自分", mine)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [...spoken("相手", theirs), ...spoken("自分", mine), ...spoken("相手", next)] },
      ],
    });
    yield* r.run({ selfFile: r.selfFile });

    expect(r.helpers.calls).toHaveLength(2);
    expect(fromOf(r.helpers.calls[1]!)).toBe("10");
    expect(selfFromOf(r.helpers.calls[1]!)).toBe("6");
    expect(r.helpers.calls[1]).toEqual(expect.arrayContaining(["--self-file", resolve(r.selfFile)]));
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => [x.track, x.end, x.text])).toEqual([
      ["自分", 6, "自分の発言です"], ["相手", 10, "相手の発言です"], ["相手", 14, "続きの発言です"],
    ]);
  }).pipe(Effect.scoped));

  it.live("--self で、自分 の確定結果が届く前に、相手 のより後ろの発言を作って落ちても、自分 の発言は抜けない（--self-from は渡さず、自分 は頭から読み直す）。発言は end の順に 1 回ずつ", () => Effect.gen(function* () {
    const mine = { start: 5, end: 6, text: "自分の発言です" };
    const theirs = { start: 8, end: 10, text: "相手の発言です" };
    const next = { start: 12, end: 14, text: "続きの発言です" };
    const r = yield* resource(THREE, {
      attempts: [
        { duration: 20, remarks: [], events: spoken("相手", theirs), exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [...spoken("相手", theirs), ...spoken("自分", mine), ...spoken("相手", next)] },
      ],
    });
    yield* r.run({ selfFile: r.selfFile });

    expect(r.helpers.calls).toHaveLength(2);
    expect(fromOf(r.helpers.calls[1]!)).toBe("10");
    expect(r.helpers.calls[1]).toContain("--self-file");
    expect(r.helpers.calls[1]).not.toContain("--self-from");
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => [x.id, x.track, x.end, x.text])).toEqual([
      ["r1", "自分", 6, "自分の発言です"], ["r2", "相手", 10, "相手の発言です"], ["r3", "相手", 14, "続きの発言です"],
    ]);
  }).pipe(Effect.scoped));

  it.live("--self で両トラックの発言を作っていれば、トラックごとの end から読み直し、各トラックで開始位置より前の流し直しは捨てる。発言の番号は r1 から続く", () => Effect.gen(function* () {
    const mineFirst = { start: 1, end: 2, text: "自分の最初の発言です" };
    const theirs = { start: 8, end: 10, text: "相手の発言です" };
    const mineNext = { start: 5, end: 6, text: "自分の続きの発言です" };
    const theirsNext = { start: 12, end: 14, text: "相手の続きの発言です" };
    const r = yield* resource(THREE, {
      attempts: [
        { duration: 20, remarks: [], events: [...spoken("自分", mineFirst), ...spoken("相手", theirs)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [...spoken("自分", mineFirst), ...spoken("相手", theirs), ...spoken("自分", mineNext), ...spoken("相手", theirsNext)] },
      ],
    });
    yield* r.run({ selfFile: r.selfFile });

    expect(fromOf(r.helpers.calls[1]!)).toBe("10");
    expect(selfFromOf(r.helpers.calls[1]!)).toBe("2");
    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => [x.id, x.track, x.end])).toEqual([["r1", "自分", 2], ["r2", "自分", 6], ["r3", "相手", 10], ["r4", "相手", 14]]);
  }).pipe(Effect.scoped));

  it.live.each([false, true])("録画の最初の起動だけ音声を書き、自分用の録音の有無を引数へ渡す（selfTrack=%s）", (selfTrack) => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const { dir } = yield* r.run(selfTrack ? { selfFile: r.selfFile } : {});
    expect(r.helpers.calls).toEqual([["transcribe-file", "--file", r.file, ...(selfTrack ? ["--self-file", r.selfFile] : []), "--audio-dir", dir]]);
    expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
    expect(existsSync(join(dir, "自分.m4a"))).toBe(selfTrack);
    if (selfTrack) expect(readFileSync(join(dir, "自分.m4a"), "utf8")).toBe(HELPER_SELF_AUDIO);
    expect(readdirSync(dir)).not.toContain("meeting.m4a");
  }).pipe(Effect.scoped));

  it.live("作成日時と既定の題名はメインのファイルで決め、自分用のファイルには問い合わせない", () => Effect.gen(function* () {
    const r = yield* resource({ ...THREE, creationDate: "2026-10-01T01:02:03Z" });
    const { dir } = yield* r.run({ selfFile: r.selfFile });
    expect(r.helpers.creationDateCalls).toEqual([r.file]);
    expect(basename(dir)).toBe("2026-10-01T01-02-03.000Z");
    expect(logLines(dir).find((line) => line.type === "start")).toMatchObject({ title: "meeting" });
  }).pipe(Effect.scoped));

  it.live("指定した題名とユーザー語彙を録画 sink のログへ渡す", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const { dir } = yield* r.run({ title: "週次会議", vocab: ["ヤマダ商事", "アルファ"] });
    const lines = logLines(dir);
    expect(lines.find((line) => line.type === "start")).toMatchObject({ title: "週次会議" });
    expect(lines.filter((line) => line.type === "vocab").flatMap((line) => line.words as { surface: string; source: string }[]).filter((word) => word.source === "user").map((word) => word.surface)).toEqual(["ヤマダ商事", "アルファ"]);
  }).pipe(Effect.scoped));
  it.live.each([false, true])("諦めてもログと書き出しを残す（接続失敗=%s）", (failLaunch) => Effect.gen(function* () {
    const first: Script = { ...THREE, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } };
    const r = yield* resource(first, failLaunch ? { attempts: [first, { remarks: [], failLaunch: true }, { remarks: [], failLaunch: true }] } : {});
    const { dir, events } = yield* r.run();
    const lines = logLines(dir);
    const ids = remarksOf(lines).map((remark) => remark.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids).toEqual(["r1", "r2"].slice(0, ids.length));
    expect(lines.filter((line) => line.type === "intake-gave-up")).toEqual([expect.objectContaining({ reason: "failures" })]);
    expect(events.at(-1)).toMatchObject({ type: "finished", failure: { code: 1, signal: null, stderrTail: [failLaunch ? "起動できない" : "helper stderr"] } });
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
  }).pipe(Effect.scoped));

  it.live("接続待ちでstopしても、入れた発言でmap.*を書き出す", () => Effect.gen(function* () {
    const r = yield* resource(THREE, {
      attempts: [{ duration: 3484, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } }, { remarks: [], blockLaunch: true }],
    });
    const running = yield* Effect.forkChild(r.run());
    yield* Effect.promise(() => vi.waitFor(() => expect(r.helpers.calls).toHaveLength(2)));
    yield* r.sessions.stop;
    const result = yield* Effect.result(Fiber.join(running));

    expect(Result.isSuccess(result)).toBe(true);
    const dir = onlySession(r.sessionsDir);
    expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(existsSync(join(dir, "map.md"))).toBe(true);
  }).pipe(Effect.scoped));

  it.live.each([false, true])("書き込みが失敗しても録画のイベント列を閉じ、次の録画を始められる（stop経由=%s）", (hold) => Effect.gen(function* () {
    const failing = failingLogWrite();
    const r = yield* resource({ ...THREE, hold }, { fileSystem: failing.layer });
    const input = { file: r.file, title: undefined, vocab: [], realtime: false, model: defaultClaude };
    const started = yield* r.sessions.startRecorded(input);
    const reading = yield* Effect.forkChild(Stream.runCollect(started.events));
    yield* Effect.promise(() => vi.waitFor(() => expect(failing.writes.failed).toBe(1), { timeout: 10_000 }));
    if (hold) yield* Effect.exit(r.sessions.stop);
    const events = yield* Fiber.join(reading).pipe(Effect.timeout("10 seconds"));
    expect(events.filter((event) => event.type === "finished")).toEqual([]);
    const before = r.helpers.calls.length;
    const next = yield* r.sessions.startRecorded(input);
    expect(r.helpers.calls).toHaveLength(before + 1);
    if (hold) yield* r.sessions.stop;
    const completed = yield* Stream.runCollect(next.events).pipe(Effect.timeout("10 seconds"));
    expect(completed.at(-1)?.type).toBe("finished");
  }).pipe(Effect.scoped));

});
