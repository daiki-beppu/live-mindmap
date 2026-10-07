import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { hasContent, makeSession, QUIET_MS, type DiffInput, type DiffOutput, type LogEvent, type Op, type Remark, type Session } from "../src/core/index.ts";
import { collectLog, logLayer, settleUntil, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

// セッションは Scope を要る Effect（makeSession）。差分更新・ログは偽物の Service を Layer で渡す。
// QUIET_MS の待ちは TestClock で進める（実時間では待たない）。

let seq = 0;
const remark = (text: string, extra: Partial<Remark> = {}): Remark => {
  seq++;
  return { id: `r${seq}`, track: "相手", start: seq * 10, end: seq * 10 + 9, text, ...extra };
};

// 台本どおりに差分操作を返す偽物の差分更新。呼ばれた入力を記録する。
function scripted(...script: Op[][]) {
  const calls: DiffInput[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
    Effect.sync(() => {
      calls.push(input);
      return { ops: script[calls.length - 1] ?? [{ op: "noop" as const, reason: "台本切れ" }] };
    });
  return { calls, update };
}

// 応答をテストの側から返せる偽物の差分更新
type ManualCall = { input: DiffInput; reply: () => void };
function manual() {
  const calls: ManualCall[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
    Effect.callback<DiffOutput, UpdateFailure>((resume) => {
      calls.push({ input, reply: () => resume(Effect.succeed({ ops: [] })) });
    });
  return { calls, update };
}

// 時間を進めた後に、起こるはずの呼び出しが走り切るまで譲る。「呼ばれない」ことの確認の前にも使う
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

const open = (update: (input: DiffInput) => Effect.Effect<DiffOutput, UpdateFailure>, events: LogEvent[] = []) =>
  makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));

const setup = Effect.fn("setup")(function* (...script: Op[][]) {
  const { calls, update } = scripted(...script);
  const events: LogEvent[] = [];
  const session = yield* open(update, events);
  return { session, calls, events };
});

// 台本の 1 手ごとに発言を 2 つ流し、差分更新を 1 回ずつ起こす。流した発言の ID を手ごとに返す。
const play = Effect.fn("play")(function* (...script: (Op[] | ((ids: string[][]) => Op[]))[]) {
  const pairs = script.map(() => [remark("発言"), remark("発言")] as const);
  const ids = pairs.map((p) => p.map((u) => u.id));
  const resolved = script.map((s) => (typeof s === "function" ? s(ids) : s));
  const { session, calls, events } = yield* setup(...resolved);
  for (const [a, b] of pairs) {
    yield* session.push(a);
    yield* session.push(b);
    yield* session.idle;
  }
  const snap = yield* session.snapshot;
  const byText = (text: string) => snap.nodes.find((n) => n.text === text);
  const dropped = events.flatMap((e) => (e.type === "diff" ? e.dropped : []));
  return { session, calls, events, snap, byText, dropped, ids };
});

describe("差分操作の検証と適用", () => {
  it.effect("追加の仮 ID を同じ応答の後続の操作から親として参照できる", () =>
    Effect.gen(function* () {
      const { byText } = yield* play((ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![1]!] },
      ]);
      expect(byText("面接は何回か")!.parent).toBe(byText("採用")!.id);
    }));

  it.effect("成り立たない操作は捨てて理由をログに残し、残りの操作は適用する", () =>
    Effect.gen(function* () {
      const { byText, dropped } = yield* play((ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "t1", kind: "決定", text: "面接は 2 回", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t3", parent: "t1", kind: "課題", text: "面接官が足りない", evidence: [ids[0]![1]!] },
      ]);
      expect(byText("面接は 2 回")).toBeUndefined();
      expect(byText("面接官が足りない")).toBeDefined();
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ op: { text: "面接は 2 回" }, reason: expect.stringContaining("論点") });
    }));

  it.effect("知らない発言を根拠に挙げた追加と更新は、一部だけでも捨てて理由を残す", () =>
    Effect.gen(function* () {
      const { byText, dropped } = yield* play(
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
    }));

  it.effect("既存のノードの ID と重なる仮 ID の追加は捨て、後続の操作は既存のノードを指す", () =>
    Effect.gen(function* () {
      const { byText, dropped } = yield* play(
        (ids) => [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] }],
        (ids) => [
          { op: "add", ref: "n1", parent: "root", kind: "議題", text: "予算", evidence: [ids[1]![0]!] },
          { op: "add", ref: "t2", parent: "n1", kind: "課題", text: "面接官が足りない", evidence: [ids[1]![1]!] },
        ],
      );
      expect(byText("予算")).toBeUndefined();
      expect(byText("面接官が足りない")!.parent).toBe(byText("採用")!.id);
      expect(dropped.map((d) => d.reason)).toEqual(["仮 ID が既存の ID と重なる"]);
    }));

  it.effect("論点は子に決定を持つと決定済みになり、決定を削除すると未決に戻る", () =>
    Effect.gen(function* () {
      const first = yield* play((ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
      ]);
      expect(first.byText("面接は何回か")!.pointStatus).toBe("未決");

      const { byText, snap } = yield* play(
        (ids) => [{ op: "add", ref: "t1", parent: "root", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] }],
        (ids) => [{ op: "add", ref: "t2", parent: "n1", kind: "決定", text: "2 回にする", evidence: [ids[1]![0]!] }],
      );
      expect(byText("面接は何回か")!.pointStatus).toBe("決定済み");

      const decisionId = snap.nodes.find((n) => n.kind === "決定")!.id;
      const after = yield* play(
        (ids) => [{ op: "add", ref: "t1", parent: "root", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] }],
        (ids) => [{ op: "add", ref: "t2", parent: "n1", kind: "決定", text: "2 回にする", evidence: [ids[1]![0]!] }],
        [{ op: "delete", node: decisionId }],
      );
      expect(after.byText("2 回にする")).toBeUndefined();
      expect(after.byText("面接は何回か")!.pointStatus).toBe("未決");
    }));

  it.effect("子を持つノードの削除と、TODO の下への追加は捨てる", () =>
    Effect.gen(function* () {
      const { byText, dropped } = yield* play((ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "t1", kind: "TODO", text: "求人票を直す", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t3", parent: "t2", kind: "課題", text: "文面が古い", evidence: [ids[0]![1]!] },
        { op: "delete", node: "t1" },
      ]);
      expect(byText("採用")).toBeDefined();
      expect(byText("文面が古い")).toBeUndefined();
      expect(dropped.map((d) => d.op.op)).toEqual(["add", "delete"]);
    }));

  it.effect("統合すると統合元の根拠と子が統合先に移り、統合元は消える。種別が違えば捨てる", () =>
    Effect.gen(function* () {
      const { byText, dropped, ids } = yield* play(
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
    }));

  it.effect("更新は本文を置き換えて根拠を足し、移動は子孫ごと親を変える。どちらも ID は変わらない", () =>
    Effect.gen(function* () {
      const { snap, dropped, ids } = yield* play(
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
    }));
});

