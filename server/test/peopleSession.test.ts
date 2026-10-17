import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { playBatches } from "./fixtures/batches.ts";
import { remark, restore } from "./fixtures/restore.ts";

// Issue #1023: 案の出した人と TODO の担当の話者を、本物のセッション（ライブ）が決めて log.jsonl に残し、
// ログからの復元が同じ値で戻す。偽の AI は台本どおりの操作を返す。話者のラベルは、発言に振られたもの（#1021）をそのまま使う。

const viaJsonl = (events: LogEvent[]): unknown[] =>
  events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-01T00:00:0${i % 10}.000Z`, ...e })));

type Peopleless = Record<string, unknown>;
const stripPeople = (events: LogEvent[]): LogEvent[] =>
  events.map((e) => e.type !== "diff" ? e : {
    ...e,
    ops: e.ops.map((op) => {
      const { proposer: _p, assigneeSpeaker: _a, ...rest } = op as Peopleless;
      return rest as Op;
    }),
  });

// 発言は作った順に start が増える（remark の補助関数）。a が最も早い
const play = Effect.fn("play")(function* () {
  const a = remark("来週に開催しましょう", { speaker: "相手 A" });
  const b = remark("月 1 でもいい", { speaker: "相手 B" });
  const x = remark("話者なしの相手", {}); // 話者なしの相手
  const c = remark("私がやります", { track: "自分" }); // 話者なしの自分のトラック
  const d = remark("別の案です", { speaker: "相手 C" });
  const e = remark("まとめましょう", { track: "自分" });
  const script: Op[][] = [
    [
      { op: "add", ref: "t1", parent: "root", kind: "論点", text: "開催頻度", evidence: [a.id] }, // n1
      { op: "add", ref: "t2", parent: "t1", kind: "案", text: "来週開催", evidence: [b.id, a.id] }, // n2: 根拠のうち最も早いのは a
      { op: "add", ref: "t3", parent: "t1", kind: "案", text: "月 1", evidence: [b.id] }, // n3
      { op: "add", ref: "t4", parent: "t1", kind: "案", text: "話者なしの案", evidence: [x.id] }, // n4
      { op: "add", ref: "t5", parent: "t1", kind: "案", text: "自分の案", evidence: [c.id] }, // n5
      { op: "add", ref: "t6", parent: "t1", kind: "TODO", text: "いない話者", evidence: [c.id], assigneeSpeaker: "相手 Z" }, // n6
      { op: "add", ref: "t7", parent: "t1", kind: "TODO", text: "いる話者", evidence: [c.id], assigneeSpeaker: "相手 B" }, // n7
      { op: "add", ref: "t8", parent: "t1", kind: "TODO", text: "名前と話者", evidence: [c.id], assignee: "田中", assigneeSpeaker: "相手 A" }, // n8
      { op: "add", ref: "t9", parent: "root", kind: "課題", text: "課題", evidence: [a.id] }, // n9
    ],
    [
      { op: "update", node: "n3", evidence: [a.id] }, // 前からある最も早い発言を根拠に足しても、出した人は変わらない
      { op: "update", node: "n7", evidence: [d.id], assignee: "鈴木" }, // 名前が分かったら担当の話者は消える
      { op: "add", ref: "u1", parent: "n1", kind: "案", text: "別の案 1", evidence: [d.id] }, // n10
      { op: "add", ref: "u2", parent: "n1", kind: "案", text: "別の案 2", evidence: [d.id] }, // n11
      { op: "add", ref: "u3", parent: "n1", kind: "案", text: "早い案", evidence: [a.id] }, // n12
    ],
    [
      { op: "combine", from: "n10", into: "n2" }, // 統合先が早い: n2 は 相手 A のまま
      { op: "combine", from: "n12", into: "n11" }, // 統合元が早い: n11 は 相手 A になる
    ],
  ];
  return { ...(yield* playBatches([[a, b, x, c], [d], [e]], script)), remarks: { a, b, x, c, d, e } as Record<string, Remark> };
});

const byId = <N extends { id: string }>(nodes: readonly N[], id: string): N => nodes.find((n) => n.id === id)!;

describe("セッション: 案の出した人と TODO の担当の話者", () => {
  it.effect("案の出した人は、追加時の根拠の最も早い発言の話者になる。話者なしの相手は「相手」、自分のトラックは「自分」", () =>
    Effect.gen(function* () {
      const { session } = yield* play();
      const { nodes } = yield* session.snapshot;
      expect(byId(nodes, "n2").proposer).toBe("相手 A"); // 根拠 [b, a] の並びが後ろでも、最も早い a の話者
      expect(byId(nodes, "n3").proposer).toBe("相手 B");
      expect(byId(nodes, "n4").proposer).toBe("相手");
      expect(byId(nodes, "n5").proposer).toBe("自分");
    }));

  it.effect("更新では変わらず、統合では根拠の最も早い発言が早いほうの出した人が残る", () =>
    Effect.gen(function* () {
      const { session } = yield* play();
      const { nodes } = yield* session.snapshot;
      const n3 = byId(nodes, "n3");
      expect(n3.evidence.length).toBe(2); // 最も早い発言 a が根拠に足されている
      expect(n3.proposer).toBe("相手 B"); // それでも、最初に言った 相手 B のまま
      expect(byId(nodes, "n2").proposer).toBe("相手 A"); // 統合元 n10（相手 C）が遅いので、統合先のまま
      expect(byId(nodes, "n11").proposer).toBe("相手 A"); // 統合元 n12（相手 A）が早いので、そちらが残る
      expect(nodes.find((n) => n.id === "n10" || n.id === "n12")).toBeUndefined();
    }));

  it.effect("案・TODO 以外のノードに、人の欄は付かない", () =>
    Effect.gen(function* () {
      const { session } = yield* play();
      for (const n of (yield* session.snapshot).nodes) {
        if (n.kind === "案" || n.kind === "TODO") continue;
        expect(n, n.id).not.toHaveProperty("proposer");
        expect(n, n.id).not.toHaveProperty("assigneeSpeaker");
      }
      for (const n of (yield* session.snapshot).nodes) {
        if (n.kind === "TODO") expect(n, n.id).not.toHaveProperty("proposer");
        if (n.kind === "案") expect(n, n.id).not.toHaveProperty("assigneeSpeaker");
      }
    }));

  it.effect("TODO の担当の話者は、セッションにいる話者だけ。いなければ捨て、名前があれば名前が優先で、更新で名前が来たら話者は消える", () =>
    Effect.gen(function* () {
      const { session } = yield* play();
      const { nodes } = yield* session.snapshot;
      expect(byId(nodes, "n6")).not.toHaveProperty("assigneeSpeaker"); // 相手 Z はいない
      expect(byId(nodes, "n6")).not.toHaveProperty("assignee");
      expect(byId(nodes, "n7")).toMatchObject({ assignee: "鈴木" }); // 最初は 相手 B、更新で名前
      expect(byId(nodes, "n7")).not.toHaveProperty("assigneeSpeaker");
      expect(byId(nodes, "n8")).toMatchObject({ assignee: "田中" });
      expect(byId(nodes, "n8")).not.toHaveProperty("assigneeSpeaker");
    }));

  it.effect("log.jsonl の diff の行には、サーバーが決めた出した人と、検査を通った担当の話者が操作と一緒に残る（捨てた話者は残らない）", () =>
    Effect.gen(function* () {
      const { events } = yield* play();
      const diffs = events.filter((e): e is Extract<LogEvent, { type: "diff" }> => e.type === "diff");
      expect(diffs).toHaveLength(3);
      const adds = Object.fromEntries(diffs[0]!.ops.flatMap((op) => (op.op === "add" ? [[op.ref, op]] : [])));
      expect(adds.t2).toMatchObject({ proposer: "相手 A" });
      expect(adds.t3).toMatchObject({ proposer: "相手 B" });
      expect(adds.t4).toMatchObject({ proposer: "相手" });
      expect(adds.t5).toMatchObject({ proposer: "自分" });
      expect(adds.t1).not.toHaveProperty("proposer");
      expect(adds.t6).not.toHaveProperty("assigneeSpeaker");
      expect(adds.t7).toMatchObject({ assigneeSpeaker: "相手 B" });
      expect(diffs[0]!.dropped).toEqual([]); // 捨てた話者は操作ごとの dropped には載らない
      const ups = diffs[1]!.ops;
      expect(ups.find((op) => op.op === "update" && op.node === "n7")).toMatchObject({ assignee: "鈴木" });
      expect(ups.find((op) => op.op === "update" && op.node === "n3")).not.toHaveProperty("proposer"); // 更新には出した人が載らない
    }));

  it.effect("書き出し（export.json の形）には、出した人も担当の話者もラベルのまま載る。担当の名前は今までどおり出る（Issue #1028）", () =>
    Effect.gen(function* () {
      const { session } = yield* play();
      const walk = (n: { id: string; children: unknown[] }): { id: string; children: unknown[] }[] => [n, ...n.children.flatMap((c) => walk(c as typeof n))];
      const exp = yield* session.exportJson;
      const all = walk(exp.root as never);
      expect(all.length).toBeGreaterThan(10);
      const snapshot = yield* session.snapshot;
      for (const n of all) {
        const node = byId(snapshot.nodes, n.id);
        expect(n, n.id).toMatchObject({ ...(node.proposer === undefined ? {} : { proposer: node.proposer }), ...(node.assigneeSpeaker === undefined ? {} : { assigneeSpeaker: node.assigneeSpeaker }) });
      }
      expect(all.some((n) => (n as { proposer?: string }).proposer !== undefined)).toBe(true);
      expect(all.find((n) => n.id === "n7")).toMatchObject({ assignee: "鈴木" });
      expect(exp).not.toHaveProperty("speakerNames");
    }));

  it.effect("ログから復元すると、出した人も担当の話者も、同じ値で元のセッションと一致する（計算し直さない）", () =>
    Effect.gen(function* () {
      const { session, events } = yield* play();
      const restored = yield* restore(viaJsonl(events));
      const before = yield* session.snapshot;
      expect(yield* restored.snapshot).toEqual(before);
      expect(byId((yield* restored.snapshot).nodes, "n11").proposer).toBe("相手 A");
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
    }));

  it.effect("人の欄が無い古いログも今までどおり読め、ノードに人は付かない（根拠から計算して付けない）", () =>
    Effect.gen(function* () {
      const { session, events } = yield* play();
      const restored = yield* restore(viaJsonl(stripPeople(events)));
      const after = yield* restored.snapshot;
      const live = yield* session.snapshot;
      for (const n of after.nodes) {
        expect(n, n.id).not.toHaveProperty("proposer");
        expect(n, n.id).not.toHaveProperty("assigneeSpeaker");
      }
      // 人の欄以外（木の形・本文・根拠・担当の名前）は同じ
      const withoutPeople = (nodes: typeof live.nodes) => nodes.map(({ proposer: _p, assigneeSpeaker: _a, ...rest }) => rest);
      expect(withoutPeople(after.nodes)).toEqual(withoutPeople(live.nodes));
    }));
});
