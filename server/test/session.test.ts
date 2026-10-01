import { describe, expect, it, vi } from "vitest";
import { createSession, type DiffInput, type LogEvent, type Op, type Remark } from "../src/core/index.ts";

let seq = 0;
const remark = (text: string, extra: Partial<Remark> = {}): Remark => {
  seq++;
  return { id: `r${seq}`, track: "相手", start: seq * 10, end: seq * 10 + 9, text, ...extra };
};

// 台本どおりに差分操作を返す偽物の差分更新。呼ばれた入力を記録する。
function scripted(...script: Op[][]) {
  const calls: DiffInput[] = [];
  const updater = async (input: DiffInput) => {
    calls.push(input);
    return { ops: script[calls.length - 1] ?? [{ op: "noop" as const, reason: "台本切れ" }] };
  };
  return { calls, updater };
}

function setup(...script: Op[][]) {
  const { calls, updater } = scripted(...script);
  const events: LogEvent[] = [];
  const session = createSession({ title: "定例", updater, log: (e) => events.push(e) });
  return { session, calls, events };
}

// 台本の 1 手ごとに発言を 2 つ流し、差分更新を 1 回ずつ起こす。流した発言の ID を手ごとに返す。
async function play(...script: (Op[] | ((ids: string[][]) => Op[]))[]) {
  const pairs = script.map(() => [remark("発言"), remark("発言")] as const);
  const ids = pairs.map((p) => p.map((u) => u.id));
  const resolved = script.map((s) => (typeof s === "function" ? s(ids) : s));
  const { session, calls, events } = setup(...resolved);
  for (const [a, b] of pairs) {
    session.push(a);
    session.push(b);
    await session.idle();
  }
  const snap = session.snapshot();
  const byText = (text: string) => snap.nodes.find((n) => n.text === text);
  const dropped = events.flatMap((e) => (e.type === "diff" ? e.dropped : []));
  return { session, calls, events, snap, byText, dropped, ids };
}

