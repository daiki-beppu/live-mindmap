import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { defaultClaude } from "../src/modelSelection.ts";
import { DiffUpdater, type DiffInput, type Op, type Snapshot } from "../src/core/index.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// Issue #1023: 実物の SessionSinks（話者のラベルを振る本物の仕組み）に、ヘルパーの speaker と発言を流し、
// 偽の AI が台本どおりの操作を返す。案の出した人・TODO の担当の話者が、画面へ公開するスナップショットと log.jsonl に出ることを確かめる。

const fileIo = trackedFileSystem();
const { settle, settleUntil } = fileIo;
const sinksLayer = (updaterLayer: Layer.Layer<DiffUpdater>) =>
  SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer) }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer })));

const segment = (slot: number, start: number, end: number) => ({ type: "speaker", track: "相手", start, end, slot, final: true }) as const;
const settledAt = (to: number) => ({ type: "speaker-settled", track: "相手", to }) as const;
const logEvents = (dir: string) => readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

// i 回目の差分更新の呼び出しに script[i] の操作を返す偽の AI。入力も記録する
const scripted = (script: Op[][]) => {
  const calls: DiffInput[] = [];
  const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({ update: (input) => Effect.sync(() => ({ ops: script[calls.push(input) - 1] ?? [] })) }));
  return { calls, updaterLayer };
};

