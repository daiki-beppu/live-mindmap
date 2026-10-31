import { defaultClaude } from "../src/modelSelection.ts";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import { DiffUpdater, mapOnlyReviewEvents, restoreState } from "../src/core/index.ts";
import { buildReviewTimeline, snapshotAt } from "../../web/src/reviewTimeline.ts";
import type { DiffInput, IntakeLogEvent, Remark, SpeakerNamesFrame } from "../src/core/index.ts";
import { createSessionDir, EXPORT_FILE, LOG_FILE, openLoggedSession, openLoggedTranscriptSession } from "../src/sessionFiles.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import type { ViewerFrame } from "../src/viewers.ts";

it.effect("堂々巡りの frame は通知行をファイルに保存してから配信する", () => Effect.gen(function* () {
  const dir = yield* sessionsDir;
  const sent: ViewerFrame[] = [];
  const opened = yield* openLoggedSession({ model: defaultClaude, dir, title: "合成会議", send: (frame) => Effect.sync(() => {
    if (frame.type !== "discussion-notice") return;
    const rows: unknown[] = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toContainEqual(expect.objectContaining({ type: "discussion-notice", pointId: "n1", at: 700, text: frame.text }));
    sent.push(frame);
  }) }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, updaterLayer((input) => Effect.succeed({
    ops: input.map.order.length > 1 ? [] : [
      { op: "add", ref: "point", parent: "root", kind: "論点", text: "進め方", evidence: [input.fresh[0]!.id] },
      ...["A", "B", "C"].map((ref) => ({ op: "add" as const, ref, parent: "point", kind: "案" as const, text: ref, evidence: [input.fresh[0]!.id] })),
    ],
  })))));
  yield* opened.session.push({ ...remark(1), start: 0, end: 1 });
  yield* opened.session.idle;
  yield* opened.session.push({ ...remark(2), start: 699, end: 700 });
  yield* opened.session.idle;
  expect(sent).toEqual([{ type: "discussion-notice", text: "「進め方」が 11 分決まっていません。何を重視して決めるかを先に確かめませんか" }]);
}));

// セッションのフォルダへの書き込み（log.jsonl の追記・export.json・フォルダ名）の契約。
// 書き込みは FileSystem 経由の非同期になるので、同期の書き込みで自然に成り立っていた次の性質を固定する:
// 呼んだ順に行が並ぶこと、最後に書かれた export.json が最新であること、時刻は Effect を実行した時点の実時刻であること、
// ログが書けないのは defect であること。

const sessionsDir = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-log-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

it.effect("補足は次のdiffと同じsnapshotで送り、保存したログとexportにも同じ結果を残す", () => Effect.gen(function* () {
  const dir = yield* sessionsDir;
  const completed = yield* Deferred.make<void>();
  const frames: ViewerFrame[] = [];
  const updater = DiffUpdater.of({
    update: (input) => Effect.succeed({ ops: input.map.order.length === 1
      ? [{ op: "add", ref: "topic", parent: "root", kind: "議題", text: "SLA", evidence: ["r1"] }] : [] }),
    supplement: () => Effect.gen(function* () {
      yield* Deferred.succeed(completed, undefined);
      return { op: { op: "add" as const, parent: "n1", text: "サービス水準の合意", evidence: ["r1"], origin: "会議の外" as const }, category: "用語" as const, term: "SLA" };
    }),
  });
  const { session } = yield* openLoggedSession({ model: defaultClaude, dir, send: (frame) => Effect.sync(() => { frames.push(frame); }) })
    .pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Layer.succeed(DiffUpdater, updater))));
  yield* session.push(remark(1));
  yield* session.idle;
  yield* Deferred.await(completed);
  yield* TestClock.adjust(0);
  expect(frames.filter((frame) => frame.type === "snapshot")).toHaveLength(2);
  yield* session.push(remark(2));
  yield* session.idle;
  const snapshots = frames.flatMap((frame) => frame.type === "snapshot" ? [frame.snapshot] : []);
  expect(snapshots).toHaveLength(3);
  expect(snapshots[2]!.nodes).toContainEqual(expect.objectContaining({ kind: "補足", text: "サービス水準の合意", parent: "n1" }));
  const events: unknown[] = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const restored = yield* restoreState(events);
  expect(restored.map.order.map((id) => restored.map.nodes[id])).toEqual(snapshots[2]!.nodes);
  const exported: { root: { children: unknown[] } } = JSON.parse(readFileSync(join(dir, EXPORT_FILE), "utf8"));
  expect(exported.root.children).toContainEqual(expect.objectContaining({ text: "SLA", children: expect.arrayContaining([expect.objectContaining({ kind: "補足", text: "サービス水準の合意" })]) }));
}));