describe("差分操作の検証と適用", () => {
  it("追加の仮 ID を同じ応答の後続の操作から親として参照できる", async () => {
    const { byText } = await play((ids) => [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![1]!] },
    ]);
    expect(byText("面接は何回か")!.parent).toBe(byText("採用")!.id);
  });

  it("成り立たない操作は捨てて理由をログに残し、残りの操作は適用する", async () => {
    const { byText, dropped } = await play((ids) => [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t2", parent: "t1", kind: "決定", text: "面接は 2 回", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t3", parent: "t1", kind: "課題", text: "面接官が足りない", evidence: [ids[0]![1]!] },
    ]);
    expect(byText("面接は 2 回")).toBeUndefined();
    expect(byText("面接官が足りない")).toBeDefined();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ op: { text: "面接は 2 回" }, reason: expect.stringContaining("論点") });
  });

  it("知らない発言を根拠に挙げた追加と更新は、一部だけでも捨てて理由を残す", async () => {
    const { byText, dropped } = await play(
      (ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!, "r-unknown"] },
      ],
      [{ op: "update", node: "n1", text: "中途採用", evidence: ["r-unknown"] }],
    );
    expect(byText("予算")).toBeUndefined();
    expect(byText("採用")).toBeDefined();
    expect(byText("中途採用")).toBeUndefined();
    expect(dropped.map((d) => [d.op.op, d.reason])).toEqual([
      ["add", "根拠に知らない発言がある: r-unknown"],
      ["update", "根拠に知らない発言がある: r-unknown"],
    ]);
  });

  it("既存のノードの ID と重なる仮 ID の追加は捨て、後続の操作は既存のノードを指す", async () => {
    const { byText, dropped } = await play(
      (ids) => [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] }],
      (ids) => [
        { op: "add", ref: "n1", parent: "root", kind: "議題", text: "予算", evidence: [ids[1]![0]!] },
        { op: "add", ref: "t2", parent: "n1", kind: "課題", text: "面接官が足りない", evidence: [ids[1]![1]!] },
      ],
    );
    expect(byText("予算")).toBeUndefined();
    expect(byText("面接官が足りない")!.parent).toBe(byText("採用")!.id);
    expect(dropped.map((d) => d.reason)).toEqual(["仮 ID が既存の ID と重なる"]);
  });

  it("論点は子に決定を持つと決定済みになり、決定を削除すると未決に戻る", async () => {
    const first = await play((ids) => [
      { op: "add", ref: "t1", parent: "root", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
    ]);
    expect(first.byText("面接は何回か")!.pointStatus).toBe("未決");

    const { byText, snap } = await play(
      (ids) => [{ op: "add", ref: "t1", parent: "root", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] }],
      (ids) => [{ op: "add", ref: "t2", parent: "n1", kind: "決定", text: "2 回にする", evidence: [ids[1]![0]!] }],
    );
    expect(byText("面接は何回か")!.pointStatus).toBe("決定済み");

    const decisionId = snap.nodes.find((n) => n.kind === "決定")!.id;
    const after = await play(
      (ids) => [{ op: "add", ref: "t1", parent: "root", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] }],
      (ids) => [{ op: "add", ref: "t2", parent: "n1", kind: "決定", text: "2 回にする", evidence: [ids[1]![0]!] }],
      [{ op: "delete", node: decisionId }],
    );
    expect(after.byText("2 回にする")).toBeUndefined();
    expect(after.byText("面接は何回か")!.pointStatus).toBe("未決");
  });

  it("子を持つノードの削除と、TODO の下への追加は捨てる", async () => {
    const { byText, dropped } = await play((ids) => [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t2", parent: "t1", kind: "TODO", text: "求人票を直す", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t3", parent: "t2", kind: "課題", text: "文面が古い", evidence: [ids[0]![1]!] },
      { op: "delete", node: "t1" },
    ]);
    expect(byText("採用")).toBeDefined();
    expect(byText("文面が古い")).toBeUndefined();
    expect(dropped.map((d) => d.op.op)).toEqual(["add", "delete"]);
  });

  it("統合すると統合元の根拠と子が統合先に移り、統合元は消える。種別が違えば捨てる", async () => {
    const { byText, dropped, ids } = await play(
      (ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "課題", text: "面接官が足りない", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "root", kind: "課題", text: "面接の担当が偏る", evidence: [ids[0]![1]!] },
        { op: "add", ref: "t3", parent: "t2", kind: "案", text: "若手も面接に入る", evidence: [ids[0]![1]!] },
        { op: "add", ref: "t4", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
      ],
      [
        { op: "combine", from: "n2", into: "n1" },
        { op: "combine", from: "n4", into: "n1" },
      ],
    );
    expect(byText("面接の担当が偏る")).toBeUndefined();
    const into = byText("面接官が足りない")!;
    expect(into.id).toBe("n1");
    expect(into.evidence).toEqual([ids[0]![0], ids[0]![1]]);
    expect(byText("若手も面接に入る")!.parent).toBe("n1");
    expect(byText("採用")).toBeDefined();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toContain("種別");
  });

  it("更新は本文を置き換えて根拠を足し、移動は子孫ごと親を変える。どちらも ID は変わらない", async () => {
    const { snap, dropped, ids } = await play(
      (ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "root", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: [ids[0]![1]!] },
      ],
      (ids) => [
        { op: "update", node: "n3", text: "3 回にする", evidence: [ids[1]![0]!], planStatus: "却下" },
        { op: "move", node: "n2", parent: "n1" },
        { op: "move", node: "n1", parent: "n3" },
      ],
    );
    const node = (id: string) => snap.nodes.find((n) => n.id === id)!;
    expect(node("n3")).toMatchObject({ text: "3 回にする", planStatus: "却下", parent: "n2", evidence: [ids[0]![1], ids[1]![0]] });
    expect(node("n2").parent).toBe("n1");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toContain("子孫");
  });
});

describe("ログ", () => {
  it("差分操作のイベントに、入力の要約・出力・捨てた操作と理由を残す", async () => {
    const bad: Op = { op: "delete", node: "n99" };
    const { events, ids } = await play(
      (ids) => [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] }],
      [bad],
    );
    const diffs = events.filter((e) => e.type === "diff");
    expect(diffs[1]).toEqual({
      type: "diff",
      input: { recent: ids[0], fresh: ids[1], nodeCount: 1 },
      ops: [bad],
      dropped: [{ op: bad, reason: "対象が無い" }],
    });
  });
});