describe("ログ", () => {
  it.effect("差分操作のイベントに、入力の要約・出力・捨てた操作と理由を残す", () =>
    Effect.gen(function* () {
      const bad: Op = { op: "delete", node: "n99" };
      const { events, ids } = yield* play(
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
    }));

  it.effect("makeSession は最初のイベントとして、タイトルを持つ開始のイベントを SessionLog に書く", () =>
    Effect.gen(function* () {
      const { events } = yield* setup();
      expect(events).toEqual([{ type: "start", title: "定例" }]);
    }));
});

describe("差分更新の呼び出し", () => {
  it.effect("発言が 2 つたまると差分更新を呼び、返った追加をマップに入れる", () =>
    Effect.gen(function* () {
      const a = remark("今日は採用の話をします"), b = remark("まず面接の回数から");
      const { session, calls } = yield* setup([
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id, b.id] },
      ]);

      yield* session.push(a);
      expect(calls).toHaveLength(0);
      yield* session.push(b);
      yield* session.idle;

      expect(calls).toHaveLength(1);
      expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id, b.id]);
      const snap = yield* session.snapshot;
      const topic = snap.nodes.find((n) => n.text === "採用")!;
      expect(topic).toMatchObject({ kind: "議題", parent: "root", evidence: [a.id, b.id] });
    }));

  it.effect("重複の印が付いた発言は数えず入力にも入れないが、ログには残す", () =>
    Effect.gen(function* () {
      const a = remark("予算は来週決めます", { track: "相手" });
      const echo = remark("予算は来週決めます", { track: "自分", duplicate: true });
      const b = remark("担当は佐藤さんで");
      const { session, calls, events } = yield* setup();

      yield* session.push(a);
      yield* session.push(echo);
      yield* session.idle;
      expect(calls).toHaveLength(0);

      yield* session.push(b);
      yield* session.idle;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id, b.id]);
      const logged = events.flatMap((e) => (e.type === "remark" ? [e.remark] : []));
      expect(logged).toContainEqual(echo);
    }));

  it.effect("呼び出し中は次を呼ばず、その間にたまった発言を次の 1 回にまとめる", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c, d, e] = ["一", "二", "三", "四", "五"].map((t) => remark(t));

      for (const r of [a!, b!, c!, d!, e!]) yield* session.push(r);
      expect(calls).toHaveLength(1);

      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.input.fresh.map((u) => u.id)).toEqual([c!.id, d!.id, e!.id]);
      expect(calls[1]!.input.recent.map((u) => u.id)).toEqual([a!.id, b!.id]);

      calls[1]!.reply();
      yield* session.idle;
      expect(calls).toHaveLength(2);
    }));

  it.effect("差分更新が失敗しても、理由をログに残して次の呼び出しへ進む", () =>
    Effect.gen(function* () {
      let n = 0;
      const events: LogEvent[] = [];
      const update = (): Effect.Effect<DiffOutput, UpdateFailure> =>
        n++ === 0 ? Effect.fail({ _tag: "UpdateFailed", message: "timeout" }) : Effect.succeed({ ops: [{ op: "noop", reason: "雑談" }] });
      const session = yield* open(update, events);
      for (const t of ["一", "二", "三", "四"]) yield* session.push(remark(t));
      yield* session.idle;

      const diffs = events.filter((e) => e.type === "diff");
      expect(diffs).toHaveLength(2);
      expect(diffs[0]).toMatchObject({ ops: [], error: expect.stringContaining("timeout") });
      expect(diffs[1]).toMatchObject({ ops: [{ op: "noop" }] });
    }));

  it.effect("失敗の error は、タグ付きの失敗なら「<_tag>: <message>」、defect なら「defect: …」の形で残り、どちらも次の呼び出しへ進む", () =>
    Effect.gen(function* () {
      const steps: Effect.Effect<DiffOutput, UpdateFailure>[] = [
        Effect.fail({ _tag: "DiffUpdateFailed", message: "接続が切れた" }),
        Effect.die(new Error("想定外の例外")),
        Effect.succeed({ ops: [{ op: "noop", reason: "雑談" }] }),
      ];
      let n = 0;
      const events: LogEvent[] = [];
      const session = yield* open(() => steps[n++]!, events);
      for (let i = 0; i < 3; i++) {
        yield* session.push(remark("発言"));
        yield* session.push(remark("発言"));
        yield* session.idle;
      }

      const diffs = events.flatMap((e) => (e.type === "diff" ? [e] : []));
      expect(diffs).toHaveLength(3);
      expect(diffs[0]!.error).toBe("DiffUpdateFailed: 接続が切れた");
      expect(diffs[1]!.error).toMatch(/^defect: /);
      expect(diffs[1]!.error).toContain("想定外の例外");
      expect(diffs[2]!.error).toBeUndefined();
      expect(diffs[2]!.ops).toEqual([{ op: "noop", reason: "雑談" }]);
    }));

  it.effect("直前の発言として、処理済みのうち最後の 3 つを渡す", () =>
    Effect.gen(function* () {
      const { calls, ids } = yield* play([], [], []);
      expect(calls[2]!.recent.map((u) => u.id)).toEqual([ids[0]![1], ids[1]![0], ids[1]![1]]);
    }));

  it.effect("1 つだけ残った発言は、終わりの flush で流す", () =>
    Effect.gen(function* () {
      const [a, b, c] = ["一", "二", "三"].map((t) => remark(t));
      const { session, calls } = yield* setup();

      yield* session.push(a!);
      yield* session.push(b!);
      yield* session.push(c!);
      yield* session.idle;
      expect(calls).toHaveLength(1);

      yield* session.flush;
      expect(calls).toHaveLength(2);
      expect(calls[1]!.fresh.map((u) => u.id)).toEqual([c!.id]);
      yield* session.flush;
      expect(calls).toHaveLength(2);
    }));
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
  it.effect("差分更新に渡さず数えないが、捨てた印を付けてログには残す", () =>
    Effect.gen(function* () {
      const a = remark("今日は採用の話をします");
      const filler = remark("あ", { track: "自分" });
      const b = remark("担当は佐藤さんで");
      const { session, calls, events } = yield* setup();

      yield* session.push(a);
      yield* session.push(filler);
      yield* session.idle;
      expect(calls).toHaveLength(0); // フィラーは 2 つ目として数えない

      yield* session.push(b);
      yield* session.idle;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id, b.id]);

      expect(events).toContainEqual({ type: "remark", remark: filler, noContent: true });
      expect(events).toContainEqual({ type: "remark", remark: a });
      const marked = events.filter((e) => e.type === "remark" && "noContent" in e);
      expect(marked).toHaveLength(1);
    }));

  it.effect("中身のない発言だけでは差分更新を呼ばない", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* setup();
      yield* session.push(remark("あ", { track: "自分" }));
      yield* session.push(remark("えー"));
      yield* session.push(remark("うん"));
      yield* session.idle;
      yield* TestClock.adjust(QUIET_MS * 2); // 待ちも仕掛けていないので、時間が経っても呼ばない
      yield* session.idle;
      expect(calls).toHaveLength(0);
    }));

  it.effect("中身のない発言は待ち時間の起点にならない（最後の中身のある発言から数える）", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* setup();
      const a = remark("今日は採用の話をします");

      yield* session.push(a);
      yield* TestClock.adjust(QUIET_MS - 500);
      yield* session.push(remark("あ", { track: "自分" })); // フィラーは待ちを仕掛け直さない
      yield* TestClock.adjust(500); // a から QUIET_MS。フィラーから数えていたら、まだ呼ばれない
      yield* settleUntil(() => calls.length === 1);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id]);
    }));
});

