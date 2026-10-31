import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Scope, Exit } from "effect";
import { TestClock } from "effect/testing";
import { DiffUpdater, SessionLog, makeSession, restoreState, type DiffInput, type DiffResult, type DiffUpdateError, type LogEvent, type Op, type Session, type Snapshot, type SupplementInput, type SupplementResult } from "../src/core/index.ts";

const none: SupplementResult = { op: null, category: null };
const add = (parent: string, term: string): SupplementResult => ({ op: { op: "add", parent, text: `${term}の意味`, evidence: ["r1"], origin: "会議の外" }, category: "用語", term });
const topic = (text: string): Op[] => [{ op: "add", ref: "new", parent: "root", kind: "議題", text, evidence: ["r1"] }];
const waitFor = Effect.fnUntraced(function* (condition: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) return yield* Effect.die(new Error(`${label}を待ちました`));
    yield* Effect.yieldNow;
  }
});

const setup = Effect.fnUntraced(function* (carriedTerms: readonly string[] = [], names?: DiffResult["names"]) {
  const calls: { input: SupplementInput; reply: (result: SupplementResult) => Effect.Effect<boolean>; fail: Effect.Effect<boolean> }[] = [];
  const diffs: DiffInput[] = [];
  const events: LogEvent[] = [];
  const frames: Snapshot[] = [];
  let active = 0;
  let maxActive = 0;
  let ops: Op[] = [];
  let seq = 0;
  let current: Session | undefined;
  const supplement = Effect.fnUntraced(function* (input: SupplementInput) {
    const result = yield* Deferred.make<SupplementResult, DiffUpdateError>();
    active++;
    maxActive = Math.max(active, maxActive);
    calls.push({ input, reply: (answer) => Deferred.succeed(result, answer), fail: Deferred.fail(result, { _tag: "FakeSupplementFailed", message: "補足の失敗" }) });
    return yield* Deferred.await(result).pipe(Effect.ensuring(Effect.sync(() => { active--; })));
  });
  const service = DiffUpdater.of({ update: (input) => Effect.sync(() => { diffs.push(input); return { ops, names }; }), supplement });
  const session = yield* makeSession({ title: "定例", carriedTerms }).pipe(Effect.provide(Layer.mergeAll(
    Layer.succeed(DiffUpdater, service),
    Layer.succeed(SessionLog, SessionLog.of({
      write: (event) => Effect.sync(() => { events.push(event); }),
      writeScreen: () => Effect.void, readScreen: () => Effect.die("画像は読みません"),
      reflected: (success) => Effect.gen(function* () {
        if (success && current !== undefined) frames.push(yield* current.snapshot);
      }),
    })),
  )));
  current = session;
  const step = Effect.fnUntraced(function* (next: Op[], text = "SLAと納期を検討します") {
    ops = next;
    seq++;
    yield* session.push({ id: `r${seq}`, track: "相手", speaker: "相手 A", start: seq, end: seq + 1, text });
    yield* session.idle;
    yield* TestClock.adjust(0);
  });
  const reply = Effect.fnUntraced(function* (index: number, result: SupplementResult) {
    yield* waitFor(() => calls.length > index, `補足の${index + 1}回目の呼び出し`);
    yield* calls[index]!.reply(result);
    yield* TestClock.adjust(0);
  });
  return { session, calls, diffs, events, frames, step, reply, maxActive: () => maxActive, active: () => active };
});
const lines = (events: readonly LogEvent[]) => events.filter((e) => e.type === "supplement");