describe("差分更新の呼び出し", () => {
  it("発言が 2 つたまると差分更新を呼び、返った追加をマップに入れる", async () => {
    const a = remark("今日は採用の話をします"), b = remark("まず面接の回数から");
    const { session, calls } = setup([
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id, b.id] },
    ]);

    session.push(a);
    expect(calls).toHaveLength(0);
    session.push(b);
    await session.idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id, b.id]);
    const snap = session.snapshot();
    const topic = snap.nodes.find((n) => n.text === "採用")!;
    expect(topic).toMatchObject({ kind: "議題", parent: "root", evidence: [a.id, b.id] });
  });

  it("重複の印が付いた発言は数えず入力にも入れないが、ログには残す", async () => {
    const a = remark("予算は来週決めます", { track: "相手" });
    const echo = remark("予算は来週決めます", { track: "自分", duplicate: true });
    const b = remark("担当は佐藤さんで");
    const { session, calls, events } = setup();

    session.push(a);
    session.push(echo);
    await session.idle();
    expect(calls).toHaveLength(0);

    session.push(b);
    await session.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id, b.id]);
    const logged = events.flatMap((e) => (e.type === "remark" ? [e.remark] : []));
    expect(logged).toContainEqual(echo);
  });

  it("呼び出し中は次を呼ばず、その間にたまった発言を次の 1 回にまとめる", async () => {
    // 応答をテストの側から返せる偽物
    const calls: { input: DiffInput; reply: () => void }[] = [];
    const updater = (input: DiffInput) =>
      new Promise<{ ops: Op[] }>((resolve) => calls.push({ input, reply: () => resolve({ ops: [] }) }));
    const session = createSession({ title: "定例", updater, log: () => {} });
    const [a, b, c, d, e] = ["一", "二", "三", "四", "五"].map((t) => remark(t));

    session.push(a!);
    session.push(b!);
    session.push(c!);
    session.push(d!);
    session.push(e!);
    expect(calls).toHaveLength(1);

    calls[0]!.reply();
    await Promise.resolve();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.input.fresh.map((u) => u.id)).toEqual([c!.id, d!.id, e!.id]);
    expect(calls[1]!.input.recent.map((u) => u.id)).toEqual([a!.id, b!.id]);

    calls[1]!.reply();
    await session.idle();
    expect(calls).toHaveLength(2);
  });

  it("差分更新が失敗しても、理由をログに残して次の呼び出しへ進む", async () => {
    let n = 0;
    const events: LogEvent[] = [];
    const updater = async (): Promise<{ ops: Op[] }> => {
      if (n++ === 0) throw new Error("timeout");
      return { ops: [{ op: "noop", reason: "雑談" }] };
    };
    const session = createSession({ title: "定例", updater, log: (e) => events.push(e) });
    for (const t of ["一", "二", "三", "四"]) session.push(remark(t));
    await session.idle();

    const diffs = events.filter((e) => e.type === "diff");
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ ops: [], error: expect.stringContaining("timeout") });
    expect(diffs[1]).toMatchObject({ ops: [{ op: "noop" }] });
  });

  it("直前の発言として、処理済みのうち最後の 3 つを渡す", async () => {
    const { calls, ids } = await play([], [], []);
    expect(calls[2]!.recent.map((u) => u.id)).toEqual([ids[0]![1], ids[1]![0], ids[1]![1]]);
  });

  it("1 つだけ残った発言は、終わりの flush で流す", async () => {
    const [a, b, c] = ["一", "二", "三"].map((t) => remark(t));
    const { session, calls } = setup();

    session.push(a!);
    session.push(b!);
    session.push(c!);
    await session.idle();
    expect(calls).toHaveLength(1);

    await session.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.fresh.map((u) => u.id)).toEqual([c!.id]);
    await session.flush();
    expect(calls).toHaveLength(2);
  });
});

