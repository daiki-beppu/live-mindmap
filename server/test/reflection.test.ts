import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { emptyMap, type Op } from "../src/core/map.ts";
import { reflectDiff } from "../src/core/reflection.ts";
import type { Remark } from "../src/core/remark.ts";
import type { DiffEvent, SessionState } from "../src/core/session.ts";

const remark = (id: string, end: number, text: string): Remark => ({ id, track: "相手", start: end - 1, end, text, speaker: "相手 A" });

function state(remarks: Remark[]) {
  const prior = remark("r0", 5, "以前の議題");
  const history: Pick<SessionState, "round" | "changes" | "currentTopic" | "lastChanged"> = {
    round: 2,
    changes: [{ change: "追加", node: "n1", kind: "議題", text: "以前の議題", round: 2, at: 5 }],
    currentTopic: "n1",
    lastChanged: "n1",
  };
  return {
    map: {
      nodes: {
        ...emptyMap("定例").nodes,
        n1: { id: "n1", parent: "root", kind: "議題" as const, text: "以前の議題", evidence: ["r0"], touchedAt: 5, evidenceRound: 2 },
      },
      order: ["root", "n1"],
      nextId: 2,
    },
    history,
    ledger: { byId: new Map([prior, ...remarks].map((r) => [r.id, r])), known: new Set(["r0"]), processed: [prior] },
  };
}

const diff = (fresh: string[], extra: Partial<typeof DiffEvent.Type> = {}): typeof DiffEvent.Type => ({
  type: "diff", input: { recent: ["r0"], fresh, nodeCount: 1 }, ops: [], dropped: [], ...extra,
});

const topic: Op = { op: "add", ref: "t2", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] };