describe("差分更新の呼び出し: 発言が 1 つでも一定時間で呼ぶ", () => {
  const ids = (input: DiffInput) => input.fresh.map((u) => u.id);

  it("定数 QUIET_MS は 1.5 秒（ミリ秒）", () => {
    expect(QUIET_MS).toBe(1500);
  });

  it.effect("発言が 1 つだけたまり、最後の発言から QUIET_MS 経っても新しい発言が来なければ、その 1 つで差分更新を呼ぶ", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const a = remark("今日は採用の話をします");

      yield* session.push(a);
      yield* TestClock.adjust(QUIET_MS - 1);
      yield* settle;
      expect(calls).toHaveLength(0); // 待ちが切れる前は呼ばない

      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls.length === 1);
      expect(calls).toHaveLength(1);
      expect(ids(calls[0]!.input)).toEqual([a.id]);
    }));

  it.effect("QUIET_MS 以内に 2 つ目が来れば、2 つまとめて 1 回だけ呼ぶ。最初の発言の待ちが後で切れても呼びは増えない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b] = [remark("一"), remark("二")];

      yield* session.push(a);
      yield* TestClock.adjust(QUIET_MS - 100);
      expect(calls).toHaveLength(0);
      yield* session.push(b);
      expect(calls).toHaveLength(1);
      expect(ids(calls[0]!.input)).toEqual([a.id, b.id]);

      calls[0]!.reply();
      yield* session.idle;
      yield* TestClock.adjust(QUIET_MS * 2); // a の待ちが切れる時刻を過ぎても、たまっている発言が無いので何も起きない
      yield* settle;
      expect(calls).toHaveLength(1);
    }));

  it.effect("古い待ちが切れる時刻を過ぎても、後から来た発言をその時点で流さない（待ちは最後の発言から数え、古い待ちは取り消される）", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a); // t=0。a の待ちは t=QUIET_MS に切れるはずだった
      yield* session.push(b); // 2 つたまったので呼ぶ。a の待ちはここで取り消される
      calls[0]!.reply();
      yield* session.idle;
      yield* TestClock.adjust(QUIET_MS - 500); // t=1000
      yield* session.push(c); // c の待ちは t=2500 に切れる
      yield* TestClock.adjust(600); // t=1600。a の待ちが生きていれば t=1500 で c を流している
      yield* settle;
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust(899); // t=2499。c の待ちの直前
      yield* settle;
      expect(calls).toHaveLength(1);
      yield* TestClock.adjust(1); // t=2500: c の待ちが切れて、はじめて流す
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(ids(calls[1]!.input)).toEqual([c.id]);
    }));

  it.effect("重複の印つきの発言は待ちを張り直さない（最後の中身のある発言から QUIET_MS 経ったときに呼ぶ）", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a);
      yield* session.push(b);
      calls[0]!.reply();
      yield* session.idle; // a・b は反映済み
      yield* session.push(c); // t=0 から QUIET_MS
      yield* TestClock.adjust(QUIET_MS - 500);
      yield* settle;
      expect(calls).toHaveLength(1);
      yield* session.push(remark("反響", { duplicate: true })); // 重複の印つきは待ちを張り直さない
      yield* TestClock.adjust(500); // c から QUIET_MS。反響から数えていたら、まだ呼ばれない
      yield* settleUntil(() => calls.length === 2);
      expect(ids(calls[1]!.input)).toEqual([c.id]);
    }));

  it.effect("呼び出し中は、待ちが切れても呼ばない。終わった時点で、たまった発言を次の 1 回にまとめて呼ぶ", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a);
      yield* session.push(b);
      expect(calls).toHaveLength(1); // a, b が呼び出し中
      yield* session.push(c);
      yield* TestClock.adjust(QUIET_MS); // c の待ちも切れる。それでも呼び出し中は呼ばない
      yield* settle;
      expect(calls).toHaveLength(1);

      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(ids(calls[1]!.input)).toEqual([c.id]);
      expect(calls[1]!.input.recent.map((u) => u.id)).toEqual([a.id, b.id]);

      calls[1]!.reply();
      yield* session.idle;
      yield* TestClock.adjust(QUIET_MS);
      yield* settle;
      expect(calls).toHaveLength(2);
    }));

  it.effect("呼び出し中にたまった発言が 2 つ以上あれば、待ちが切れていなくても、終わった時点で 1 回にまとめて呼ぶ", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c, d] = [remark("一"), remark("二"), remark("三"), remark("四")];

      for (const r of [a, b, c, d]) yield* session.push(r);
      expect(calls).toHaveLength(1);
      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(ids(calls[1]!.input)).toEqual([c.id, d.id]);
    }));

  it.effect("呼び出しが終わった時点で 1 つだけたまっていて、その待ちがまだ切れていなければ、待ちが切れるまで呼ばない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a);
      yield* session.push(b);
      yield* session.push(c);
      calls[0]!.reply();
      yield* session.idle;
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust(QUIET_MS);
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(ids(calls[1]!.input)).toEqual([c.id]);
    }));

  it.effect("時間を進めなければ、1 つだけ残った発言は待たずに呼ぶことはなく、flush まで呼ばない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);

      yield* session.push(remark("一"));
      yield* settle;
      expect(calls).toHaveLength(0);
      yield* TestClock.adjust(QUIET_MS - 1);
      yield* settle;
      expect(calls).toHaveLength(0);
    }));

  it.effect("flush は待ちが切れるのを待たず、1 つだけ残った発言を今すぐ流す", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* setup();
      const a = remark("一");

      yield* session.push(a);
      expect(calls).toHaveLength(0);
      yield* session.flush; // 時間は進めない
      expect(calls).toHaveLength(1);
      expect(ids(calls[0]!)).toEqual([a.id]);
      yield* TestClock.adjust(QUIET_MS * 2); // 取り消された待ちが後から二重に呼ばない
      yield* settle;
      expect(calls).toHaveLength(1);
    }));
});

