import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { emptyMap, type Op } from "../src/core/map.ts";
import { reflectDiff, reflectSupplement, type ReflectionState } from "../src/core/reflection.ts";
import type { Remark } from "../src/core/remark.ts";
import { SupplementEvent, restoreState, type DiffEvent, type SessionState } from "../src/core/session.ts";

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
    explainedTerms: new Map<string, string>(),
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

function supplementState(): ReflectionState {
  const before = state([remark("r1", 20, "納期を話します")]);
  return { ...before, map: { nodes: {
    ...before.map.nodes,
    n1: { ...before.map.nodes.n1, text: "予算" },
    n2: { id: "n2", parent: "n1", kind: "課題", text: "納期", evidence: ["r0"] },
  }, order: ["root", "n1", "n2"], nextId: 3 } };
}
const supplementEvent = (extra: Partial<typeof SupplementEvent.Type> = {}): typeof SupplementEvent.Type => ({
  type: "supplement", category: "用語", term: "SLA", ms: 12, reflectedAt: 5,
  op: { op: "add", parent: "n2", text: "サービス水準の合意", evidence: ["r0"], origin: "会議の外" }, ...extra,
});
const supplemented = (before: ReflectionState, event = supplementEvent()) => Result.getOrThrow(reflectSupplement(before, event));

function twoSupplements(): ReflectionState {
  const base = supplementState();
  base.map.nodes.n1 = { id: "n1", parent: "root", kind: "課題", text: "予算", evidence: ["r0"] };
  base.map.nodes.n2!.parent = "root";
  const first = supplemented(base).state;
  return supplemented(first, supplementEvent({ term: "SLO", op: { op: "add", parent: "n1", text: "サービス水準の目標", evidence: ["r0"], origin: "会議の外" } })).state;
}