describe("案の出した人と TODO の担当の話者（実物の SessionSinks + 偽の AI）", () => {
  it.effect("出した人は追加時の最初の根拠の話者になり、更新では変わらず、統合では早いほうが残る。log.jsonl と公開したスナップショットの両方に出る", () => {
    const { calls, updaterLayer } = scripted([
      // 1 回目 r1（相手 A）: 論点と、r1 を根拠にした案、話者なしの自分のトラックの案は 3 回目
      [
        { op: "add", ref: "t1", parent: "root", kind: "論点", text: "開催頻度", evidence: ["r1"] }, // n1
        { op: "add", ref: "t2", parent: "t1", kind: "案", text: "週 1", evidence: ["r1"] }, // n2
      ],
      // 2 回目 r2（相手 B）: 相手 B の案。前からある r1 を根拠に足す更新は出した人を変えない
      [
        { op: "add", ref: "t3", parent: "n1", kind: "案", text: "月 1", evidence: ["r2"] }, // n3
        { op: "update", node: "n3", evidence: ["r1"] },
      ],
      // 3 回目 r3（自分）: 自分の案、統合（統合元 n3 は根拠の最も早い発言が r1 なので、統合先 n4 の r3 より早い）
      [
        { op: "add", ref: "t4", parent: "n1", kind: "案", text: "隔週", evidence: ["r3"] }, // n4
        { op: "combine", from: "n3", into: "n4" },
      ],
    ]);
    return Effect.scoped(Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "people-it-"))), (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))));
      const published: Snapshot[] = [];
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次",
        publish: (s) => Effect.sync(() => void published.push(s)), speak: () => Effect.void, speakerNames: () => Effect.void });
      const say = (n: number, slot: number, start: number, track: "相手" | "自分" = "相手") => Effect.gen(function* () {
        if (track === "相手") { yield* sink.speaker(segment(slot, start, start + 2)); yield* sink.speaker(settledAt(start + 2)); }
        yield* sink.final({ track, start, end: start + 2, text: `発言${n}です` });
        yield* settleUntil(() => logEvents(dir).filter((e) => e.type === "diff").length === n);
      });
      yield* say(1, 5, 10); // 相手 A
      yield* say(2, 6, 20); // 相手 B
      yield* say(3, 0, 30, "自分");
      yield* settleUntil(() => published.at(-1)?.nodes.some((n) => n.id === "n4") === true); // 3 回目の反映（統合を含む）の公開を待つ
      yield* settle;

      expect(calls).toHaveLength(3);
      const nodes = published.at(-1)!.nodes;
      const byId = (id: string) => nodes.find((n) => n.id === id);
      expect(byId("n2")?.proposer).toBe("相手 A");
      expect(byId("n3")).toBeUndefined(); // 統合で消えた
      // n3（相手 B の案。r1 を後から根拠に足したが、出した人は 相手 B のまま）が、n4（自分）に統合される。n3 の根拠 r1 のほうが早いので、統合先の出した人は n3 のもの
      expect(byId("n4")?.proposer).toBe("相手 B");
      expect(byId("n4")?.evidence).toEqual(["r3", "r2", "r1"]);

      const diffs = logEvents(dir).filter((e) => e.type === "diff");
      expect(diffs[0].ops.find((op: Op) => op.op === "add" && op.ref === "t2")).toMatchObject({ proposer: "相手 A" });
      expect(diffs[1].ops.find((op: Op) => op.op === "add" && op.ref === "t3")).toMatchObject({ proposer: "相手 B" });
      expect(diffs[1].ops.find((op: Op) => op.op === "update")).not.toHaveProperty("proposer");
      expect(diffs[2].ops.find((op: Op) => op.op === "add" && op.ref === "t4")).toMatchObject({ proposer: "自分" });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("話者なしの相手の発言から出た案の出した人は「相手」になる", () => {
    const { updaterLayer } = scripted([[{ op: "add", ref: "t1", parent: "root", kind: "案", text: "案", evidence: ["r1"] }]]);
    return Effect.scoped(Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "people-it-"))), (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))));
      const published: Snapshot[] = [];
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次",
        publish: (s) => Effect.sync(() => void published.push(s)), speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker({ type: "speaker-off", start: 0, reason: "モデルなし" });
      yield* sink.final({ track: "相手", start: 10, end: 12, text: "話者を取れない発言です" });
      yield* settleUntil(() => logEvents(dir).some((e) => e.type === "diff"));
      yield* settle;
      expect(published.at(-1)!.nodes.find((n) => n.kind === "案")?.proposer).toBe("相手");
      expect(logEvents(dir).find((e) => e.type === "diff").ops[0]).toMatchObject({ proposer: "相手" });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("TODO の担当の話者: セッションにいる話者は担当者になり、いない話者は捨てる。名前があれば名前が優先。log.jsonl には検査後の値だけが残る", () => {
    const { updaterLayer } = scripted([[
      { op: "add", ref: "t1", parent: "root", kind: "TODO", text: "いる話者", evidence: ["r1"], assigneeSpeaker: "相手 A" }, // n1
      { op: "add", ref: "t2", parent: "root", kind: "TODO", text: "自分", evidence: ["r1"], assigneeSpeaker: "自分" }, // n2
      { op: "add", ref: "t3", parent: "root", kind: "TODO", text: "いない話者", evidence: ["r1"], assigneeSpeaker: "相手 Z" }, // n3
      { op: "add", ref: "t4", parent: "root", kind: "TODO", text: "名前優先", evidence: ["r1"], assignee: "田中", assigneeSpeaker: "相手 A" }, // n4
    ]]);
    return Effect.scoped(Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "people-it-"))), (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))));
      const published: Snapshot[] = [];
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次",
        publish: (s) => Effect.sync(() => void published.push(s)), speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(segment(5, 10, 12));
      yield* sink.speaker(settledAt(12));
      yield* sink.final({ track: "相手", start: 10, end: 12, text: "私がやります" });
      yield* settleUntil(() => logEvents(dir).some((e) => e.type === "diff"));
      yield* settle;

      const nodes = published.at(-1)!.nodes;
      const byId = (id: string) => nodes.find((n) => n.id === id)!;
      expect(byId("n1")).toMatchObject({ assigneeSpeaker: "相手 A" });
      expect(byId("n2")).toMatchObject({ assigneeSpeaker: "自分" });
      expect(byId("n3")).not.toHaveProperty("assigneeSpeaker");
      expect(byId("n4")).toMatchObject({ assignee: "田中" });
      expect(byId("n4")).not.toHaveProperty("assigneeSpeaker");

      const ops: Op[] = logEvents(dir).find((e) => e.type === "diff").ops;
      expect(ops[0]).toMatchObject({ assigneeSpeaker: "相手 A" });
      expect(ops[1]).toMatchObject({ assigneeSpeaker: "自分" });
      expect(ops[2]).not.toHaveProperty("assigneeSpeaker");
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });
});

