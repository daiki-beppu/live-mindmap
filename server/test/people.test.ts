import { describe, expect, it } from "vitest";
import type { Op, Remark } from "../src/core/index.ts";
import { earliestRemark } from "../src/core/index.ts";
import { attributePeople } from "../src/core/people.ts";

// 発言の表（id → 発言）。ID の順と開始時刻の順をわざとずらす（r3 がいちばん早い）
const remark = (id: string, start: number, extra: Partial<Remark> = {}): Remark => ({ id, track: "相手", start, end: start + 1, text: "発言", ...extra });
const table = (...remarks: Remark[]): ReadonlyMap<string, Remark> => new Map(remarks.map((r) => [r.id, r]));

const remarks = table(
  remark("r1", 10, { speaker: "相手 A" }),
  remark("r2", 20, { speaker: "相手 B" }),
  remark("r3", 5, { speaker: "相手 C" }),
  remark("r4", 30), // 話者なしの相手
  remark("r5", 40, { track: "自分" }), // 話者なしの自分のトラック
  remark("r6", 5, { speaker: "相手 D" }), // r3 と同じ開始時刻
);

const addPlan = (evidence: string[], extra: Partial<Extract<Op, { op: "add" }>> = {}): Op => ({ op: "add", ref: "t1", parent: "root", kind: "案", text: "案", evidence, ...extra });
const addTodo = (extra: Partial<Extract<Op, { op: "add" }>> = {}): Op => ({ op: "add", ref: "t2", parent: "root", kind: "TODO", text: "やる", evidence: ["r1"], ...extra });
const proposerOf = (op: Op | undefined) => (op && op.op === "add" ? op.proposer : undefined);

describe("earliestRemark", () => {
  it("開始時刻がいちばん早い発言を返す。ID の順や ids の並びではなく start で比べる", () => {
    expect(earliestRemark(["r1", "r2", "r3"], remarks)?.id).toBe("r3");
    expect(earliestRemark(["r3", "r2", "r1"], remarks)?.id).toBe("r3");
    expect(earliestRemark(["r2", "r1"], remarks)?.id).toBe("r1");
  });

  it("開始時刻が同じなら、ids の並びで前の発言を返す", () => {
    expect(earliestRemark(["r3", "r6"], remarks)?.id).toBe("r3");
    expect(earliestRemark(["r6", "r3"], remarks)?.id).toBe("r6");
  });

  it("表に無い ID は飛ばす。1 件も引けなければ undefined", () => {
    expect(earliestRemark(["r99", "r2"], remarks)?.id).toBe("r2");
    expect(earliestRemark(["r98", "r99"], remarks)).toBeUndefined();
    expect(earliestRemark([], remarks)).toBeUndefined();
  });
});

describe("attributePeople: 案の出した人", () => {
  it("根拠のうち最も早い発言の話者が出した人になる（並びの先頭や後ろではない）", () => {
    expect(proposerOf(attributePeople([addPlan(["r1", "r2"])], remarks)[0])).toBe("相手 A");
    expect(proposerOf(attributePeople([addPlan(["r2", "r1"])], remarks)[0])).toBe("相手 A");
    expect(proposerOf(attributePeople([addPlan(["r1", "r2", "r3"])], remarks)[0])).toBe("相手 C");
  });

  it("開始時刻が同じなら、根拠に並んだ順で前の発言の話者になる", () => {
    expect(proposerOf(attributePeople([addPlan(["r6", "r3"])], remarks)[0])).toBe("相手 D");
    expect(proposerOf(attributePeople([addPlan(["r3", "r6"])], remarks)[0])).toBe("相手 C");
  });

  it("最も早い発言が話者なしの相手なら、出した人は「相手」", () => {
    expect(proposerOf(attributePeople([addPlan(["r4", "r5"])], remarks)[0])).toBe("相手");
  });

  it("話者なしの自分のトラックの発言なら、出した人は「自分」", () => {
    expect(proposerOf(attributePeople([addPlan(["r5"])], remarks)[0])).toBe("自分");
  });

  it("表に無い発言は比べず、引ける発言が無ければ proposer のキーを付けない", () => {
    expect(proposerOf(attributePeople([addPlan(["r99", "r2"])], remarks)[0])).toBe("相手 B");
    expect(attributePeople([addPlan(["r99"])], remarks)[0]).not.toHaveProperty("proposer");
  });

  it("案以外の add には出した人を付けない", () => {
    for (const kind of ["議題", "論点", "決定", "課題", "TODO", "要点"] as const) {
      expect(attributePeople([{ op: "add", ref: "t1", parent: "root", kind, text: "x", evidence: ["r1"] }], remarks)[0]).not.toHaveProperty("proposer");
    }
  });

  it("update には出した人を付けない（更新で根拠が足されても決め直さない）", () => {
    const [op] = attributePeople([{ op: "update", node: "n1", text: "言い換え", evidence: ["r3"] }], remarks);
    expect(op).not.toHaveProperty("proposer");
  });
});