describe("diff の反映", () => {
  it("成功した回は全件を消費し、最大 end で履歴を足して適用結果の dropped・refs を返す", () => {
    const r1 = remark("r1", 30, "採用を話します");
    const r2 = remark("r2", 20, "予算も話します");
    const before = state([r1, r2]);
    const saved = structuredClone(before);
    const rejected: Op = { op: "delete", node: "n99" };
    const event = diff(["r1", "r2"], {
      ops: [topic, rejected],
      dropped: [{ op: topic, reason: "ログに保存された値は使わない" }],
    });
    const savedEvent = structuredClone(event);

    const got = Result.getOrThrow(reflectDiff(before, event));

    expect(got.state.ledger.known).toEqual(new Set(["r0", "r1", "r2"]));
    expect(got.state.ledger.processed).toEqual([before.ledger.byId.get("r0"), r1, r2]);
    expect(got.state.ledger.byId).toEqual(saved.ledger.byId);
    expect(got.state.map.nodes.n2).toEqual({ id: "n2", parent: "root", kind: "議題", text: "採用", evidence: ["r1"], touchedAt: 30, evidenceRound: 3 });
    expect(got.state.map.nextId).toBe(3);
    expect(got.state.history).toEqual({
      round: 3,
      changes: [...saved.history.changes, { change: "追加", node: "n2", kind: "議題", text: "採用", round: 3, at: 30 }],
      currentTopic: "n2", lastChanged: "n2",
    });
    expect(got.refs).toEqual({ t2: "n2" });
    expect(got.dropped).toEqual([{ op: rejected, reason: "対象が無い" }]);
    expect(before).toEqual(saved);
    expect(event).toEqual(savedEvent);
  });

  it("エラーの回は processedRemarks によらず全件を消費し、ops は適用しても履歴を進めない", () => {
    const r1 = remark("r1", 20, "採用を話します");
    const r2 = remark("r2", 30, "予算も話します");
    const filler = remark("r3", 40, "えー");
    const before = state([r1, r2, filler]);
    const saved = structuredClone(before);

    const got = Result.getOrThrow(reflectDiff(before, diff(["r1", "r2", "r3"], { error: "timeout", processedRemarks: 1, ops: [topic] })));

    expect(got.state.ledger.known).toEqual(new Set(["r0", "r1", "r2", "r3"]));
    expect(got.state.ledger.processed).toEqual([before.ledger.byId.get("r0"), r1, r2]);
    expect(got.state.history).toEqual(saved.history);
    expect(got.state.map.nodes.n2).toMatchObject({ text: "採用", evidence: ["r1"], touchedAt: 40, evidenceRound: 3 });
    expect(got.refs).toEqual({ t2: "n2" });
    expect(got.dropped).toEqual([]);
    expect(before).toEqual(saved);
  });

  it("部分成功では先頭の指定件数だけを消費し、残りの end を stamp に使わない", () => {
    const r1 = remark("r1", 20, "採用を話します");
    const r2 = remark("r2", 90, "まだ反映しない発言");
    const before = state([r1, r2]);

    const got = Result.getOrThrow(reflectDiff(before, diff(["r1", "r2"], { processedRemarks: 1, ops: [topic] })));

    expect(got.state.ledger.known).toEqual(new Set(["r0", "r1"]));
    expect(got.state.ledger.processed).toEqual([before.ledger.byId.get("r0"), r1]);
    expect(got.state.ledger.byId.get("r2")).toEqual(r2);
    expect(got.state.history).toEqual({
      round: 3,
      changes: [...before.history.changes, { change: "追加", node: "n2", kind: "議題", text: "採用", round: 3, at: 20 }],
      currentTopic: "n2", lastChanged: "n2",
    });
    expect(got.state.map.nodes.n2).toMatchObject({ touchedAt: 20, evidenceRound: 3 });
  });

  it("反映数が fresh を超える行は状態を返さず、入力を書き換えない", () => {
    const before = state([remark("r1", 20, "採用を話します")]);
    const saved = structuredClone(before);

    const got = reflectDiff(before, diff(["r1"], { processedRemarks: 2, ops: [topic] }));

    expect(Result.isFailure(got)).toBe(true);
    if (!Result.isFailure(got)) throw new Error("不正な反映数が成功した");
    expect(typeof got.failure).toBe("string");
    expect(got.failure.length).toBeGreaterThan(0);
    expect(before).toEqual(saved);
  });

  it.each([
    { label: "消費部分", fresh: ["r-missing", "r1"] },
    { label: "未消費部分", fresh: ["r1", "r-missing"] },
  ])("$label の未知 ID も理由に示して失敗し、入力を書き換えない", ({ fresh }) => {
    const before = state([remark("r1", 20, "採用を話します")]);
    const saved = structuredClone(before);

    const got = reflectDiff(before, diff(fresh, { processedRemarks: 1, ops: [topic] }));

    expect(Result.isFailure(got)).toBe(true);
    if (!Result.isFailure(got)) throw new Error("未知の発言 ID が成功した");
    expect(got.failure).toContain("r-missing");
    expect(before).toEqual(saved);
  });

  it("中身のない発言も既知と時刻には数え、処理済みからだけ除く", () => {
    const filler1 = remark("r1", 10, "あ");
    const spoken = remark("r2", 20, "採用を話します");
    const filler2 = remark("r3", 40, "えー");
    const before = state([filler1, spoken, filler2]);
    const first = Result.getOrThrow(reflectDiff(before, diff(["r1"])));
    expect(first.state.ledger.known).toEqual(new Set(["r0", "r1"]));
    expect(first.state.ledger.processed).toEqual(before.ledger.processed);
    expect(first.state.history).toEqual({ ...before.history, round: 3, lastChanged: undefined });

    const got = Result.getOrThrow(reflectDiff(first.state, diff(["r2", "r3"], {
      ops: [{ ...topic, evidence: ["r2"] }],
    })));

    expect(got.state.ledger.known).toEqual(new Set(["r0", "r1", "r2", "r3"]));
    expect(got.state.ledger.processed).toEqual([...before.ledger.processed, spoken]);
    expect(got.state.history).toEqual({
      round: 4,
      changes: [...before.history.changes, { change: "追加", node: "n2", kind: "議題", text: "採用", round: 4, at: 40 }],
      currentTopic: "n2", lastChanged: "n2",
    });
    expect(got.state.map.nodes.n2).toMatchObject({ evidence: ["r2"], touchedAt: 40, evidenceRound: 4 });
  });

  it("既存 ID と重なる仮 ID は捨て、後続の追加だけに次の番号を割り当てる", () => {
    const before = state([remark("r1", 20, "採用を話します")]);
    const collision: Op = { ...topic, ref: "n1", text: "衝突した議題" };

    const got = Result.getOrThrow(reflectDiff(before, diff(["r1"], { ops: [collision, topic] })));

    expect(got.dropped).toEqual([{ op: collision, reason: "仮 ID が既存の ID と重なる" }]);
    expect(got.state.map.nodes.n1).toEqual(before.map.nodes.n1);
    expect(got.state.map.nodes.n2).toMatchObject({ text: "採用", evidence: ["r1"] });
    expect(got.refs).toEqual({ t2: "n2" });
    expect(got.state.map.nextId).toBe(3);
  });

  it("帰属済みの proposer・assigneeSpeaker を再推定しない", () => {
    const before = state([remark("r1", 20, "私が担当します")]);
    const got = Result.getOrThrow(reflectDiff(before, {
      ...diff(["r1"], { ops: [
        { op: "add", ref: "plan", parent: "n1", kind: "案", text: "採用案", evidence: ["r1"], proposer: "記録された提案者" },
        { op: "add", ref: "todo", parent: "n1", kind: "TODO", text: "準備する", evidence: ["r1"], assigneeSpeaker: "記録された担当者" },
      ] }),
    }));

    expect(got.state.map.nodes.n2).toMatchObject({ proposer: "記録された提案者", touchedAt: 20 });
    expect(got.state.map.nodes.n3).toMatchObject({ assigneeSpeaker: "記録された担当者", touchedAt: 20 });
    expect(got.dropped).toEqual([]);
  });

  it("共有画面の件数・時刻を反映の検査や stamp に使わない", () => {
    const before = state([remark("r1", 20, "採用を話します")]);

    const got = Result.getOrThrow(reflectDiff(before, {
      ...diff(["r1"], { ops: [topic] }),
      input: { recent: [], fresh: ["r1"], nodeCount: 1, screenCount: 100, screens: [{ start: 999, image: "screen.jpg" }] },
    }));

    expect(got.state.map.nodes.n2).toMatchObject({ text: "採用", touchedAt: 20 });
    expect(got.state.history.changes.at(-1)).toMatchObject({ round: 3, at: 20 });
  });
});