describe("変わったこと（反映の履歴）", () => {
  // 反映ごとの手を順に返す偽物。Error なら失敗する。
  function stepped(...script: (Op[] | Error)[]) {
    let n = 0;
    return async (): Promise<{ ops: Op[] }> => {
      const s = script[n++] ?? [];
      if (s instanceof Error) throw s;
      return { ops: s };
    };
  }

  // 発言を 2 つ流して反映を 1 回起こす。end は呼び出し側が決める。
  async function reflect(session: ReturnType<typeof createSession>, ends: [number, number]) {
    const rs = ends.map((end) => remark("発言", { end, start: end - 1 }));
    for (const r of rs) session.push(r);
    await session.idle();
    return rs.map((r) => r.id);
  }

  it("同じセッションで 反映 → 反映 → 何もしない反映 → 失敗した反映 を続けると、round が進み、記録が積み上がる", async () => {
    const events: LogEvent[] = [];
    const [a, b] = [remark("一"), remark("二")];
    const updater = stepped(
      [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }],
      [{ op: "update", node: "n1", text: "中途採用", evidence: [b.id] }],
      [{ op: "noop", reason: "雑談" }],
      new Error("timeout"),
      [{ op: "add", ref: "t2", parent: "n1", kind: "論点", text: "面接は何回か", evidence: [b.id] }],
    );
    const session = createSession({ title: "定例", updater, log: (e) => events.push(e) });

    expect(session.snapshot()).toMatchObject({ round: 0, changes: [] });

    // 反映 1。新しい発言の end の最大値が at になる（最後の発言の end ではない）
    session.push({ ...a, start: 1, end: 50 });
    session.push({ ...b, start: 2, end: 30 });
    await session.idle();
    expect(session.snapshot().round).toBe(1);
    expect(session.snapshot().changes).toEqual([{ round: 1, at: 50, change: "追加", node: "n1", kind: "議題", text: "採用" }]);

    // 反映 2
    await reflect(session, [60, 70]);
    expect(session.snapshot().round).toBe(2);
    expect(session.snapshot().changes).toEqual([
      { round: 1, at: 50, change: "追加", node: "n1", kind: "議題", text: "採用" },
      { round: 2, at: 70, change: "更新", node: "n1", kind: "議題", text: "中途採用" },
    ]);

    // 何もしない反映でも round は進む（前回の赤い枠を消すため）。記録は増えない
    await reflect(session, [80, 90]);
    expect(session.snapshot().round).toBe(3);
    expect(session.snapshot().changes).toHaveLength(2);

    // 失敗した反映では round も記録も進まない
    await reflect(session, [100, 110]);
    expect(events.at(-1)).toMatchObject({ type: "diff", error: expect.stringContaining("timeout") });
    expect(session.snapshot().round).toBe(3);
    expect(session.snapshot().changes).toHaveLength(2);

    // 失敗の後の反映は、次の round として積み上がる
    await reflect(session, [120, 125]);
    expect(session.snapshot().round).toBe(4);
    expect(session.snapshot().changes.at(-1)).toEqual({ round: 4, at: 125, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" });
    expect(session.snapshot().changes).toHaveLength(3);
  });

  it("log が呼ばれた時点のスナップショットに、その反映の round と記録がすでに載っている（送信より先に記録する）", async () => {
    const [a, b, c, d] = [remark("一"), remark("二"), remark("三"), remark("四")];
    const updater = stepped(
      [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }],
      new Error("timeout"),
    );
    const seen: { failed: boolean; round: number; changes: number }[] = [];
    const session = createSession({
      title: "定例",
      updater,
      log: (e) => {
        if (e.type !== "diff") return;
        const s = session.snapshot();
        seen.push({ failed: e.error !== undefined, round: s.round, changes: s.changes.length });
      },
    });
    for (const r of [a, b, c, d]) session.push(r);
    await session.idle();

    expect(seen).toEqual([
      { failed: false, round: 1, changes: 1 },
      { failed: true, round: 1, changes: 1 },
    ]);
  });

  it("snapshot() が返す changes は、あとから書き換えてもセッションの記録に影響しない", async () => {
    const [a, b] = [remark("一"), remark("二")];
    const updater = stepped([{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }]);
    const session = createSession({ title: "定例", updater, log: () => {} });
    session.push(a);
    session.push(b);
    await session.idle();

    session.snapshot().changes.length = 0;
    expect(session.snapshot().changes).toHaveLength(1);
  });
});
