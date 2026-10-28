import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { JsonExport, exportFiles, makeSession, restoreSession, toDrawnix, toJsonExport, toMarkdown, type DiffInput, type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { mapOnlyReviewEvents, reviewSnapshot } from "../src/core/review.ts";
import { restore } from "./fixtures/restore.ts";
import { collectLog, silentLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const criteria = ["採用のしやすさ", "運用負荷"];
const remark: Remark = { id: "r1", track: "相手", start: 1, end: 2, text: "合成の発言" };
const ops = [
  { op: "add", ref: "t", parent: "root", kind: "議題", text: "導入", evidence: ["r1"] },
  { op: "add", ref: "p", parent: "t", kind: "論点", text: "進め方", evidence: ["r1"], criteria: [criteria[1]!] },
  { op: "add", ref: "a", parent: "p", kind: "案", text: "試験導入", evidence: ["r1"], criteria: [criteria[0]!] },
] satisfies Op[];
const events = (): unknown[] => [
  { type: "start", title: "合成会議", criteria },
  { type: "remark", remark },
  { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops, dropped: [] },
];

describe("判断軸のセッション保存と復元", () => {
  it.effect("開始ログと差分操作に軸を残し、全呼び出しと Snapshot に渡す", () => Effect.gen(function* () {
    const logged: LogEvent[] = [];
    const calls: DiffInput[] = [];
    const update = updaterLayer((input) => {
      calls.push(input);
      return Effect.succeed({ ops: calls.length === 1 ? ops : [] });
    });
    const options = { title: "合成会議", criteria };
    const session = yield* makeSession(options).pipe(Effect.provide(Layer.merge(update, collectLog(logged))));
    yield* session.push(remark);
    yield* session.idle;
    yield* session.push({ ...remark, id: "r2", start: 3, end: 4 });
    yield* session.idle;
    expect(calls).toHaveLength(2);
    for (const input of calls) expect(input).toHaveProperty("criteria", criteria);
    expect(logged.find((e) => e.type === "start")).toHaveProperty("criteria", criteria);
    expect(logged.find((e) => e.type === "diff")).toMatchObject({ ops });
    expect(yield* session.snapshot).toHaveProperty("criteria", criteria);
    const restored = yield* restore(logged.map((e) => JSON.parse(JSON.stringify(e))));
    expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
  }));

  it.effect("保存済みの許可軸を復元し、継続したモデル入力にも保持する", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const session = yield* restoreSession(events()).pipe(Effect.provide(Layer.merge(silentLog, updaterLayer((input) => {
      calls.push(input);
      return Effect.succeed({ ops: [] });
    }))));
    const snapshot = yield* session.snapshot;
    expect(snapshot).toHaveProperty("criteria", criteria);
    expect(snapshot.nodes.find((n) => n.id === "n3")).toHaveProperty("criteria", [criteria[0]]);
    expect(calls).toEqual([]);
    yield* session.push({ ...remark, id: "r2", start: 3, end: 4 });
    yield* session.idle;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveProperty("criteria", criteria);
  }));

  it("見返し用ログから時点ごとの関係づけを再構成する", () => {
    const rows = events();
    const before = reviewSnapshot(mapOnlyReviewEvents(rows));
    expect(before).toHaveProperty("criteria", criteria);
    expect(before.nodes.find((n) => n.id === "n3")).toHaveProperty("criteria", [criteria[0]]);
    rows.push(
      { type: "remark", remark: { ...remark, id: "r2", start: 3, end: 4 } },
      { type: "diff", input: { recent: ["r1"], fresh: ["r2"], nodeCount: 3 }, ops: [{ op: "update", node: "n3", evidence: ["r2"], criteria: [criteria[1]!] }], dropped: [] },
    );
    const after = reviewSnapshot(mapOnlyReviewEvents(rows));
    expect(after.nodes.find((n) => n.id === "n3")).toHaveProperty("criteria", [criteria[1]]);
    expect(before.nodes.find((n) => n.id === "n3")).toHaveProperty("criteria", [criteria[0]]);
  });
});

describe("判断軸の書き出し", () => {
  const snapshot = () => ({
    criteria, round: 1, changes: [], remarks: [remark],
    nodes: [
      { id: "root", parent: null, kind: "会議", text: "合成会議", evidence: [] },
      { id: "n1", parent: "root", kind: "論点", text: "進め方", evidence: ["r1"], pointStatus: "未決", criteria: [criteria[1]!] },
      { id: "n2", parent: "n1", kind: "案", text: "試験導入", evidence: ["r1"], criteria: [criteria[0]!] },
      { id: "n3", parent: "n1", kind: "決定", text: "段階導入", evidence: ["r1"], criteria: [criteria[1]!] },
    ],
  } satisfies Parameters<typeof toJsonExport>[0]);

  it("JSON の生成と Schema の読込を通して一覧と各ノードの関係づけが残る", () => {
    const exp = toJsonExport(snapshot(), [remark]);
    const decoded = Schema.decodeUnknownSync(JsonExport)(JSON.parse(exportFiles(exp)["map.json"]));
    expect(decoded).toHaveProperty("criteria", criteria);
    const point = decoded.root.children[0]!;
    expect(point).toHaveProperty("criteria", [criteria[1]]);
    expect(point.children[0]).toHaveProperty("criteria", [criteria[0]]);
    expect(point.children[1]).toHaveProperty("criteria", [criteria[1]]);
  });

  it("Markdown の軸一覧・アウトライン・決定一覧・未決一覧に軸名が出る", () => {
    const md = toMarkdown(toJsonExport(snapshot(), [remark]));
    const section = (heading: string) => md.split(`## ${heading}\n`)[1]!.split("\n## ")[0]!;
    const introduction = md.slice(0, md.indexOf("## 決定\n"));
    expect(introduction.indexOf(criteria[0]!)).toBeGreaterThanOrEqual(0);
    expect(introduction.indexOf(criteria[1]!)).toBeGreaterThan(introduction.indexOf(criteria[0]!));
    expect(section("決定")).toContain(criteria[1]);
    expect(section("未決の論点")).toContain(criteria[1]);
    expect(section("アウトライン")).toContain(criteria[0]);
  });

  it.each([false, true])("話者情報の有無によらず Drawnix の本文に関係づけを添える（話者あり: %s）", (withSpeaker) => {
    const state = snapshot();
    const nodes = state.nodes.map((node) => node.id === "n2" && withSpeaker ? { ...node, proposer: "相手 A" } : node);
    const file = toDrawnix(toJsonExport({ ...state, nodes }, [remark]));
    const plan = file.elements[0]!.children[0]!.children[0]!;
    expect(plan.data.topic.children.map((p) => p.text).join("")).toContain("試験導入");
    expect(plan.data.topic.children.map((p) => p.text).join("")).toContain(criteria[0]);
    if (withSpeaker) expect(plan.data.topic.children.map((p) => p.text).join("")).toContain("相手 A");
  });
});