describe("セッションの Scope（Fiber の後始末）", () => {
  it.effect("Scope を閉じると、QUIET_MS の待ちの Fiber は中断され、時間が経っても差分更新を呼ばない", () =>
    Effect.gen(function* () {
      const { calls, update } = scripted();
      const events: LogEvent[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* open(update, events);
          yield* session.push(remark("一"));
        }),
      );

      yield* TestClock.adjust(QUIET_MS * 3);
      yield* settle;
      expect(calls).toHaveLength(0);
      expect(events.some((e) => e.type === "diff")).toBe(false);
    }));

  it.effect("Scope を閉じると、呼び出し中の差分更新の Fiber も中断され、後から返った結果をログに書かない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const events: LogEvent[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* open(update, events);
          yield* session.push(remark("一"));
          yield* session.push(remark("二"));
          expect(calls).toHaveLength(1);
        }),
      );

      calls[0]!.reply(); // 閉じた後の返事は届かない
      yield* settle;
      expect(events.some((e) => e.type === "diff")).toBe(false);
    }));
});

describe("変わったこと（反映の履歴）", () => {
  // 反映ごとの手を順に返す偽物。UpdateFailure なら失敗する。
  const failure = (message: string): UpdateFailure => ({ _tag: "UpdateFailed", message });
  function stepped(...script: (Op[] | UpdateFailure)[]) {
    let n = 0;
    return (): Effect.Effect<DiffOutput, UpdateFailure> => {
      const s = script[n++] ?? [];
      return Array.isArray(s) ? Effect.succeed({ ops: s }) : Effect.fail(s as UpdateFailure);
    };
  }

  // 発言を 2 つ流して反映を 1 回起こす。end は呼び出し側が決める。
  const reflect = Effect.fn("reflect")(function* (session: Session, ends: [number, number]) {
    const rs = ends.map((end) => remark("発言", { end, start: end - 1 }));
    for (const r of rs) yield* session.push(r);
    yield* session.idle;
    return rs.map((r) => r.id);
  });

  it.effect("同じセッションで 反映 → 反映 → 何もしない反映 → 失敗した反映 を続けると、round が進み、記録が積み上がる", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const [a, b] = [remark("一"), remark("二")];
      const update = stepped(
        [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }],
        [{ op: "update", node: "n1", text: "中途採用", evidence: [b.id] }],
        [{ op: "noop", reason: "雑談" }],
        failure("timeout"),
        [{ op: "add", ref: "t2", parent: "n1", kind: "論点", text: "面接は何回か", evidence: [b.id] }],
      );
      const session = yield* open(update, events);

      expect(yield* session.snapshot).toMatchObject({ round: 0, changes: [] });

      // 反映 1。新しい発言の end の最大値が at になる（最後の発言の end ではない）
      yield* session.push({ ...a, start: 1, end: 50 });
      yield* session.push({ ...b, start: 2, end: 30 });
      yield* session.idle;
      expect((yield* session.snapshot).round).toBe(1);
      expect((yield* session.snapshot).changes).toEqual([{ round: 1, at: 50, change: "追加", node: "n1", kind: "議題", text: "採用" }]);

      // 反映 2
      yield* reflect(session, [60, 70]);
      expect((yield* session.snapshot).round).toBe(2);
      expect((yield* session.snapshot).changes).toEqual([
        { round: 1, at: 50, change: "追加", node: "n1", kind: "議題", text: "採用" },
        { round: 2, at: 70, change: "更新", node: "n1", kind: "議題", text: "中途採用" },
      ]);

      // 何もしない反映でも round は進む（前回の赤い枠を消すため）。記録は増えない
      yield* reflect(session, [80, 90]);
      expect((yield* session.snapshot).round).toBe(3);
      expect((yield* session.snapshot).changes).toHaveLength(2);

      // 失敗した反映では round も記録も進まない
      yield* reflect(session, [100, 110]);
      expect(events.at(-1)).toMatchObject({ type: "diff", error: expect.stringContaining("timeout") });
      expect((yield* session.snapshot).round).toBe(3);
      expect((yield* session.snapshot).changes).toHaveLength(2);

      // 失敗の後の反映は、次の round として積み上がる
      yield* reflect(session, [120, 125]);
      expect((yield* session.snapshot).round).toBe(4);
      expect((yield* session.snapshot).changes.at(-1)).toEqual({ round: 4, at: 125, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" });
      expect((yield* session.snapshot).changes).toHaveLength(3);
    }));

  it.effect("SessionLog.write が呼ばれた時点のスナップショットに、その反映の round と記録がすでに載っている（送信より先に記録する）", () =>
    Effect.gen(function* () {
      const [a, b, c, d] = [remark("一"), remark("二"), remark("三"), remark("四")];
      const update = stepped(
        [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }],
        failure("timeout"),
      );
      const seen: { failed: boolean; round: number; changes: number }[] = [];
      const holder: { session?: Session } = {}; // start の行を書く時点では、まだ Session が無い
      const log = logLayer((e) =>
        Effect.gen(function* () {
          if (e.type !== "diff" || !holder.session) return;
          const s = yield* holder.session.snapshot; // 書く側（SessionLog）の中から、いまの状態を読む
          seen.push({ failed: e.error !== undefined, round: s.round, changes: s.changes.length });
        }),
      );
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), log)));
      holder.session = session;
      for (const r of [a, b, c, d]) yield* session.push(r);
      yield* session.idle;

      expect(seen).toEqual([
        { failed: false, round: 1, changes: 1 },
        { failed: true, round: 1, changes: 1 },
      ]);
    }));

  it.effect("snapshot が返す changes は、あとから書き換えてもセッションの記録に影響しない", () =>
    Effect.gen(function* () {
      const [a, b] = [remark("一"), remark("二")];
      const update = stepped([{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }]);
      const session = yield* open(update);
      yield* session.push(a);
      yield* session.push(b);
      yield* session.idle;

      (yield* session.snapshot).changes.length = 0;
      expect((yield* session.snapshot).changes).toHaveLength(1);
    }));
});