for (const scenario of [
  { name: "後続受信なし", batch: false, later: false, processed: 1, at: 20 },
  { name: "diff待機中に後続受信", batch: false, later: true, processed: 1, at: 20 },
  { name: "2発言のうち1件を部分反映", batch: true, later: false, processed: 1, at: 20 },
  { name: "2発言を全件反映", batch: true, later: false, processed: 2, at: 30 },
]) {
  it.effect(`${scenario.name}でも保存した補足は同梱diffの処理時刻で見返しに現れる`, () => Effect.gen(function* () {
    const dir = yield* sessionsDir;
    const firstStarted = yield* Deferred.make<void>();
    const firstRelease = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const secondRelease = yield* Deferred.make<void>();
    const remainingRelease = yield* Deferred.make<void>();
    const supplementCompleted = yield* Deferred.make<void>();
    const published = yield* Deferred.make<void>();
    const frames: ViewerFrame[] = [];
    let calls = 0;
    const updater = DiffUpdater.of({
      update: (input) => Effect.gen(function* () {
        calls++;
        if (calls === 1) {
          yield* Deferred.succeed(firstStarted, undefined);
          yield* Deferred.await(firstRelease);
          return { ops: [{ op: "add" as const, ref: "topic", parent: "root", kind: "議題" as const, text: "SLA", evidence: ["r1"] }] };
        }
        if (calls === 2) {
          expect(input.fresh.map((r) => r.id)).toEqual(scenario.batch ? ["r2", "r3"] : ["r2"]);
          yield* Deferred.succeed(secondStarted, undefined);
          yield* Deferred.await(secondRelease);
          return { processedRemarks: scenario.processed, ops: [{ op: "add" as const, ref: "detail", parent: "n1", kind: "要点" as const, text: "運用水準", evidence: ["r2"] }] };
        }
        yield* Deferred.await(remainingRelease);
        return { ops: [] };
      }),
      supplement: () => Effect.gen(function* () {
        yield* Deferred.succeed(supplementCompleted, undefined);
        return { op: { op: "add" as const, parent: "n1", text: "サービス水準の合意", evidence: ["r1"], origin: "会議の外" as const }, category: "用語" as const, term: "SLA" };
      }),
    });
    const { session } = yield* openLoggedSession({ model: defaultClaude, dir, send: (frame) => Effect.gen(function* () {
      frames.push(frame);
      if (frame.type === "snapshot" && frame.snapshot.nodes.some((n) => n.text === "運用水準")) yield* Deferred.succeed(published, undefined);
    }) }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Layer.succeed(DiffUpdater, updater))));
    yield* session.push({ ...remark(1), start: 0, end: 10 });
    yield* Deferred.await(firstStarted);
    yield* session.push({ ...remark(2), start: 10, end: 20 });
    if (scenario.batch) yield* session.push({ ...remark(3), start: 20, end: 30 });
    yield* Deferred.succeed(firstRelease, undefined);
    yield* Deferred.await(secondStarted);
    yield* Deferred.await(supplementCompleted);
    yield* TestClock.adjust(0);
    expect(frames.filter((f) => f.type === "snapshot")).toHaveLength(2);
    if (scenario.later) yield* session.push({ ...remark(3), start: 20, end: 30 });
    expect(frames.filter((f) => f.type === "snapshot")).toHaveLength(2);
    yield* Deferred.succeed(secondRelease, undefined);
    yield* Deferred.await(published);
    const snapshots = frames.flatMap((f) => f.type === "snapshot" ? [f.snapshot] : []);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]!.nodes.map((n) => n.text)).toEqual(expect.arrayContaining(["運用水準", "サービス水準の合意"]));
    const events: unknown[] = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect.soft(events).toContainEqual(expect.objectContaining({ type: "supplement", reflectedAt: scenario.at }));
    for (const rows of [events, mapOnlyReviewEvents(events)]) {
      const timeline = buildReviewTimeline(rows);
      const before = snapshotAt(timeline, scenario.at - 0.001);
      expect(before.nodes.map((n) => n.text)).not.toContain("運用水準");
      expect(before.nodes.filter((n) => n.kind === "補足")).toEqual([]);
      const after = snapshotAt(timeline, scenario.at);
      expect.soft(after.nodes).toEqual(snapshots[2]!.nodes);
    }
    yield* Deferred.succeed(remainingRelease, undefined);
    yield* session.flush;
  }).pipe(Effect.scoped));
}

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
    if (frame.type === "snapshot") published.push(frame.snapshot.nodes.length);
  }) }).pipe(
    Effect.provide(Layer.mergeAll(updaterLayer((input) => Effect.sync(() => (inputs.push(input), { ops: [] }))), NodeFileSystem.layer)),
  );
  const lines = () => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const exported = () => JSON.parse(readFileSync(join(dir, "export.json"), "utf8")) as unknown;
  return { root, dir, ...opened, inputs, published, frames, lines, exported };
});