describe("セッションの補足", () => {
  it.effect.each(["議題", "論点", "決定"] as const)("受理された%sの追加でだけ対象を渡す", (kind) => Effect.gen(function* () {
    const h = yield* setup();
    const ops: Op[] = kind === "決定" ? [
      { op: "add", ref: "point", parent: "root", kind: "論点", text: "水準", evidence: ["r1"] },
      { op: "add", ref: "decision", parent: "point", kind, text: "SLAを採用", evidence: ["r1"] },
    ] : [{ op: "add", ref: "target", parent: "root", kind, text: "SLA", evidence: ["r1"] }];
    yield* h.step(ops);
    yield* waitFor(() => h.calls.length === 1, "対象の問い合わせ");
    expect(h.calls[0]!.input.targets.some((t) => t.node.kind === kind)).toBe(true);
    yield* h.reply(0, none);
    yield* h.step([{ op: "update", node: "n1", evidence: ["r2"] }]);
    yield* h.step([{ op: "add", ref: "bad", parent: "missing", kind: "議題", text: "捨てる議題", evidence: ["r1"] }]);
    expect(h.calls).toHaveLength(1);
  }));

  it.effect("案の追加では呼ばず却下への遷移で呼び、同じ却下を繰り返しても呼ばない", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step([{ op: "add", ref: "plan", parent: "root", kind: "案", text: "SLAを変える", evidence: ["r1"] }]);
    expect(h.calls).toHaveLength(0);
    yield* h.step([{ op: "update", node: "n1", planStatus: "却下", evidence: ["r2"] }]);
    yield* waitFor(() => h.calls.length === 1, "却下の問い合わせ");
    expect(h.calls[0]!.input.targets.map((t) => t.node.planStatus)).toEqual(["却下"]);
    yield* h.reply(0, none);
    yield* h.step([{ op: "update", node: "n1", planStatus: "却下", evidence: ["r3"] }]);
    expect(h.calls).toHaveLength(1);
  }));

  it.effect("同じdiffで追加して却下した案も対象にする", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step([
      { op: "add", ref: "plan", parent: "root", kind: "案", text: "SLAを変える", evidence: ["r1"] },
      { op: "update", node: "plan", planStatus: "却下", evidence: ["r1"] },
    ]);
    expect(h.events.filter((e) => e.type === "diff").flatMap((e) => e.dropped)).toEqual([]);
    expect((yield* h.session.snapshot).nodes).toContainEqual(expect.objectContaining({ id: "n1", kind: "案", planStatus: "却下" }));
    yield* waitFor(() => h.calls.length === 1, "同じdiffで却下した案の問い合わせ");
    expect(h.calls[0]!.input.targets.map((t) => t.node.id)).toEqual(["n1"]);
    yield* h.reply(0, none);
    yield* h.step([{ op: "update", node: "n1", planStatus: "却下", evidence: ["r2"] }]);
    expect(h.calls).toHaveLength(1);
  }));

  it.effect("補足待ちでもdiffとidleは進み、実行中の引き金は最新1件だけ残す", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("最初"));
    yield* waitFor(() => h.calls.length === 1, "最初の補足");
    yield* h.step(topic("途中"));
    yield* h.step(topic("最新"));
    expect(h.diffs).toHaveLength(3);
    expect(h.calls).toHaveLength(1);
    yield* h.reply(0, none);
    yield* waitFor(() => h.calls.length === 2, "最新の補足");
    expect(h.calls[1]!.input.targets.map((t) => t.node.text)).toEqual(["最新"]);
    expect(h.maxActive()).toBe(1);
    yield* h.reply(1, none);
    yield* h.session.flush;
    expect(h.calls).toHaveLength(2);
  }));

  it.effect("保留した補足と次のdiffを一度に送り、diffと補足の追加に別のIDを割り当てる", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step([
      ...topic("SLA"),
      { op: "add", ref: "deadline", parent: "root", kind: "課題", text: "納期", evidence: ["r1"] },
    ]);
    const before = h.frames.length;
    yield* h.reply(0, add("n1", "SLA"));
    expect(h.frames).toHaveLength(before);
    expect(lines(h.events)).toHaveLength(0);
    yield* h.step(topic("予算"));
    expect(h.frames).toHaveLength(before + 1);
    const frame = h.frames.at(-1)!;
    const budget = frame.nodes.find((n) => n.text === "予算")!;
    const supplement = frame.nodes.find((n) => n.text === "SLAの意味")!;
    expect(budget.id).not.toBe(supplement.id);
    expect(frame.nodes.find((n) => n.id === "n2")?.text).toBe("納期");
    expect(supplement.id).not.toBe("n2");
    expect(h.events.filter((e) => e.type === "diff" || e.type === "supplement").map((e) => e.type)).toEqual(["diff", "diff", "supplement"]);
    const restored = yield* restoreState(h.events);
    expect(restored.map.order.map((id) => restored.map.nodes[id])).toEqual((yield* h.session.snapshot).nodes);
  }));

  it.effect("60秒は応答到着でなく畳んだ時刻から測り、時間経過だけでは送らない", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("最初"));
    yield* h.reply(0, add("n1", "SLA"));
    yield* TestClock.adjust(120_000);
    expect(lines(h.events)).toHaveLength(0);
    expect(h.frames).toHaveLength(1);
    yield* h.step(topic("次"));
    expect(lines(h.events)).toHaveLength(1);
    yield* h.reply(1, add("n2", "SLO"));
    yield* TestClock.adjust(59_999);
    yield* h.step([]);
    expect(lines(h.events)).toHaveLength(1);
    const count = h.frames.length;
    yield* TestClock.adjust(1);
    expect(h.frames).toHaveLength(count);
    yield* h.step([]);
    expect(lines(h.events)).toHaveLength(2);
    expect(h.frames.at(-1)!.nodes.filter((n) => n.kind === "補足")).toHaveLength(2);
  }));

  it.effect.each(["通常diff", "停止"] as const)("操作なし応答の後も保留を維持し、%sで反映する", (ending) => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("一"));
    yield* h.reply(0, add("n1", "SLA"));
    yield* h.step(topic("二"));
    yield* h.reply(1, add("n2", "SLO"));
    yield* h.step(topic("三"));
    yield* h.reply(2, none);
    yield* TestClock.adjust(59_999);
    yield* h.step([]);
    expect(lines(h.events).filter((e) => e.op !== null)).toHaveLength(1);
    expect(h.frames.at(-1)!.nodes.filter((n) => n.kind === "補足").map((n) => n.text)).toEqual(["SLAの意味"]);
    const before = h.frames.length;
    if (ending === "通常diff") {
      yield* TestClock.adjust(1);
      expect(h.frames).toHaveLength(before);
      yield* h.step([]);
    } else {
      yield* h.session.flush;
    }
    expect(h.frames).toHaveLength(before + 1);
    expect(lines(h.events)).toEqual([
      expect.objectContaining({ op: add("n1", "SLA").op }),
      expect.objectContaining({ op: add("n2", "SLO").op }),
    ]);
    expect(h.events.slice(-2).map((e) => e.type)).toEqual(["diff", "supplement"]);
    expect(h.frames.at(-1)!.nodes.filter((n) => n.kind === "補足").map((n) => n.text)).toEqual(["SLAの意味", "SLOの意味"]);
    expect((yield* h.session.snapshot).nodes).toEqual(h.frames.at(-1)!.nodes);
  }));

  it.effect("間隔内に着いた結果は最新1件に置き換え、保留語を次の問い合わせにも渡す", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("一"));
    yield* h.reply(0, add("n1", "SLA"));
    yield* h.step(topic("二"));
    yield* h.reply(1, add("n2", "SLO"));
    yield* h.step(topic("三"));
    yield* waitFor(() => h.calls.length === 3, "保留語を使う問い合わせ");
    expect(h.calls[2]!.input.explainedTerms).toEqual(expect.arrayContaining(["SLA", "SLO"]));
    yield* h.reply(2, add("n4", "KPI"));
    yield* TestClock.adjust(60_000);
    yield* h.step([]);
    const texts = (yield* h.session.snapshot).nodes.filter((n) => n.kind === "補足").map((n) => n.text);
    expect(texts).toEqual(["SLAの意味", "KPIの意味"]);
    expect(lines(h.events)).toHaveLength(2);
  }));

  it.effect("補足付き本文の言い直しで再問い合わせし、更新は60秒待ち、消去は待たない", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("SLA"));
    yield* h.reply(0, add("n1", "SLA"));
    yield* h.step([]);
    yield* h.step([{ op: "update", node: "n1", text: "合意したSLA", evidence: ["r3"] }]);
    yield* waitFor(() => h.calls.length === 2, "言い直しの問い合わせ");
    expect(h.calls[1]!.input.targets[0]!.supplement?.text).toBe("SLAの意味");
    yield* h.reply(1, { category: "用語", term: "SLA", op: { op: "update", node: "n2", text: "会議で合意した水準", evidence: ["r3"], origin: "会議の中" } });
    yield* TestClock.adjust(59_999);
    yield* h.step([]);
    expect((yield* h.session.snapshot).nodes.find((n) => n.id === "n2")?.text).toBe("SLAの意味");
    yield* TestClock.adjust(1);
    yield* h.step([]);
    expect((yield* h.session.snapshot).nodes.find((n) => n.id === "n2")?.text).toBe("会議で合意した水準");
    yield* h.step([{ op: "update", node: "n1", text: "SLAの訂正", evidence: ["r6"] }]);
    yield* h.reply(2, { op: { op: "delete", node: "n2" }, category: null });
    yield* h.step([]);
    expect((yield* h.session.snapshot).nodes.filter((n) => n.kind === "補足")).toEqual([]);
    yield* h.step(topic("別の議題"));
    yield* waitFor(() => h.calls.length === 4, "消去後の問い合わせ");
    expect(h.calls[3]!.input.explainedTerms).toContain("SLA");
  }));

  it.effect("停止では最後のdiff後に間隔内の残り1件も書く", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("最初"));
    yield* h.reply(0, add("n1", "SLA"));
    yield* h.step(topic("次"));
    yield* h.reply(1, add("n2", "SLO"));
    expect(lines(h.events)).toHaveLength(1);
    yield* h.session.flush;
    expect(h.events.at(-1)?.type).toBe("supplement");
    expect(lines(h.events)).toHaveLength(2);
    expect((yield* h.session.snapshot).nodes.filter((n) => n.kind === "補足")).toHaveLength(2);
  }));

  it.effect("補足失敗後も差分更新と次の補足を続ける", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("最初"));
    yield* waitFor(() => h.calls.length === 1, "失敗する補足");
    yield* h.calls[0]!.fail;
    yield* TestClock.adjust(0);
    yield* h.step(topic("次"));
    yield* h.reply(1, add("n2", "SLO"));
    yield* h.step([]);
    expect(h.diffs).toHaveLength(3);
    expect((yield* h.session.snapshot).nodes.some((n) => n.text === "SLOの意味")).toBe(true);
    expect(yield* h.session.diffUpdate).toEqual({ status: "running" });
  }));

  it.effect("呼び出し中に添える先が言い直された結果は反映せず、後続の補足は続ける", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.step(topic("古い議題"));
    yield* waitFor(() => h.calls.length === 1, "言い直し前の補足");
    yield* h.step([{ op: "update", node: "n1", text: "言い直した議題", evidence: ["r2"] }]);
    yield* h.reply(0, add("n1", "SLA"));
    yield* h.step([]);
    expect((yield* h.session.snapshot).nodes.filter((n) => n.kind === "補足")).toEqual([]);
    yield* h.step(topic("次"));
    yield* h.reply(1, add("n2", "SLO"));
    yield* h.step([]);
    expect((yield* h.session.snapshot).nodes.filter((n) => n.kind === "補足").map((n) => n.text)).toEqual(["SLOの意味"]);
  }));

  it.effect("対象の祖先・兄弟・発言・名前と引き継ぎ語彙を渡す", () => Effect.gen(function* () {
    const h = yield* setup(["社内SLA"]);
    yield* h.session.nameSpeaker({ label: "相手 A", name: "田中", source: "手入力" });
    yield* h.step([
      ...topic("採用"),
      { op: "add", ref: "sibling", parent: "new", kind: "課題", text: "運用費", evidence: ["r1"] },
      { op: "add", ref: "point", parent: "new", kind: "論点", text: "社内SLA", evidence: ["r1"] },
    ]);
    yield* waitFor(() => h.calls.length === 1, "文脈の問い合わせ");
    const input = h.calls[0]!.input;
    const point = input.targets.find((t) => t.node.kind === "論点")!;
    expect(point.ancestors.map((n) => n.text)).toEqual(["採用", "定例"]);
    expect(point.siblings.map((n) => n.text)).toEqual(["運用費"]);
    expect(point.evidence).toEqual([expect.objectContaining({ id: "r1", text: "SLAと納期を検討します", speakerName: "田中" })]);
    expect(input.carriedTerms).toEqual(["社内SLA"]);
    expect(input.targets.map((t) => t.node.text)).not.toContain("運用費");
  }));

  it.effect("引き金と同じdiffで受理した話者名も補足の根拠発言に渡す", () => Effect.gen(function* () {
    const h = yield* setup([], [{ label: "相手 A", name: "田中", evidence: "r1", basis: "名乗り" }]);
    yield* h.step(topic("SLA"), "田中です。SLAを決めます");
    yield* waitFor(() => h.calls.length === 1, "名乗りを使う補足");
    expect(h.calls[0]!.input.targets[0]!.evidence[0]).toMatchObject({ id: "r1", speakerName: "田中" });
  }));

  it.effect("Scope終了で実行中の補足を中断し、その後に反映しない", () => Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void));
    const h = yield* setup().pipe(Scope.provide(scope));
    yield* h.step(topic("SLA"));
    yield* waitFor(() => h.active() === 1, "実行中の補足");
    yield* Scope.close(scope, Exit.void);
    expect(h.active()).toBe(0);
    expect(lines(h.events)).toEqual([]);
  }));
});