describe("根拠の発言（snapshot の remarks）", () => {
  const add = (ref: string, text: string, evidence: string[]): Op => ({ op: "add", ref, parent: "root", kind: "議題", text, evidence });

  it.effect("ノードの根拠に挙がった発言の 時刻・トラック・本文 を、ID で引ける形で含める", () =>
    Effect.gen(function* () {
      const a = remark("採用の話をします", { track: "自分", start: 1.5, end: 9.5 });
      const b = remark("面接を何回にするか", { track: "相手", start: 10, end: 19 });
      const { session } = yield* setup([add("t1", "採用", [a.id, b.id])]);
      yield* session.push(a);
      yield* session.push(b);
      yield* session.idle;

      const snap = yield* session.snapshot;
      const node = snap.nodes.find((n) => n.text === "採用")!;
      expect(node.evidence).toEqual([a.id, b.id]);
      for (const id of node.evidence) expect(snap.remarks.filter((r) => r.id === id)).toHaveLength(1);
      expect(snap.remarks.find((r) => r.id === a.id)).toMatchObject({ track: "自分", start: 1.5, end: 9.5, text: "採用の話をします" });
      expect(snap.remarks.find((r) => r.id === b.id)).toMatchObject({ track: "相手", start: 10, end: 19, text: "面接を何回にするか" });
    }));

  it.effect("どのノードの根拠にもなっていない発言（重複の印つき・未処理）は含めず、受け取った順に並べる", () =>
    Effect.gen(function* () {
      const a = remark("一つ目");
      const echo = remark("反響", { duplicate: true });
      const b = remark("二つ目");
      const c = remark("三つ目（反映待ち）");
      const { session } = yield* setup([add("t1", "採用", [b.id, a.id])]);
      for (const r of [a, echo, b, c]) yield* session.push(r);
      yield* session.idle;

      expect((yield* session.snapshot).remarks.map((r) => r.id)).toEqual([a.id, b.id]);
    }));

  it.effect("複数のノードが同じ発言を根拠にしても、発言は 1 度だけ含める", () =>
    Effect.gen(function* () {
      const [a, b] = [remark("一"), remark("二")];
      const { session } = yield* setup([add("t1", "採用", [a.id]), add("t2", "評価", [a.id, b.id])]);
      yield* session.push(a);
      yield* session.push(b);
      yield* session.idle;

      expect((yield* session.snapshot).remarks.map((r) => r.id)).toEqual([a.id, b.id]);
    }));

  it.effect("同じセッションで update が根拠を足すと、その発言が次の snapshot から含まれる", () =>
    Effect.gen(function* () {
      const [a, b, c, d] = [remark("一"), remark("二"), remark("三"), remark("四")];
      const { session } = yield* setup([add("t1", "採用", [a.id])], [{ op: "update", node: "n1", evidence: [c.id] }]);
      yield* session.push(a);
      yield* session.push(b);
      yield* session.idle;
      expect((yield* session.snapshot).remarks.map((r) => r.id)).toEqual([a.id]);

      yield* session.push(c);
      yield* session.push(d);
      yield* session.idle;
      expect((yield* session.snapshot).remarks.map((r) => r.id)).toEqual([a.id, c.id]);
    }));

  it.effect("ルートだけのマップでは remarks は空", () =>
    Effect.gen(function* () {
      const { session } = yield* setup();
      expect((yield* session.snapshot).remarks).toEqual([]);
    }));

  it.effect("返した remarks を書き換えても、セッションの記録にも次の snapshot にも影響しない", () =>
    Effect.gen(function* () {
      const [a, b] = [remark("元の本文"), remark("二")];
      const { session } = yield* setup([add("t1", "採用", [a.id])]);
      yield* session.push(a);
      yield* session.push(b);
      yield* session.idle;

      const first = yield* session.snapshot;
      first.remarks[0]!.text = "書き換え";
      first.remarks.length = 0;
      expect((yield* session.snapshot).remarks.map((r) => r.text)).toEqual(["元の本文"]);
      expect(a.text).toBe("元の本文");
    }));
});