const namedRemark = (n: number): Remark => ({ ...remark(n), speaker: "相手 A" });
const inferredName = { label: "相手 A", name: "たなか", evidence: "r1", basis: "名乗り" } as const;

describe("ログを開いたセッションの名前", () => {
  it.effect("推定後の手入力がログ待ちの間に中断されても、競合する名前とともにログ・export・frameへ届き、再送では増えない", () => Effect.gen(function* () {
    const dir = yield* sessionsDir;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let armed = false;
    const files = Layer.effect(FileSystem.FileSystem, Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        ...fs,
        writeFileString: (path, data, options) => Effect.suspend(() => {
          const write = fs.writeFileString(path, data, options);
          if (!armed || path !== join(dir, LOG_FILE)) return write;
          armed = false;
          return Effect.andThen(Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), write));
        }),
      } satisfies FileSystem.FileSystem;
    })).pipe(Layer.provide(NodeFileSystem.layer));
    const frames: SpeakerNamesFrame[] = [];
    const { session, appendLog } = yield* openLoggedSession({ model: defaultClaude, dir,
      send: (frame) => Effect.sync(() => { if (frame.type === "speaker-names") frames.push(frame); }),
    }).pipe(Effect.provide(Layer.merge(files, updaterLayer(() => Effect.succeed({ ops: [], names: [inferredName] })))));
    yield* session.push(namedRemark(1));
    yield* session.flush;
    expect(frames).toEqual([
      { type: "speaker-names", names: [] },
      { type: "speaker-names", names: [{ label: "相手 A", name: "たなか" }] },
    ]);
    yield* session.push(namedRemark(2));
    yield* session.flush;

    yield* Effect.gen(function* () {
      armed = true;
      const holder = yield* Effect.forkChild(appendLog(note(1)));
      yield* Deferred.await(entered);
      const request = yield* Effect.forkChild(session.nameSpeaker({ label: "相手 A", name: "田中", source: "手入力" }), { startImmediately: true });
      const other = yield* Effect.forkChild(session.nameSpeaker({ label: "相手 B", name: "鈴木", source: "手入力" }), { startImmediately: true });
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(request), { startImmediately: true });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(interrupting);
      yield* Fiber.join(other);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));

    const expectedNames = { "相手 A": "田中", "相手 B": "鈴木" };
    expect(JSON.parse(readFileSync(join(dir, EXPORT_FILE), "utf8"))).toHaveProperty("speakerNames", expectedNames);
    const names = () => readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n")
      .map((line): Record<string, unknown> => JSON.parse(line)).filter((event) => event.type === "speaker-name");
    expect(names().map(({ label, name, source }) => ({ label, name, source }))).toEqual([
      { label: "相手 A", name: "たなか", source: "推定" },
      { label: "相手 A", name: "田中", source: "手入力" },
      { label: "相手 B", name: "鈴木", source: "手入力" },
    ]);
    expect(frames).toEqual([
      { type: "speaker-names", names: [] },
      { type: "speaker-names", names: [{ label: "相手 A", name: "たなか" }] },
      { type: "speaker-names", names: [{ label: "相手 A", name: "田中" }] },
      { type: "speaker-names", names: [{ label: "相手 A", name: "田中" }, { label: "相手 B", name: "鈴木" }] },
    ]);
    const count = frames.length;
    yield* session.nameSpeaker({ label: "相手 A", name: "田中", source: "手入力" });
    expect(names()).toHaveLength(3);
    expect(frames).toHaveLength(count);
  }).pipe(Effect.scoped));

  it.effect("送り口なしでも推定名をログと export に保存する", () => Effect.gen(function* () {
    const dir = yield* sessionsDir;
    const inputs: DiffInput[] = [];
    const { session } = yield* openLoggedSession({ model: defaultClaude, dir }).pipe(
      Effect.provide(Layer.merge(NodeFileSystem.layer, updaterLayer((input) => Effect.sync(() => {
        inputs.push(input);
        return { ops: [], names: [{ ...inferredName, name: inputs.length === 1 ? "たなか" : "田中" }] };
      })))),
    );
    for (const n of [1, 2]) {
      yield* session.push(namedRemark(n));
      yield* session.flush;
      const expectedNames = { "相手 A": n === 1 ? "たなか" : "田中" };
      expect(JSON.parse(readFileSync(join(dir, EXPORT_FILE), "utf8"))).toHaveProperty("speakerNames", expectedNames);
    }
    const lines = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line): Record<string, unknown> => JSON.parse(line));
    expect(lines.filter((line) => line.type === "speaker-name")).toEqual([
      expect.objectContaining({ label: "相手 A", name: "たなか", source: "推定" }),
      expect.objectContaining({ label: "相手 A", name: "田中", source: "推定" }),
    ]);
  }).pipe(Effect.scoped));

  for (const noMap of [false, true]) {
    it.effect(`${noMap ? "地図なし" : "モデル付き"}でも手入力の初回設定・変更を追加発言なしで保存し、変化したときだけ名前を送る`, () => Effect.gen(function* () {
      const dir = yield* sessionsDir;
      const frames: SpeakerNamesFrame[] = [];
      const options = { dir,
        send: (frame) => Effect.sync(() => { if (frame.type === "speaker-names") frames.push(frame); }),
      } satisfies Parameters<typeof openLoggedTranscriptSession>[0];
      const { session } = yield* (noMap
        ? openLoggedTranscriptSession(options)
        : openLoggedSession({ ...options, model: defaultClaude }).pipe(Effect.provide(updaterLayer(() => Effect.succeed({ ops: [] }))))
      ).pipe(Effect.provide(NodeFileSystem.layer));
      yield* session.push(namedRemark(1));
      yield* session.flush;
      for (const name of ["田中", "鈴木"]) {
        yield* session.nameSpeaker({ label: "相手 A", name, source: "手入力" });
        expect(JSON.parse(readFileSync(join(dir, EXPORT_FILE), "utf8"))).toHaveProperty("speakerNames", { "相手 A": name });
        yield* session.nameSpeaker({ label: "相手 A", name, source: "手入力" });
      }
      expect(frames).toEqual([
        { type: "speaker-names", names: [] },
        { type: "speaker-names", names: [{ label: "相手 A", name: "田中" }] },
        { type: "speaker-names", names: [{ label: "相手 A", name: "鈴木" }] },
      ]);
      const lines = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line): Record<string, unknown> => JSON.parse(line));
      expect(lines.filter((line) => line.type === "speaker-name")).toEqual([
        expect.objectContaining({ label: "相手 A", name: "田中", source: "手入力", at: expect.any(String) }),
        expect.objectContaining({ label: "相手 A", name: "鈴木", source: "手入力", at: expect.any(String) }),
      ]);
    }).pipe(Effect.scoped));
  }

  it.effect("名前変更時にexportだけ保存できないときはdefectになる", () => Effect.gen(function* () {
    const dir = yield* sessionsDir;
    const { session } = yield* openLoggedTranscriptSession({ dir }).pipe(Effect.provide(NodeFileSystem.layer));
    yield* session.push(namedRemark(1));
    rmSync(join(dir, EXPORT_FILE));
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(join(dir, EXPORT_FILE));
    const exit = yield* Effect.exit(session.nameSpeaker({ label: "相手 A", name: "田中", source: "手入力" }));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true);
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped));
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
