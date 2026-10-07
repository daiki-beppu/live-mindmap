import { describe, expect, it } from "vitest";
import { createSession, restoreSession, type DiffInput, type LogEvent, type Op, type Remark } from "../src/core/index.ts";

let seq = 0;
const remark = (text: string, extra: Partial<Remark> = {}): Remark => {
  seq++;
  return { id: `r${seq}`, track: "相手", start: seq * 10, end: seq * 10 + 9, text, ...extra };
};

type Step = Op[] | Error;

// 台本どおりに差分操作を返す（Error なら失敗する）偽物の差分更新。呼ばれた入力を記録する。
function scripted(...script: Step[]) {
  const calls: DiffInput[] = [];
  const updater = async (input: DiffInput) => {
    calls.push(input);
    const step = script[calls.length - 1] ?? [];
    if (step instanceof Error) throw step;
    return { ops: step };
  };
  return { calls, updater };
}

// 差分更新が呼ばれたら失敗する偽物。復元が LLM を呼ばないことの確認に使う。
function forbidden() {
  const calls: DiffInput[] = [];
  const updater = async (input: DiffInput): Promise<{ ops: Op[] }> => {
    calls.push(input);
    throw new Error("復元で差分更新が呼ばれた");
  };
  return { calls, updater };
}

// ファイルに書いて読み直した形（at 付きの JSONL 1 行ぶん）にする
const viaJsonl = (events: LogEvent[]): unknown[] =>
  events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-01T00:00:0${i % 10}.000Z`, ...e })));

// すべての種類の操作・捨てられる操作・失敗・重複の印・論点の決定済み・未処理の発言を起こした元のセッション
async function original() {
  const p = Array.from({ length: 6 }, () => [remark("発言"), remark("発言")] as const);
  const id = (i: number, j: 0 | 1) => p[i]![j].id;
  const script: Step[] = [
    [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [id(0, 0)] },
      { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [id(0, 0)] },
      { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: [id(0, 1)] },
      { op: "add", ref: "t4", parent: "root", kind: "課題", text: "面接官が足りない", evidence: [id(0, 1)] },
      { op: "add", ref: "t5", parent: "root", kind: "課題", text: "面接の担当が偏る", evidence: [id(0, 0)] }, // 統合で統合先が新しく得る根拠
    ],
    [
      { op: "update", node: "n3", text: "3 回にする", evidence: [id(1, 0)], planStatus: "却下" },
      { op: "combine", from: "n5", into: "n4" },
      { op: "add", ref: "d1", parent: "n2", kind: "決定", text: "2 回にする", evidence: [id(1, 1)] },
    ],
    [
      { op: "delete", node: "n6" },
      { op: "add", ref: "t7", parent: "n1", kind: "TODO", text: "求人票を直す", evidence: [id(2, 0)] },
    ],
    [{ op: "delete", node: "n99" }], // 捨てられる操作
    new Error("timeout"), // 差分更新の失敗
    [
      { op: "move", node: "n3", parent: "n1" },
      { op: "add", ref: "t8", parent: "root", kind: "論点", text: "予算", evidence: [id(5, 0)] },
    ],
  ];
  const { updater } = scripted(...script);
  const events: LogEvent[] = [];
  const session = createSession({ title: "定例", updater, log: (e) => events.push(e) });
  const push = async (...rs: Remark[]) => {
    for (const r of rs) session.push(r);
    await session.idle();
  };
  await push(...p[0]!);
  await push(...p[1]!);
  await push(...p[2]!);
  await push(remark("予算は来週決めます", { track: "自分", duplicate: true }));
  await push(...p[3]!);
  await push(...p[4]!);
  await push(...p[5]!);
  const lone = remark("最後の発言"); // 2 つに満たず、まだ差分更新に渡っていない
  await push(lone);
  return { session, events, lone };
}

describe("ログからの復元", () => {
  it("ログのイベントを順に適用して、ノードの ID を含め元のマップと一致するマップに戻す", async () => {
    const { session, events } = await original();
    const { updater } = forbidden();
    const restored = restoreSession(viaJsonl(events), { updater, log: () => {} });

    expect(restored.snapshot()).toEqual(session.snapshot());
    expect(restored.exportJson()).toEqual(session.exportJson());
    // 変わったこと（round・at・記録）もログから同じ値に戻る
    expect(restored.snapshot().changes).toEqual(session.snapshot().changes);
    expect(restored.snapshot().round).toBe(session.snapshot().round);
  });

  it("復元したセッションの今の議題と今の時刻が元と一致する（議題の無い課題だけの反映は前の値のまま）", async () => {
    const { session, events } = await original();
    const { updater } = forbidden();
    const restored = restoreSession(viaJsonl(events), { updater, log: () => {} });

    expect(session.snapshot().currentTopic).toBe("n1");
    expect(restored.snapshot().currentTopic).toBe(session.snapshot().currentTopic);
    expect(session.snapshot().now).toBeDefined();
    expect(restored.snapshot().now).toBe(session.snapshot().now);
  });

  it("作成順と逆の順に更新した反映でも、復元後の今の議題・最後に変わったノードが元と一致する", async () => {
    const [a, b, c, d] = [remark("発言"), remark("発言"), remark("発言"), remark("発言")];
    const { updater } = scripted(
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a!.id] },
        { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [b!.id] },
      ],
      [
        { op: "update", node: "n2", text: "予算2", evidence: [c!.id] },
        { op: "update", node: "n1", text: "採用2", evidence: [d!.id] },
      ],
    );
    const events: LogEvent[] = [];
    const session = createSession({ title: "定例", updater, log: (e) => events.push(e) });
    for (const r of [a!, b!]) session.push(r);
    await session.idle();
    for (const r of [c!, d!]) session.push(r);
    await session.idle();

    const restored = restoreSession(viaJsonl(events), { updater: forbidden().updater, log: () => {} });
    expect(session.snapshot().currentTopic).toBe("n1");
    expect(restored.snapshot().currentTopic).toBe("n1");
    expect(restored.snapshot().lastChanged).toBe("n1");
    expect(restored.snapshot()).toEqual(session.snapshot());
  });

  it("元のマップにこの経路の全種類の変化が出ている（テストの前提）", async () => {
    const { session, events } = await original();
    const snap = session.snapshot();
    const node = (id: string) => snap.nodes.find((n) => n.id === id);
    expect(snap.nodes[0]).toMatchObject({ id: "root", text: "定例" });
    expect(node("n3")).toMatchObject({ text: "3 回にする", planStatus: "却下", parent: "n1" });
    expect(node("n5")).toBeUndefined(); // 統合された
    expect(node("n6")).toBeUndefined(); // 削除された
    expect(node("n2")).toMatchObject({ pointStatus: "未決" });
    const diffs = events.flatMap((e) => (e.type === "diff" ? [e] : []));
    expect(diffs.some((d) => d.dropped.length > 0)).toBe(true);
    expect(diffs.some((d) => d.error !== undefined)).toBe(true);
    // 変わったこと: 成功した 5 回の反映で round が進み（失敗した 1 回は進まない）、全種類の変化が記録されている
    expect(snap.round).toBe(5);
    const types = new Set(snap.changes.map((c) => c.change));
    expect(types).toEqual(new Set(["追加", "更新", "決定済み化", "却下", "移動", "統合"]));
    expect(snap.changes.find((c) => c.change === "統合")).toMatchObject({ node: "n4", round: 2 });
    expect(snap.changes.find((c) => c.change === "決定済み化")).toMatchObject({ node: "n2", round: 2 });
    expect(snap.changes.find((c) => c.change === "却下")).toMatchObject({ node: "n3", round: 2 });
  });

  it("復元の間は差分更新を呼ばず、イベントをログに書き直さない", async () => {
    const { events } = await original();
    const { calls, updater } = forbidden();
    const logged: LogEvent[] = [];
    const restored = restoreSession(viaJsonl(events), { updater, log: (e) => logged.push(e) });
    await restored.idle();

    expect(calls).toHaveLength(0);
    expect(logged).toEqual([]);
  });

  it("知らない種類のイベントは読み飛ばし、残りで同じマップに戻す", async () => {
    const { session, events } = await original();
    const lines = viaJsonl(events);
    const unknown = (n: number) => ({ type: "jev", at: "2026-10-01T00:00:00.000Z", n });
    const withUnknown = [
      unknown(0),
      lines[0],
      unknown(1),
      ...lines.slice(1, 4),
      // 知っている種類のフィールド名を持っていても、種類が違えば読み飛ばす
      { type: "future", remark: { id: "r-x", track: "相手", start: 0, end: 1, text: "x" }, ops: [{ op: "delete", node: "n1" }] },
      ...lines.slice(4),
      unknown(2),
    ];
    const { updater } = forbidden();
    const restored = restoreSession(withUnknown, { updater, log: () => {} });

    expect(restored.snapshot()).toEqual(session.snapshot());
    expect(restored.exportJson()).toEqual(session.exportJson());
  });

  // Issue #161: ヘルパーの予期せぬ終了・起動し直し・諦め・resume を記録する新しいログの種類（intake-stopped・intake-restarted・
  // intake-gave-up）があっても、復元は壊れない（order.md:74 が明示）。知らない種類を読み飛ばす既存の規則（`core/session.ts` の
  // switch に default がない）を使うので、CT-RESTORE はこの固有の種類で確かめる（前のテストの汎用の未知種類とは別の検証）
  it("ヘルパーが止まった・起動し直した・諦めた・resume のログ（intake-stopped・intake-restarted・intake-gave-up）を含んでいても、復元は同じマップに戻り、それらの行はマップに反映されない", async () => {
    const { session, events } = await original();
    const lines = viaJsonl(events);
    const withIntakeEvents = [
      lines[0],
      { type: "intake-stopped", code: 1, signal: null, stderrTail: ["error: boom"] },
      ...lines.slice(1, 3),
      { type: "intake-restarted", trigger: "auto" },
      ...lines.slice(3, 5),
      { type: "intake-gave-up" },
      { type: "intake-restarted", trigger: "resume" },
      ...lines.slice(5),
    ];
    const { updater } = forbidden();
    const restored = restoreSession(withIntakeEvents, { updater, log: () => {} });

    expect(restored.snapshot()).toEqual(session.snapshot());
    expect(restored.exportJson()).toEqual(session.exportJson());
    // intake 系の行の内容（stderr 等）がマップへ漏れていない
    expect(JSON.stringify(restored.exportJson())).not.toContain("boom");
  });

  it("復元したセッションは続きの発言を受け取り、元のセッションと同じ入力・同じマップになる", async () => {
    const { events, lone } = await original();
    const next = remark("続きの発言");
    const more: Op[] = [{ op: "add", ref: "t9", parent: "root", kind: "議題", text: "続き", evidence: [lone.id, next.id] }];

    const cont = scripted(more);
    const contEvents: LogEvent[] = [];
    const restored = restoreSession(viaJsonl(events), { updater: cont.updater, log: (e) => contEvents.push(e) });
    restored.push(next);
    await restored.idle();

    // 未処理だった発言は、復元後の最初の差分更新に、続きの発言と合わせて渡る
    expect(cont.calls).toHaveLength(1);
    expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([lone.id, next.id]);
    // 直前の発言は、復元前に処理済みだった最後の 3 つ
    expect(cont.calls[0]!.recent).toHaveLength(3);
    expect(cont.calls[0]!.map.nodes["n3"]).toMatchObject({ text: "3 回にする", planStatus: "却下" });
    // ログに書くのは復元後の新しいイベントだけ（発言と差分）
    expect(contEvents.map((e) => e.type)).toEqual(["remark", "diff"]);
    expect(restored.snapshot().nodes.find((n) => n.text === "続き")).toMatchObject({ parent: "root", evidence: [lone.id, next.id] });
  });

  it("続きの差分更新が受け取る直前の発言・マップは、元のセッションが続けた場合と同じ", async () => {
    // 元のセッションをそのまま続けた場合と、復元して続けた場合で、差分更新への入力が一致する
    const p = [remark("一"), remark("二"), remark("三"), remark("四")];
    const first: Op[] = [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [p[0]!.id] }];
    const events: LogEvent[] = [];
    const live = scripted(first, []);
    const session = createSession({ title: "定例", updater: live.updater, log: (e) => events.push(e) });
    session.push(p[0]!);
    session.push(p[1]!);
    await session.idle();
    session.push(p[2]!); // 未処理のまま落ちる
    await session.idle();

    const restoredScript = scripted([]);
    const restored = restoreSession(viaJsonl(events), { updater: restoredScript.updater, log: () => {} });
    session.push(p[3]!);
    restored.push(p[3]!);
    await session.idle();
    await restored.idle();

    expect(restoredScript.calls).toHaveLength(1);
    expect(restoredScript.calls[0]).toEqual(live.calls[1]);
    expect(restored.snapshot()).toEqual(session.snapshot());
  });

  it("中身のない発言は、印の有無にかかわらず復元後の未反映にも続きの差分更新の入力にも入れない", async () => {
    const real = remark("今日は採用の話をします");
    const filler = remark("あ", { track: "自分" });
    const marked = remark("えー");
    const events: LogEvent[] = [
      { type: "start", title: "定例" },
      { type: "remark", remark: real },
      { type: "remark", remark: filler }, // 印のない（古い形式の）ログでも現行の基準で除く
      { type: "remark", remark: marked, noContent: true },
    ];
    const next = remark("担当は佐藤さんで");
    const cont = scripted([]);
    const restored = restoreSession(viaJsonl(events), { updater: cont.updater, log: () => {} });

    expect(restored.unreflectedRemarks().map((r) => r.id)).toEqual([real.id]);
    restored.push(next);
    await restored.idle();
    expect(cont.calls).toHaveLength(1);
    expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([real.id, next.id]);
  });

  // 中身のない発言が差分更新に渡っていた旧形式のログ（fresh にフィラーが入っている）
  function legacyLogWithProcessedFillers() {
    const f1 = remark("あ");
    const r1 = remark("今日は採用の話をします");
    const f2 = remark("えー");
    const events: LogEvent[] = [
      { type: "start", title: "定例" },
      { type: "remark", remark: f1 },
      { type: "diff", input: { recent: [], fresh: [f1.id], nodeCount: 0 }, ops: [], dropped: [] },
      { type: "remark", remark: r1 },
      { type: "remark", remark: f2 },
      {
        type: "diff",
        input: { recent: [f1.id], fresh: [r1.id, f2.id], nodeCount: 0 },
        ops: [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [r1.id] }],
        dropped: [],
      },
    ];
    return { f1, r1, f2, events };
  }

  it("処理済みだった中身のない発言は、復元後の最初の差分更新の直前の発言に入れない", async () => {
    const { r1, events } = legacyLogWithProcessedFillers();
    const n1 = remark("担当は佐藤さんで");
    const n2 = remark("来週までに");
    const cont = scripted([]);
    const restored = restoreSession(viaJsonl(events), { updater: cont.updater, log: () => {} });
    restored.push(n1);
    restored.push(n2);
    await restored.idle();

    expect(cont.calls).toHaveLength(1);
    expect(cont.calls[0]!.recent.map((u) => u.id)).toEqual([r1.id]);
    expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([n1.id, n2.id]);
  });

  it("中身のない発言を処理済みから除いても、復元した回数・変わったこと・マップは変わらない", () => {
    const { r1, f2, events } = legacyLogWithProcessedFillers();
    const restored = restoreSession(viaJsonl(events), { updater: forbidden().updater, log: () => {} });
    const snap = restored.snapshot();

    expect(snap.round).toBe(2);
    expect(snap.changes).toEqual([{ change: "追加", node: "n1", kind: "議題", text: "採用", round: 2, at: f2.end }]);
    expect(snap.nodes.find((n) => n.id === "n1")).toMatchObject({ text: "採用", evidence: [r1.id] });
  });

  it("開始のイベントがないログは、ルートの本文を推測せずエラーにする", async () => {
    const { events } = await original();
    const withoutStart = viaJsonl(events).filter((e) => (e as { type: string }).type !== "start");
    const { updater } = forbidden();
    expect(() => restoreSession(withoutStart, { updater, log: () => {} })).toThrow();
    expect(() => restoreSession([], { updater, log: () => {} })).toThrow();
  });
});

describe("開始のイベント", () => {
  it("createSession は最初のイベントとしてタイトルを持つ開始のイベントをログに書く", () => {
    const events: LogEvent[] = [];
    createSession({ title: "定例", updater: scripted().updater, log: (e) => events.push(e) });
    expect(events).toEqual([{ type: "start", title: "定例" }]);
  });
});