describe("unreflectedRemarks（反映前の発言）", () => {
  it.effect("差分更新に渡した結果待ちの発言、続けて渡していない発言の順に返す。重複の印つきは含まない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, dup, c] = [remark("ア"), remark("イ"), remark("重複", { duplicate: true }), remark("ウ")];
      const ids = Effect.map(session.unreflectedRemarks, (rs) => rs.map((r) => r.id));

      yield* session.push(a);
      yield* session.push(dup);
      expect(yield* ids).toEqual([a.id]); // まだ渡していない
      yield* session.push(b); // a・b が差分更新に渡り、結果待ちになる
      yield* session.push(c);
      expect(yield* ids).toEqual([a.id, b.id, c.id]);

      calls[0]!.reply();
      yield* session.idle; // c だけが残り、c は QUIET_MS 待ちなので、呼び出しは増えない
      expect(yield* ids).toEqual([c.id]);
    }));

  it.effect("中身のない発言は、渡す前も結果待ちの間も含まない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, filler, b, filler2] = [remark("ア"), remark("あ", { track: "自分" }), remark("イ"), remark("えー")];
      const ids = Effect.map(session.unreflectedRemarks, (rs) => rs.map((r) => r.id));

      yield* session.push(a);
      yield* session.push(filler);
      expect(yield* ids).toEqual([a.id]);
      yield* session.push(b); // a・b が結果待ちになる
      yield* session.push(filler2);
      expect(yield* ids).toEqual([a.id, b.id]);

      calls[0]!.reply();
      yield* session.idle;
      expect(yield* session.unreflectedRemarks).toEqual([]);
    }));

  it.effect("返した発言を書き換えても、セッションの記録にも次の呼び出しにも影響しない", () =>
    Effect.gen(function* () {
      const { session } = yield* setup();
      const a = remark("元の本文");
      yield* session.push(a);

      const first = yield* session.unreflectedRemarks;
      first[0]!.text = "書き換え";
      first.length = 0;

      expect((yield* session.unreflectedRemarks).map((r) => r.text)).toEqual(["元の本文"]);
      expect(a.text).toBe("元の本文");
    }));
});

