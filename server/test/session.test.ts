import { describe, expect, it, vi } from "vitest";
import { createSession, hasContent, QUIET_MS, type DiffInput, type LogEvent, type Op, type Remark } from "../src/core/index.ts";

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

describe("hasContent（中身のある発言か）", () => {
  it.each([
    ["あ"],
    ["えー"],
    ["うん"],
    ["あ。"],
    ["うん。"],
    ["えー、あの"],
    ["えーっと"],
    ["はい"],
    ["  "],
    [""],
  ])("フィラーだけの %j は中身なし", (text) => {
    expect(hasContent(text)).toBe(false);
  });

  it.each([
    ["はい。では採用の進め方を決めます。"],
    ["今日は採用の進め方を決めます"],
    ["2 回にしましょう"],
    ["賛成"],
    ["あの件は来週決めます"], // 語として区切られていない「あの」はフィラーではない
    ["えー、予算は来週決めます"],
  ])("意味のある %j は中身あり", (text) => {
    expect(hasContent(text)).toBe(true);
  });
});

describe("中身のない発言の扱い", () => {
  it("差分更新に渡さず数えないが、捨てた印を付けてログには残す", async () => {
    const a = remark("今日は採用の話をします");
    const filler = remark("あ", { track: "自分" });
    const b = remark("担当は佐藤さんで");
    const { session, calls, events } = setup();

    session.push(a);
    session.push(filler);
    await session.idle();
    expect(calls).toHaveLength(0); // フィラーは 2 つ目として数えない

    session.push(b);
    await session.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id, b.id]);

    expect(events).toContainEqual({ type: "remark", remark: filler, noContent: true });
    expect(events).toContainEqual({ type: "remark", remark: a });
    const marked = events.filter((e) => e.type === "remark" && "noContent" in e);
    expect(marked).toHaveLength(1);
  });

  it("中身のない発言だけでは差分更新を呼ばない", async () => {
    const { session, calls } = setup();
    session.push(remark("あ", { track: "自分" }));
    session.push(remark("えー"));
    session.push(remark("うん"));
    await session.idle();
    expect(calls).toHaveLength(0);
  });

  it("中身のない発言は待ち時間の起点にならない（最後の中身のある発言から数える）", async () => {
    const timers: { ms: number; fire: () => void }[] = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => timers.push({ ms, fire: resolve }));
    const calls: DiffInput[] = [];
    const updater = async (input: DiffInput) => {
      calls.push(input);
      return { ops: [] as Op[] };
    };
    const session = createSession({ title: "定例", updater, log: () => {}, sleep });
    const a = remark("今日は採用の話をします");

    session.push(a);
    session.push(remark("あ", { track: "自分" }));
    expect(timers).toHaveLength(1); // フィラーは新しい待ちを仕掛けない
    for (const t of timers) t.fire();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await session.idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id]);
  });
});