// Issue #1028: 書き出し（map.md・map.json）に人と名前が載る。偽の AI の台本で案・TODO を作り、本物の sink で名前を付けてから書き出す。
describe("書き出しの話者と名前（実物の SessionSinks + 偽の AI）", () => {
  it.effect("map.md と map.json に出した人・担当の話者・名前が載り、名前は書き出しの時点の最後の名前になる", () => {
    const { updaterLayer } = scripted([
      [{ op: "add", ref: "t1", parent: "root", kind: "案", text: "週 1", evidence: ["r1"] }], // n1: 相手 A の案
      [{ op: "add", ref: "t2", parent: "root", kind: "TODO", text: "資料を送る", evidence: ["r2"], assigneeSpeaker: "相手 B", due: "10/15" }], // n2
      [{ op: "add", ref: "t3", parent: "root", kind: "案", text: "隔週", evidence: ["r3"] }], // n3: 自分の案
    ]);
    return Effect.scoped(Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "people-it-"))), (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))));
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次",
        publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      const say = (n: number, slot: number, start: number, track: "相手" | "自分" = "相手") => Effect.gen(function* () {
        if (track === "相手") { yield* sink.speaker(segment(slot, start, start + 2)); yield* sink.speaker(settledAt(start + 2)); }
        yield* sink.final({ track, start, end: start + 2, text: `発言${n}です` });
        yield* settleUntil(() => logEvents(dir).filter((e) => e.type === "diff").length === n);
      });
      yield* say(1, 5, 10); // 相手 A
      yield* say(2, 6, 20); // 相手 B
      yield* say(3, 0, 30, "自分");
      yield* settle;
      const md = () => readFileSync(join(dir, "map.md"), "utf8");
      const json = () => JSON.parse(readFileSync(join(dir, "map.json"), "utf8"));

      // 名前を付ける前: ラベルで出る。json はラベルを持ち、対応表は無い
      yield* sink.exports;
      expect(md()).toContain("- 週 1 — 相手 A（00:10）");
      expect(md()).toContain("- 隔週 — 自分（00:30）");
      expect(md()).toContain("- 資料を送る（担当：相手 B・期限：10/15）（00:20）");
      expect(json()).not.toHaveProperty("speakerNames");

      // 相手 B に名前を付けてから書き出す（TODO は名前を付ける前にできている）
      yield* sink.nameSpeaker({ label: "相手 B", name: "田中" });
      yield* sink.exports;
      expect(md()).toContain("- 資料を送る（担当：田中・期限：10/15）（00:20）");
      expect(md().match(/資料を送る（担当：田中・期限：10\/15）（00:20）/g)).toHaveLength(2); // 冒頭の TODO 一覧とアウトライン
      expect(md()).toContain("- 週 1 — 相手 A（00:10）"); // 名前の無いラベルはそのまま
      expect(json().speakerNames).toEqual({ "相手 B": "田中" });

      // 付け替えた後に書き出せば、最後の名前になる。json のノードはラベルのまま
      yield* sink.nameSpeaker({ label: "相手 B", name: "高橋" });
      yield* sink.nameSpeaker({ label: "相手 A", name: "佐藤" });
      yield* sink.exports;
      expect(md()).toContain("- 資料を送る（担当：高橋・期限：10/15）（00:20）");
      expect(md()).not.toContain("田中");
      expect(md()).toContain("- 週 1 — 佐藤（00:10）");
      expect(md()).toContain("- 隔週 — 自分（00:30）");
      const out = json();
      expect(out.speakerNames).toEqual({ "相手 B": "高橋", "相手 A": "佐藤" });
      const byText = (text: string) => out.root.children.find((c: { text: string }) => c.text === text);
      expect(byText("週 1")).toMatchObject({ proposer: "相手 A", evidence: [{ id: "r1", speaker: "相手 A" }] });
      expect(byText("資料を送る")).toMatchObject({ assigneeSpeaker: "相手 B", due: "10/15", evidence: [{ id: "r2", speaker: "相手 B" }] });
      expect(byText("隔週")).toMatchObject({ proposer: "自分" });
      expect(readFileSync(join(dir, "map.drawnix"), "utf8")).toContain(" → 高橋 · 10/15");
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });
});