describe("supplement の反映", () => {
  it.each([
    { node: "n3", term: "SLA", accepted: true },
    { node: "n4", term: "SLA", accepted: false },
    { node: "n4", term: "SLI", accepted: true },
  ])("同じ語は説明した補足自身だけが言い直せ、未説明語への変更はできる: $node / $term", ({ node, term, accepted }) => {
    const before = twoSupplements();
    const saved = structuredClone(before);
    const event = supplementEvent({ term, op: { op: "update", node, text: "合意したサービス水準", evidence: ["r0"], origin: "会議の外" } });
    const savedEvent = structuredClone(event);
    const got = supplemented(before, event);
    expect(got.dropped).toHaveLength(accepted ? 0 : 1);
    if (accepted) {
      expect(got.state.map.nodes[node]!.text).toBe("合意したサービス水準");
      const another = supplemented(got.state, supplementEvent({ term, op: { op: "update", node: node === "n3" ? "n4" : "n3", text: "別補足の変更", evidence: ["r0"], origin: "会議の外" } }));
      expect(another.dropped).toHaveLength(1);
      expect(another.state).toEqual(got.state);
    } else {
      expect(got.dropped[0]!.op).toEqual(event.op);
      expect(got.dropped[0]!.reason.length).toBeGreaterThan(0);
      expect(got.state).toEqual(saved);
    }
    expect(before).toEqual(saved);
    expect(event).toEqual(savedEvent);
  });

  it.each(["補足削除", "親削除", "親統合", "通常diff"] as const)("%s の後も、本人の同語更新を許し、別補足による説明済み語への更新は拒否する", (operation) => {
    const before = twoSupplements();
    const after = operation === "補足削除"
      ? supplemented(before, supplementEvent({ op: { op: "delete", node: "n3" } })).state
      : Result.getOrThrow(reflectDiff(before, diff(["r1"], { ops: operation === "親削除" ? [{ op: "delete", node: "n2" }] : operation === "親統合" ? [{ op: "combine", from: "n2", into: "n1" }] : [] }))).state;
    const own = supplementEvent({ term: "SLO", op: { op: "update", node: "n4", text: "目標の言い直し", evidence: ["r0"], origin: "会議の外" } });
    expect(supplemented(after, own).dropped).toEqual([]);
    const saved = structuredClone(after);
    const rejected = supplemented(after, { ...own, term: "SLA" });
    expect(rejected.dropped).toHaveLength(1);
    expect(rejected.dropped[0]!.reason.length).toBeGreaterThan(0);
    expect(rejected.state).toEqual(saved);
    expect(after).toEqual(saved);
  });

  it.each([{ evidence: ["r0"] }, { evidence: ["r1"] }, { evidence: ["r0", "r1", "r1"] }])("言い直しは本文を置換し、既存根拠に有効な根拠 $evidence を重複なく足す", ({ evidence }) => {
    const base = Result.getOrThrow(reflectDiff(supplementState(), diff(["r1"], { ops: [{ op: "update", node: "n2", evidence: ["r1"] }] }))).state;
    const before = supplemented(base).state;
    const saved = structuredClone(before);
    const got = supplemented(before, supplementEvent({ op: { op: "update", node: "n3", text: "合意したサービス水準", evidence, origin: "会議の中" } }));
    expect(got.dropped).toEqual([]);
    expect(got.state.map.nodes.n3!.text).toBe("合意したサービス水準");
    expect(got.state.map.nodes.n3!.evidence).toEqual(evidence.includes("r1") ? ["r0", "r1"] : ["r0"]);
    expect(before).toEqual(saved);
  });

  it.each(["r1", "r99"])("言い直しでも親にない・台帳にない根拠 %s を理由つきで拒否し、既存根拠を保つ", (id) => {
    const before = supplemented(supplementState()).state;
    const saved = structuredClone(before);
    const got = supplemented(before, supplementEvent({ op: { op: "update", node: "n3", text: "拒否する本文", evidence: [id], origin: "会議の中" } }));
    expect(got.dropped).toHaveLength(1);
    expect(got.dropped[0]!.reason.length).toBeGreaterThan(0);
    expect(got.state).toEqual(saved);
    expect(before).toEqual(saved);
  });

  it("n1への補足追加が、既存のn2の本文やIDを上書きしない", () => {
    const before = supplementState();
    const got = supplemented(before, supplementEvent({ op: { op: "add", parent: "n1", text: "締切の説明", evidence: ["r0"], origin: "会議の中" } }));
    expect(got.state.map.nodes.n2).toMatchObject({ id: "n2", text: "納期" });
    expect(got.state.map.nodes.n3).toMatchObject({ id: "n3", parent: "n1", text: "締切の説明" });
    expect(got.state.map.nodes.n1).toEqual(before.map.nodes.n1);
  });
  it("追加した補足と後続の通常追加を異なるIDで残し、以前のノードを上書きしない", () => {
    const before = supplementState();
    const saved = structuredClone(before);
    const event = supplementEvent();
    const savedEvent = structuredClone(event);
    const first = supplemented(before, event);
    expect(first.dropped).toEqual([]);
    expect(first.state.map.nodes.n3).toEqual({ id: "n3", parent: "n2", kind: "補足", text: "サービス水準の合意", evidence: ["r0"], origin: "会議の外" });
    expect(first.state.map.nodes.n1).toEqual(before.map.nodes.n1);
    expect(first.state.map.nodes.n2).toEqual(before.map.nodes.n2);
    expect(first.state.map.nextId).toBe(4);
    expect([...first.state.explainedTerms.keys()]).toEqual(["SLA"]);
    expect(first.state.history).toEqual(before.history);
    expect(first.state.ledger).toEqual(before.ledger);
    const next = Result.getOrThrow(reflectDiff(first.state, diff(["r1"], { ops: [topic] })));
    expect(next.state.map.nodes.n4).toMatchObject({ kind: "議題", text: "採用" });
    expect(next.state.map.nodes.n3).toEqual(first.state.map.nodes.n3);
    expect([...next.state.explainedTerms.keys()]).toEqual(["SLA"]);
    expect(before).toEqual(saved);
    expect(event).toEqual(savedEvent);
  });

  it("同じ語の言い直しは追記せず全文で置き換え、消去しても説明済み語を残す", () => {
    const first = supplemented(supplementState()).state;
    const saved = structuredClone(first);
    const revised = supplemented(first, supplementEvent({ op: { op: "update", node: "n3", text: "会議で合意した水準", evidence: ["r0"], origin: "会議の中" } }));
    expect(revised.dropped).toEqual([]);
    expect(revised.state.map.nodes.n3).toEqual({ id: "n3", parent: "n2", kind: "補足", text: "会議で合意した水準", evidence: ["r0"], origin: "会議の中" });
    const removed = supplemented(revised.state, supplementEvent({ op: { op: "delete", node: "n3" }, category: null, term: undefined })).state;
    expect(removed.map.nodes.n3).toBeUndefined();
    expect(removed.map.order).toEqual(["root", "n1", "n2"]);
    expect([...removed.explainedTerms.keys()]).toEqual(["SLA"]);
    const duplicate = supplemented(removed);
    expect(duplicate.dropped).toHaveLength(1);
    expect(duplicate.dropped[0]!.reason.length).toBeGreaterThan(0);
    expect(duplicate.state).toEqual(removed);
    expect(first).toEqual(saved);
  });

  it.each(["議題", "論点", "案", "決定", "TODO", "課題", "要点"] as const)("%s に1件だけ添え、同じ親への次の追加を落とす", (kind) => {
    const before = supplementState();
    if (kind === "決定") before.map.nodes.n1 = { id: "n1", parent: "root", kind: "論点", text: "論点", evidence: ["r0"] };
    before.map.nodes.n2 = { id: "n2", parent: "n1", kind, text: "添える先", evidence: ["r0"] };
    const first = supplemented(before);
    expect(first.dropped).toEqual([]);
    const second = supplemented(first.state, supplementEvent({ term: "別の語" }));
    expect(second.dropped).toHaveLength(1);
    expect(second.dropped[0]!.reason.length).toBeGreaterThan(0);
    expect(second.state).toEqual(first.state);
  });

  it.each(["root", "n3", "gone"])("会議・補足・存在しない親 %s への追加を落とす", (parent) => {
    const before = supplemented(supplementState()).state;
    const saved = structuredClone(before);
    const got = supplemented(before, supplementEvent({ term: "別の語", op: { op: "add", parent, text: "付かない補足", evidence: ["r0"], origin: "会議の中" } }));
    expect(got.dropped).toHaveLength(1);
    expect(got.dropped[0]!.reason.length).toBeGreaterThan(0);
    expect(got.state).toEqual(saved);
    expect(before).toEqual(saved);
  });

  it.each(["delete", "combine"] as const)("添える先が%sで消えていれば、統合先にも付け替えない", (op) => {
    const before = supplementState();
    before.map.nodes.n1 = { id: "n1", parent: "root", kind: "課題", text: "予算", evidence: ["r0"] };
    before.map.nodes.n2!.parent = "root";
    const removed = Result.getOrThrow(reflectDiff(before, diff(["r1"], { ops: [op === "delete" ? { op, node: "n2" } : { op, from: "n2", into: "n1" }] }))).state;
    const got = supplemented(removed);
    expect(got.dropped).toHaveLength(1);
    expect(got.state.map).toEqual(removed.map);
    expect(got.state.explainedTerms.size).toBe(0);
  });

  it.each(["r-missing", "r1"])("台帳にないか添える先にない根拠 %s を落とし、入力を書き換えない", (evidence) => {
    const before = supplementState();
    const saved = structuredClone(before);
    const got = supplemented(before, supplementEvent({ op: { op: "add", parent: "n2", text: "補足", evidence: [evidence], origin: "会議の外" } }));
    expect(got.dropped).toHaveLength(1);
    expect(got.dropped[0]!.reason.length).toBeGreaterThan(0);
    expect(got.state).toEqual(saved);
    expect(before).toEqual(saved);
  });

  it.each(["delete", "combine"] as const)("親の%sで補足が消えても、同じ語を別の親へ追加できない", (op) => {
    const before = supplementState();
    before.map.nodes.n1 = { id: "n1", parent: "root", kind: "課題", text: "予算", evidence: ["r0"] };
    before.map.nodes.n2!.parent = "root";
    const first = supplemented(before).state;
    const removed = Result.getOrThrow(reflectDiff(first, diff(["r1"], { ops: [op === "delete" ? { op, node: "n2" } : { op, from: "n2", into: "n1" }] }))).state;
    expect(removed.map.nodes.n3).toBeUndefined();
    const got = supplemented(removed, supplementEvent({ op: { op: "add", parent: "n1", text: "同じ語", evidence: ["r0"], origin: "会議の外" } }));
    expect(got.dropped).toHaveLength(1);
    expect(got.state.map).toEqual(removed.map);
    expect([...got.state.explainedTerms.keys()]).toEqual(["SLA"]);
  });

  it("説明した語が欠けた用語の回は失敗し、入力を変えず、次の正しい回を反映できる", () => {
    const before = supplementState();
    const saved = structuredClone(before);
    expect(Result.isFailure(reflectSupplement(before, supplementEvent({ term: undefined })))).toBe(true);
    expect(before).toEqual(saved);
    expect(supplemented(before).state.map.nodes.n3).toMatchObject({ kind: "補足" });
  });

  it.each([supplementEvent({ op: null }), supplementEvent({ error: "失敗" })])("操作なし・失敗の回は状態と説明済み語を変えない", (event) => {
    const before = supplementState();
    const saved = structuredClone(before);
    expect(supplemented(before, event).state).toEqual(saved);
    expect(before).toEqual(saved);
  });

  it("呼び出し情報と区分と語は行に保持し、複数操作の行は受け付けない", () => {
    const event = supplementEvent({ usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, model: "synthetic" } });
    expect(Schema.decodeUnknownSync(SupplementEvent)(event)).toEqual(event);
    expect(() => Schema.decodeUnknownSync(SupplementEvent)({ ...event, op: [event.op, event.op] })).toThrow();
  });

  it("形が崩れた補足行を含む復元は失敗し、入力のログを書き換えない", () => {
    const events = [{ type: "start", title: "定例" }, { ...supplementEvent(), op: { op: "add", parent: "n1", text: "補足", evidence: [] } }];
    const saved = structuredClone(events);
    const result = Effect.runSync(Effect.result(restoreState(events)));
    expect(Result.isFailure(result)).toBe(true);
    expect(events).toEqual(saved);
  });

  const { term: _term, ...missingTermEvent } = supplementEvent();
  it.each([
    { events: [supplementEvent()], index: 0, reason: "start" },
    { events: [{ type: "start", title: "定例" }, missingTermEvent], index: 1, reason: "説明した語" },
  ])("補足の反映で失敗した行の位置と理由を復元のエラーに残す: %j", ({ events, index, reason }) => {
    const saved = structuredClone(events);
    const failure = Effect.runSync(Effect.flip(restoreState(events)));
    expect(failure).toMatchObject({ _tag: "InvalidLogEvent", index });
    expect(failure.reason).toContain(reason);
    expect(events).toEqual(saved);
  });
});