describe("差分更新の呼び出し: 発言が 1 つでも一定時間で呼ぶ", () => {
  // 待ち方（sleep）の偽物。呼ばれた待ちを貯め、テストの側から「時間が経った」ことにできる。
  function fakeSleep() {
    const timers: { ms: number; fire: () => void }[] = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => timers.push({ ms, fire: resolve }));
    return { timers, sleep };
  }
  // 解決した待ちの後続（マイクロタスク・差分更新の呼び出し）が落ち着くまで進める
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const fireAll = async (timers: { fire: () => void }[]) => {
    for (const t of timers) t.fire();
    await settle();
  };

  // 応答をテストの側から返せる差分更新の偽物
  function manual() {
    const calls: { input: DiffInput; reply: () => void }[] = [];
    const updater = (input: DiffInput) =>
      new Promise<{ ops: Op[] }>((resolve) => calls.push({ input, reply: () => resolve({ ops: [] }) }));
    return { calls, updater };
  }
  const ids = (input: DiffInput) => input.fresh.map((u) => u.id);

  it("定数 QUIET_MS は 1.5 秒（ミリ秒）", () => {
    expect(QUIET_MS).toBe(1500);
  });

  it("発言が 1 つだけたまり、最後の発言から QUIET_MS 経っても新しい発言が来なければ、その 1 つで差分更新を呼ぶ", async () => {
    const { timers, sleep } = fakeSleep();
    const { calls, updater } = manual();
    const session = createSession({ title: "定例", updater, log: () => {}, sleep });
    const a = remark("今日は採用の話をします");

    session.push(a);
    await settle();
    expect(calls).toHaveLength(0); // 待ちが切れる前は呼ばない
    expect(timers.map((t) => t.ms)).toEqual([QUIET_MS]);

    await fireAll(timers);
    expect(calls).toHaveLength(1);
    expect(ids(calls[0]!.input)).toEqual([a.id]);
  });

  it("QUIET_MS 以内に 2 つ目が来れば、2 つまとめて 1 回だけ呼ぶ。最初の発言の待ちが後で切れても呼びは増えない", async () => {
    const { timers, sleep } = fakeSleep();
    const { calls, updater } = manual();
    const session = createSession({ title: "定例", updater, log: () => {}, sleep });
    const [a, b] = [remark("一"), remark("二")];

    session.push(a);
    await settle();
    expect(calls).toHaveLength(0);
    session.push(b);
    expect(calls).toHaveLength(1);
    expect(ids(calls[0]!.input)).toEqual([a.id, b.id]);

    calls[0]!.reply();
    await session.idle();
    await fireAll(timers); // a の待ちが切れても、たまっている発言が無いので何も起きない
    expect(calls).toHaveLength(1);
  });

  it("古い待ちが切れても、後から来た発言をその時点で流さない（待ちは最後の発言から数える）", async () => {
    const { timers, sleep } = fakeSleep();
    const { calls, updater } = manual();
    const session = createSession({ title: "定例", updater, log: () => {}, sleep });
    const [a, b, c] = [remark("一"), remark("二"), remark("三")];

    session.push(a);
    session.push(b);
    calls[0]!.reply();
    await session.idle();
    const stale = [...timers]; // a の時点で仕掛けられた待ち
    session.push(c); // 1 つだけたまる。c の待ちはまだ切れていない
    await fireAll(stale);
    expect(calls).toHaveLength(1);

    await fireAll(timers.filter((t) => !stale.includes(t))); // c の待ちが切れて、はじめて流す
    expect(calls).toHaveLength(2);
    expect(ids(calls[1]!.input)).toEqual([c.id]);
  });

  it("呼び出し中は、待ちが切れても呼ばない。終わった時点で、たまった発言を次の 1 回にまとめて呼ぶ", async () => {
    const { timers, sleep } = fakeSleep();
    const { calls, updater } = manual();
    const session = createSession({ title: "定例", updater, log: () => {}, sleep });
    const [a, b, c] = [remark("一"), remark("二"), remark("三")];

    session.push(a);
    session.push(b);
    expect(calls).toHaveLength(1); // a, b が呼び出し中
    session.push(c);
    await fireAll(timers); // c の待ちも切れる。それでも呼び出し中は呼ばない
    expect(calls).toHaveLength(1);

    calls[0]!.reply();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(ids(calls[1]!.input)).toEqual([c.id]);
    expect(calls[1]!.input.recent.map((u) => u.id)).toEqual([a.id, b.id]);

    calls[1]!.reply();
    await session.idle();
    await fireAll(timers);
    expect(calls).toHaveLength(2);
  });

  it("呼び出し中にたまった発言が 2 つ以上あれば、待ちが切れていなくても、終わった時点で 1 回にまとめて呼ぶ", async () => {
    const { sleep } = fakeSleep();
    const { calls, updater } = manual();
    const session = createSession({ title: "定例", updater, log: () => {}, sleep });
    const [a, b, c, d] = [remark("一"), remark("二"), remark("三"), remark("四")];

    for (const r of [a, b, c, d]) session.push(r);
    expect(calls).toHaveLength(1);
    calls[0]!.reply();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(ids(calls[1]!.input)).toEqual([c.id, d.id]);
  });

  it("呼び出しが終わった時点で 1 つだけたまっていて、その待ちがまだ切れていなければ、待ちが切れるまで呼ばない", async () => {
    const { timers, sleep } = fakeSleep();
    const { calls, updater } = manual();
    const session = createSession({ title: "定例", updater, log: () => {}, sleep });
    const [a, b, c] = [remark("一"), remark("二"), remark("三")];

    session.push(a);
    session.push(b);
    session.push(c);
    calls[0]!.reply();
    await session.idle();
    expect(calls).toHaveLength(1);

    await fireAll(timers);
    expect(calls).toHaveLength(2);
    expect(ids(calls[1]!.input)).toEqual([c.id]);
  });

  it("待ち方（sleep）を渡さなければ、1 つだけ残った発言は待たずに、flush まで呼ばない", async () => {
    const { calls, updater } = manual();
    const session = createSession({ title: "定例", updater, log: () => {} });

    session.push(remark("一"));
    await settle();
    expect(calls).toHaveLength(0);
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

describe("根拠の発言（snapshot().remarks）", () => {
  const add = (ref: string, text: string, evidence: string[]): Op => ({ op: "add", ref, parent: "root", kind: "議題", text, evidence });

  it("ノードの根拠に挙がった発言の 時刻・トラック・本文 を、ID で引ける形で含める", async () => {
    const a = remark("採用の話をします", { track: "自分", start: 1.5, end: 9.5 });
    const b = remark("面接を何回にするか", { track: "相手", start: 10, end: 19 });
    const { session } = setup([add("t1", "採用", [a.id, b.id])]);
    session.push(a);
    session.push(b);
    await session.idle();

    const snap = session.snapshot();
    const node = snap.nodes.find((n) => n.text === "採用")!;
    expect(node.evidence).toEqual([a.id, b.id]);
    for (const id of node.evidence) expect(snap.remarks.filter((r) => r.id === id)).toHaveLength(1);
    expect(snap.remarks.find((r) => r.id === a.id)).toMatchObject({ track: "自分", start: 1.5, end: 9.5, text: "採用の話をします" });
    expect(snap.remarks.find((r) => r.id === b.id)).toMatchObject({ track: "相手", start: 10, end: 19, text: "面接を何回にするか" });
  });

  it("どのノードの根拠にもなっていない発言（重複の印つき・未処理）は含めず、受け取った順に並べる", async () => {
    const a = remark("一つ目");
    const echo = remark("反響", { duplicate: true });
    const b = remark("二つ目");
    const c = remark("三つ目（反映待ち）");
    const { session } = setup([add("t1", "採用", [b.id, a.id])]);
    for (const r of [a, echo, b, c]) session.push(r);
    await session.idle();

    expect(session.snapshot().remarks.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("複数のノードが同じ発言を根拠にしても、発言は 1 度だけ含める", async () => {
    const [a, b] = [remark("一"), remark("二")];
    const { session } = setup([add("t1", "採用", [a.id]), add("t2", "評価", [a.id, b.id])]);
    session.push(a);
    session.push(b);
    await session.idle();

    expect(session.snapshot().remarks.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("同じセッションで update が根拠を足すと、その発言が次の snapshot から含まれる", async () => {
    const [a, b, c, d] = [remark("一"), remark("二"), remark("三"), remark("四")];
    const { session } = setup([add("t1", "採用", [a.id])], [{ op: "update", node: "n1", evidence: [c.id] }]);
    session.push(a);
    session.push(b);
    await session.idle();
    expect(session.snapshot().remarks.map((r) => r.id)).toEqual([a.id]);

    session.push(c);
    session.push(d);
    await session.idle();
    expect(session.snapshot().remarks.map((r) => r.id)).toEqual([a.id, c.id]);
  });

  it("ルートだけのマップでは remarks は空", () => {
    const { session } = setup();
    expect(session.snapshot().remarks).toEqual([]);
  });

  it("返した remarks を書き換えても、セッションの記録にも次の snapshot にも影響しない", async () => {
    const [a, b] = [remark("元の本文"), remark("二")];
    const { session } = setup([add("t1", "採用", [a.id])]);
    session.push(a);
    session.push(b);
    await session.idle();

    const first = session.snapshot();
    first.remarks[0]!.text = "書き換え";
    first.remarks.length = 0;
    expect(session.snapshot().remarks.map((r) => r.text)).toEqual(["元の本文"]);
    expect(a.text).toBe("元の本文");
  });
});

describe("unreflectedRemarks（反映前の発言）", () => {
  it("差分更新に渡した結果待ちの発言、続けて渡していない発言の順に返す。重複の印つきは含まない", async () => {
    let release: (out: { ops: Op[] }) => void = () => {};
    const updater = () => new Promise<{ ops: Op[] }>((resolve) => (release = resolve));
    const session = createSession({ title: "定例", updater, log: () => {} });
    const [a, b, dup, c] = [remark("ア"), remark("イ"), remark("重複", { duplicate: true }), remark("ウ")];

    session.push(a);
    session.push(dup);
    expect(session.unreflectedRemarks().map((r) => r.id)).toEqual([a.id]); // まだ渡していない
    session.push(b); // a・b が差分更新に渡り、結果待ちになる
    session.push(c);
    expect(session.unreflectedRemarks().map((r) => r.id)).toEqual([a.id, b.id, c.id]);

    release({ ops: [{ op: "noop", reason: "なし" }] });
    await session.idle();
    expect(session.unreflectedRemarks().map((r) => r.id)).toEqual([c.id]);
  });

  it("中身のない発言は、渡す前も結果待ちの間も含まない", async () => {
    let release: (out: { ops: Op[] }) => void = () => {};
    const updater = () => new Promise<{ ops: Op[] }>((resolve) => (release = resolve));
    const session = createSession({ title: "定例", updater, log: () => {} });
    const [a, filler, b, filler2] = [remark("ア"), remark("あ", { track: "自分" }), remark("イ"), remark("えー")];

    session.push(a);
    session.push(filler);
    expect(session.unreflectedRemarks().map((r) => r.id)).toEqual([a.id]);
    session.push(b); // a・b が結果待ちになる
    session.push(filler2);
    expect(session.unreflectedRemarks().map((r) => r.id)).toEqual([a.id, b.id]);

    release({ ops: [{ op: "noop", reason: "なし" }] });
    await session.idle();
    expect(session.unreflectedRemarks()).toEqual([]);
  });

  it("返した発言を書き換えても、セッションの記録にも次の呼び出しにも影響しない", () => {
    const session = createSession({ title: "定例", updater: async () => ({ ops: [] }), log: () => {} });
    const a = remark("元の本文");
    session.push(a);

    const first = session.unreflectedRemarks();
    first[0]!.text = "書き換え";
    first.length = 0;

    expect(session.unreflectedRemarks().map((r) => r.text)).toEqual(["元の本文"]);
    expect(a.text).toBe("元の本文");
  });
});

describe("今の議題（currentTopic）と会議の今の時刻（now）", () => {
  const nested = (ids: string[][]): Op[] => [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: [ids[0]![1]!] },
  ];

  it("議題の下のノードが変わると、その最も近い祖先の議題になる", async () => {
    const { snap, byText } = await play(nested);
    expect(snap.currentTopic).toBe(byText("採用")!.id);
  });

  it("議題の下の議題では、最も近い議題になる", async () => {
    const { snap, byText } = await play((ids) => [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t2", parent: "t1", kind: "議題", text: "面接", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t3", parent: "t2", kind: "論点", text: "何回か", evidence: [ids[0]![1]!] },
    ]);
    expect(snap.currentTopic).toBe(byText("面接")!.id);
  });

  it("変わったノード自身が議題なら、その議題自身になる", async () => {
    const { snap, byText } = await play(nested, (ids) => [
      { op: "add", ref: "t4", parent: "root", kind: "議題", text: "予算", evidence: [ids[1]![0]!] },
    ]);
    expect(snap.currentTopic).toBe(byText("予算")!.id);
  });

  it("1 回の反映で複数のノードが変わると、最後に変わったノードの議題になる", async () => {
    const { snap, byText } = await play((ids) => [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t3", parent: "t1", kind: "課題", text: "面接官が足りない", evidence: [ids[0]![1]!] },
    ]);
    expect(snap.currentTopic).toBe(byText("採用")!.id);
  });

  describe("最後に変わったノードは、作成順ではなく操作の適用順で選ぶ", () => {
    const first = (ids: string[][]): Op[] => [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!] },
    ];
    const second = (ids: string[][], extra: Op[] = []): Op[] => [
      { op: "update", node: "n2", text: "予算2", evidence: [ids[1]![0]!] },
      { op: "update", node: "n1", text: "採用2", evidence: [ids[1]![1]!] },
      ...extra,
    ];

    it("作成順と逆の順（n2 → n1）に更新すると、n1 が今の議題・最後に変わったノードになる", async () => {
      const { snap } = await play(first, (ids) => second(ids));
      expect(snap.currentTopic).toBe("n1");
      expect(snap.lastChanged).toBe("n1");
      // 変わったことの記録の並びは作成順のまま
      expect(snap.changes.filter((c) => c.round === 2).map((c) => c.node)).toEqual(["n1", "n2"]);
    });

    it("値を変えない操作や、捨てられる操作を最後に置いても、数えない", async () => {
      const unchanged = await play(first, (ids) => second(ids, [{ op: "update", node: "n2", evidence: [ids[0]![1]!] }]));
      expect(unchanged.snap.currentTopic).toBe("n1");
      expect(unchanged.snap.lastChanged).toBe("n1");
      const droppedOp = await play(first, (ids) => second(ids, [{ op: "update", node: "n2", text: "x", evidence: ["r999"] }]));
      expect(droppedOp.dropped).toHaveLength(1);
      expect(droppedOp.snap.currentTopic).toBe("n1");
      expect(droppedOp.snap.lastChanged).toBe("n1");
    });

    it("最後に値を変える操作が n2 なら、n2 になる", async () => {
      const { snap } = await play(first, (ids) => second(ids, [{ op: "update", node: "n2", text: "予算3", evidence: [ids[0]![1]!] }]));
      expect(snap.currentTopic).toBe("n2");
      expect(snap.lastChanged).toBe("n2");
    });

    it("変更履歴に載らない変化（案の状態だけを却下から検討中に戻す）でも、その案の議題が今の議題・最後に変わったノードになる", async () => {
      const { snap, session } = await play(
        (ids) => [
          { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
          { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
          { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: [ids[0]![1]!] },
        ],
        (ids) => [{ op: "update", node: "n3", planStatus: "却下", evidence: [ids[0]![1]!] }],
        (ids) => [{ op: "add", ref: "t4", parent: "root", kind: "議題", text: "予算", evidence: [ids[2]![0]!] }],
        (ids) => [{ op: "update", node: "n3", planStatus: "検討中", evidence: [ids[0]![1]!] }],
      );
      expect(snap.changes.filter((c) => c.round === 4)).toEqual([]); // 変更履歴には載らない
      expect(snap.currentTopic).toBe("n1");
      expect(snap.lastChanged).toBe("n3");
      expect(session.snapshot().lastChanged).toBe("n3");
    });

    it("変わったノードが無い反映では lastChanged のキーを付けず、currentTopic は前の値のまま", async () => {
      const { snap } = await play(first, [{ op: "noop", reason: "変化なし" }]);
      expect("lastChanged" in snap).toBe(false);
      expect(snap.currentTopic).toBe("n2");
    });
  });

  it("後の反映で別の議題の下が変わると、今の議題が移る", async () => {
    const { snap, byText } = await play(
      (ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!] },
      ],
      (ids) => [{ op: "add", ref: "t3", parent: "n1", kind: "課題", text: "面接官が足りない", evidence: [ids[1]![0]!] }],
    );
    expect(snap.currentTopic).toBe(byText("採用")!.id);
  });

  it("何も変わらなかった反映（noop・捨てられる操作だけ）では、前の値のまま", async () => {
    const { snap, byText } = await play(
      nested,
      [{ op: "noop", reason: "変化なし" }],
      [{ op: "delete", node: "n99" }],
    );
    expect(snap.round).toBe(3);
    expect(snap.currentTopic).toBe(byText("採用")!.id);
  });

  it("差分更新が失敗した反映でも、前の値のまま", async () => {
    const calls: number[] = [];
    const updater = async (input: DiffInput) => {
      calls.push(1);
      if (calls.length === 2) throw new Error("timeout");
      return { ops: nested([[input.fresh[0]!.id, input.fresh[1]!.id]]) };
    };
    const session = createSession({ title: "定例", updater, log: () => {} });
    for (let i = 0; i < 2; i++) {
      session.push(remark("発言"));
      session.push(remark("発言"));
      await session.idle();
    }
    const snap = session.snapshot();
    expect(snap.round).toBe(1);
    expect(snap.currentTopic).toBe("n1");
  });

  it("議題がまだ無いうちは、currentTopic のキーを付けない（議題以外だけのノードでも）", async () => {
    const empty = await play([{ op: "noop", reason: "まだ" }]);
    expect("currentTopic" in empty.snap).toBe(false);
    const noTopic = await play((ids) => [{ op: "add", ref: "t1", parent: "root", kind: "課題", text: "面接官が足りない", evidence: [ids[0]![0]!] }]);
    expect("currentTopic" in noTopic.snap).toBe(false);
  });

  it("now は最後に受け取った発言の end（重複の印つきの発言を含む）。発言が無ければキーを付けない", async () => {
    expect("now" in createSession({ title: "定例", updater: scripted().updater, log: () => {} }).snapshot()).toBe(false);
    const { session, snap } = await play(nested);
    expect(snap.now).toBe(seq * 10 + 9);
    const dup = remark("重複", { duplicate: true });
    session.push(dup);
    expect(session.snapshot().now).toBe(dup.end);
  });
});