describe("今の議題（currentTopic）と会議の今の時刻（now）", () => {
  const nested = (ids: string[][]): Op[] => [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: [ids[0]![1]!] },
  ];

  it.effect("議題の下のノードが変わると、その最も近い祖先の議題になる", () =>
    Effect.gen(function* () {
      const { snap, byText } = yield* play(nested);
      expect(snap.currentTopic).toBe(byText("採用")!.id);
    }));

  it.effect("議題の下の議題では、最も近い議題になる", () =>
    Effect.gen(function* () {
      const { snap, byText } = yield* play((ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "t1", kind: "議題", text: "面接", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t3", parent: "t2", kind: "論点", text: "何回か", evidence: [ids[0]![1]!] },
      ]);
      expect(snap.currentTopic).toBe(byText("面接")!.id);
    }));

  it.effect("変わったノード自身が議題なら、その議題自身になる", () =>
    Effect.gen(function* () {
      const { snap, byText } = yield* play(nested, (ids) => [
        { op: "add", ref: "t4", parent: "root", kind: "議題", text: "予算", evidence: [ids[1]![0]!] },
      ]);
      expect(snap.currentTopic).toBe(byText("予算")!.id);
    }));

  it.effect("1 回の反映で複数のノードが変わると、最後に変わったノードの議題になる", () =>
    Effect.gen(function* () {
      const { snap, byText } = yield* play((ids) => [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![0]!] },
        { op: "add", ref: "t3", parent: "t1", kind: "課題", text: "面接官が足りない", evidence: [ids[0]![1]!] },
      ]);
      expect(snap.currentTopic).toBe(byText("採用")!.id);
    }));

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

    it.effect("作成順と逆の順（n2 → n1）に更新すると、n1 が今の議題・最後に変わったノードになる", () =>
      Effect.gen(function* () {
        const { snap } = yield* play(first, (ids) => second(ids));
        expect(snap.currentTopic).toBe("n1");
        expect(snap.lastChanged).toBe("n1");
        // 変わったことの記録の並びは作成順のまま
        expect(snap.changes.filter((c) => c.round === 2).map((c) => c.node)).toEqual(["n1", "n2"]);
      }));

    it.effect("値を変えない操作や、捨てられる操作を最後に置いても、数えない", () =>
      Effect.gen(function* () {
        const unchanged = yield* play(first, (ids) => second(ids, [{ op: "update", node: "n2", evidence: [ids[0]![1]!] }]));
        expect(unchanged.snap.currentTopic).toBe("n1");
        expect(unchanged.snap.lastChanged).toBe("n1");
        const droppedOp = yield* play(first, (ids) => second(ids, [{ op: "update", node: "n2", text: "x", evidence: ["r999"] }]));
        expect(droppedOp.dropped).toHaveLength(1);
        expect(droppedOp.snap.currentTopic).toBe("n1");
        expect(droppedOp.snap.lastChanged).toBe("n1");
      }));

    it.effect("最後に値を変える操作が n2 なら、n2 になる", () =>
      Effect.gen(function* () {
        const { snap } = yield* play(first, (ids) => second(ids, [{ op: "update", node: "n2", text: "予算3", evidence: [ids[0]![1]!] }]));
        expect(snap.currentTopic).toBe("n2");
        expect(snap.lastChanged).toBe("n2");
      }));

    it.effect("変更履歴に載らない変化（案の状態だけを却下から検討中に戻す）でも、その案の議題が今の議題・最後に変わったノードになる", () =>
      Effect.gen(function* () {
        const { snap, session } = yield* play(
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
        expect((yield* session.snapshot).lastChanged).toBe("n3");
      }));

    it.effect("変わったノードが無い反映では lastChanged のキーを付けず、currentTopic は前の値のまま", () =>
      Effect.gen(function* () {
        const { snap } = yield* play(first, [{ op: "noop", reason: "変化なし" }]);
        expect("lastChanged" in snap).toBe(false);
        expect(snap.currentTopic).toBe("n2");
      }));
  });

  it.effect("後の反映で別の議題の下が変わると、今の議題が移る", () =>
    Effect.gen(function* () {
      const { snap, byText } = yield* play(
        (ids) => [
          { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
          { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!] },
        ],
        (ids) => [{ op: "add", ref: "t3", parent: "n1", kind: "課題", text: "面接官が足りない", evidence: [ids[1]![0]!] }],
      );
      expect(snap.currentTopic).toBe(byText("採用")!.id);
    }));

  it.effect("何も変わらなかった反映（noop・捨てられる操作だけ）では、前の値のまま", () =>
    Effect.gen(function* () {
      const { snap, byText } = yield* play(
        nested,
        [{ op: "noop", reason: "変化なし" }],
        [{ op: "delete", node: "n99" }],
      );
      expect(snap.round).toBe(3);
      expect(snap.currentTopic).toBe(byText("採用")!.id);
    }));

  it.effect("差分更新が失敗した反映でも、前の値のまま", () =>
    Effect.gen(function* () {
      const calls: number[] = [];
      const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> => {
        calls.push(1);
        if (calls.length === 2) return Effect.fail({ _tag: "UpdateFailed", message: "timeout" });
        return Effect.succeed({ ops: nested([[input.fresh[0]!.id, input.fresh[1]!.id]]) });
      };
      const session = yield* open(update);
      for (let i = 0; i < 2; i++) {
        yield* session.push(remark("発言"));
        yield* session.push(remark("発言"));
        yield* session.idle;
      }
      const snap = yield* session.snapshot;
      expect(snap.round).toBe(1);
      expect(snap.currentTopic).toBe("n1");
    }));

  it.effect("議題がまだ無いうちは、currentTopic のキーを付けない（議題以外だけのノードでも）", () =>
    Effect.gen(function* () {
      const empty = yield* play([{ op: "noop", reason: "まだ" }]);
      expect("currentTopic" in empty.snap).toBe(false);
      const noTopic = yield* play((ids) => [{ op: "add", ref: "t1", parent: "root", kind: "課題", text: "面接官が足りない", evidence: [ids[0]![0]!] }]);
      expect("currentTopic" in noTopic.snap).toBe(false);
    }));

  it.effect("now は最後に受け取った発言の end（重複の印つきの発言を含む）。発言が無ければキーを付けない", () =>
    Effect.gen(function* () {
      const fresh = yield* setup();
      expect("now" in (yield* fresh.session.snapshot)).toBe(false);
      const { session, snap } = yield* play(nested);
      expect(snap.now).toBe(seq * 10 + 9);
      const dup = remark("重複", { duplicate: true });
      yield* session.push(dup);
      expect((yield* session.snapshot).now).toBe(dup.end);
    }));
});