describe("diff の反映", () => {
  it("通常の差分で補足を削除しても、その会議では同じ語を説明し直せない", () => {
    const before = twoSupplements();
    const removed = Result.getOrThrow(reflectDiff(before, diff(["r1"], { ops: [{ op: "delete", node: "n3" }] }))).state;
    expect(removed.map.nodes.n3).toBeUndefined();
    expect(removed.map.nodes.n4).toEqual(before.map.nodes.n4);
    expect([...removed.explainedTerms.keys()]).toEqual(["SLA", "SLO"]);
    const repeated = supplemented(removed);
    expect(repeated.dropped).toHaveLength(1);
    expect(repeated.dropped[0]!.reason.length).toBeGreaterThan(0);
    expect(repeated.state.map).toEqual(removed.map);
  });

  it.each([undefined, "記録された失敗"])("成功・失敗の反映でセッションの判断軸を共通反映へ渡す（%s）", (error) => {
    const criteria = ["採用のしやすさ"];
    const before = { ...state([remark("r1", 20, "試験導入を提案します")]), criteria };
    const op = { op: "add", ref: "plan", parent: "n1", kind: "案", text: "試験導入", evidence: ["r1"], criteria } satisfies Op;
    const first = Result.getOrThrow(reflectDiff(before, diff(["r1"], { ops: [op], ...(error === undefined ? {} : { error }) })));
    expect(first.state.map.nodes.n2).toHaveProperty("criteria", criteria);
    expect(first.state).toHaveProperty("criteria", criteria);
    const update = { op: "update", node: "n2", evidence: ["r1"], criteria: ["価格"] } satisfies Op;
    const second = Result.getOrThrow(reflectDiff(first.state, diff(["r1"], { ops: [update] })));
    expect(second.state.map.nodes.n2!.criteria ?? []).toEqual([]);
  });

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