describe("attributePeople: TODO の担当の話者", () => {
  it("セッションにいる話者（振ったラベルと自分）は残す", () => {
    const ops = attributePeople([addTodo({ assigneeSpeaker: "相手 A" }), addTodo({ assigneeSpeaker: "相手 C" }), addTodo({ assigneeSpeaker: "自分" })], remarks);
    expect(ops.map((o) => (o.op === "add" ? o.assigneeSpeaker : undefined))).toEqual(["相手 A", "相手 C", "自分"]);
  });

  it("発言が 1 件も無くても「自分」は残る（自分は常にセッションにいる）", () => {
    const [op] = attributePeople([addTodo({ assigneeSpeaker: "自分" })], table());
    expect(op).toMatchObject({ assigneeSpeaker: "自分" });
  });

  it("セッションにいない話者は、キーごと外す", () => {
    for (const speaker of ["相手 Z", "相手", "田中", "相手 a"]) {
      const [op] = attributePeople([addTodo({ assigneeSpeaker: speaker })], remarks);
      expect(op, speaker).not.toHaveProperty("assigneeSpeaker");
    }
  });

  it("update の assigneeSpeaker も同じ規則で確かめる", () => {
    const ops = attributePeople([
      { op: "update", node: "n1", evidence: ["r1"], assigneeSpeaker: "相手 B" },
      { op: "update", node: "n2", evidence: ["r1"], assigneeSpeaker: "相手 Z" },
    ], remarks);
    expect(ops[0]).toMatchObject({ assigneeSpeaker: "相手 B" });
    expect(ops[1]).not.toHaveProperty("assigneeSpeaker");
  });

  it("名前の assignee・期限・本文など、ほかの欄は変えない", () => {
    const [op] = attributePeople([addTodo({ assignee: "田中", due: "来週", assigneeSpeaker: "相手 Z" })], remarks);
    expect(op).toEqual(addTodo({ assignee: "田中", due: "来週" }));
  });
});

describe("attributePeople: 全体", () => {
  it("人に関わらない操作はそのまま返す", () => {
    const others: Op[] = [
      { op: "combine", from: "n1", into: "n2" },
      { op: "move", node: "n1", parent: "root" },
      { op: "delete", node: "n1" },
      { op: "noop", reason: "なし" },
      { op: "close", node: "n1" },
      { op: "update", node: "n1", text: "x", evidence: ["r1"], planStatus: "却下" },
    ];
    expect(attributePeople(others, remarks)).toEqual(others);
  });

  it("入力の操作は書き換えず、順序と件数を保つ", () => {
    const input: Op[] = [addPlan(["r2"]), { op: "noop", reason: "なし" }, addTodo({ assigneeSpeaker: "相手 Z" })];
    const snapshot = structuredClone(input);
    const out = attributePeople(input, remarks);
    expect(input).toEqual(snapshot);
    expect(out.map((o) => o.op)).toEqual(["add", "noop", "add"]);
  });
});
