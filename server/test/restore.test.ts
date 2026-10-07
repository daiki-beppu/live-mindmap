import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { InvalidLogEvent, makeSession, restoreSession, type DiffInput, type DiffOutput, type LogEvent, type Op, type Remark, type ScreenChange } from "../src/core/index.ts";
import { collectLog, forbiddenUpdater, settleUntil, silentLog, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

let seq = 0;
const remark = (text: string, extra: Partial<Remark> = {}): Remark => {
  seq++;
  return { id: `r${seq}`, track: "相手", start: seq * 10, end: seq * 10 + 9, text, ...extra };
};

type Step = Op[] | UpdateFailure;

// 台本どおりに差分操作を返す（UpdateFailure なら失敗する）偽物の差分更新。呼ばれた入力を記録する。
function scripted(...script: Step[]) {
  const calls: DiffInput[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> => {
    calls.push(input);
    const step = script[calls.length - 1] ?? [];
    return Array.isArray(step) ? Effect.succeed({ ops: step }) : Effect.fail(step as UpdateFailure);
  };
  return { calls, update };
}

// 差分更新が呼ばれたら記録して defect にする偽物。復元が LLM を呼ばないことの確認に使う。
function forbidden() {
  const calls: DiffInput[] = [];
  const layer = updaterLayer((input) => {
    calls.push(input);
    return Effect.die("復元で差分更新が呼ばれた");
  });
  return { calls, layer };
}

// 復元したセッションを、偽物の差分更新・何も書かないログで開く
const restore = (events: Iterable<unknown>) => restoreSession(events).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));

// ファイルに書いて読み直した形（at 付きの JSONL 1 行ぶん）にする
const viaJsonl = (events: LogEvent[]): unknown[] =>
  events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-01T00:00:0${i % 10}.000Z`, ...e })));

// すべての種類の操作・捨てられる操作・失敗・重複の印・論点の決定済み・未処理の発言を起こした元のセッション
const original = Effect.fn("original")(function* () {
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
    { _tag: "UpdateFailed", message: "timeout" }, // 差分更新の失敗
    [
      { op: "move", node: "n3", parent: "n1" },
      { op: "add", ref: "t8", parent: "root", kind: "論点", text: "予算", evidence: [id(5, 0)] },
    ],
  ];
  const { update } = scripted(...script);
  const events: LogEvent[] = [];
  const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));
  const push = Effect.fn("push")(function* (...rs: Remark[]) {
    for (const r of rs) yield* session.push(r);
    yield* session.idle;
  });
  yield* push(...p[0]!);
  yield* push(...p[1]!);
  yield* push(...p[2]!);
  yield* push(remark("予算は来週決めます", { track: "自分", duplicate: true }));
  yield* push(...p[3]!);
  yield* push(...p[4]!);
  yield* push(...p[5]!);
  const lone = remark("最後の発言"); // 2 つに満たず、まだ差分更新に渡っていない
  yield* push(lone);
  return { session, events, lone };
});

describe("ログからの復元", () => {
  it.effect("ログのイベントを順に適用して、ノードの ID を含め元のマップと一致するマップに戻す", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const restored = yield* restore(viaJsonl(events));

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      // 変わったこと（round・at・記録）もログから同じ値に戻る
      expect((yield* restored.snapshot).changes).toEqual((yield* session.snapshot).changes);
      expect((yield* restored.snapshot).round).toBe((yield* session.snapshot).round);
    }));

  it.effect("復元したスナップショットの touchedAt・evidenceRound が元と一致し、ルート以外のノードに付いている", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const restored = yield* restore(viaJsonl(events));
      const live = (yield* session.snapshot).nodes;
      const back = (yield* restored.snapshot).nodes;

      const others = live.filter((n) => n.parent !== null);
      expect(others.length).toBeGreaterThan(0);
      for (const n of others) expect(typeof n.touchedAt).toBe("number");
      expect(others.some((n) => n.evidenceRound !== undefined && n.evidenceRound > 1)).toBe(true);
      expect(back.map((n) => [n.id, n.touchedAt, n.evidenceRound])).toEqual(live.map((n) => [n.id, n.touchedAt, n.evidenceRound]));
      const root = back.find((n) => n.parent === null)!;
      expect(root).not.toHaveProperty("touchedAt");
      expect(root).not.toHaveProperty("evidenceRound");
    }));

  it.effect("復元したセッションの今の議題と今の時刻が元と一致する（議題の無い課題だけの反映は前の値のまま）", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const restored = yield* restore(viaJsonl(events));

      expect((yield* session.snapshot).currentTopic).toBe("n1");
      expect((yield* restored.snapshot).currentTopic).toBe((yield* session.snapshot).currentTopic);
      expect((yield* session.snapshot).now).toBeDefined();
      expect((yield* restored.snapshot).now).toBe((yield* session.snapshot).now);
    }));

  it.effect("作成順と逆の順に更新した反映でも、復元後の今の議題・最後に変わったノードが元と一致する", () =>
    Effect.gen(function* () {
      const [a, b, c, d] = [remark("発言"), remark("発言"), remark("発言"), remark("発言")];
      const { update } = scripted(
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
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));
      for (const r of [a!, b!]) yield* session.push(r);
      yield* session.idle;
      for (const r of [c!, d!]) yield* session.push(r);
      yield* session.idle;

      const restored = yield* restore(viaJsonl(events));
      expect((yield* session.snapshot).currentTopic).toBe("n1");
      expect((yield* restored.snapshot).currentTopic).toBe("n1");
      expect((yield* restored.snapshot).lastChanged).toBe("n1");
      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
    }));

  it.effect("元のマップにこの経路の全種類の変化が出ている（テストの前提）", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const snap = yield* session.snapshot;
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
    }));

  it.effect("復元の間は差分更新を呼ばず、イベントを SessionLog に書き直さない", () =>
    Effect.gen(function* () {
      const { events } = yield* original();
      const { calls, layer } = forbidden();
      const logged: LogEvent[] = [];
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(layer, collectLog(logged))));
      yield* restored.idle;

      expect(calls).toHaveLength(0);
      expect(logged).toEqual([]);
    }));

  it.effect("知らない種類のイベントは読み飛ばし、残りで同じマップに戻す", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
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
      const restored = yield* restore(withUnknown);

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
    }));

  // Issue #161: ヘルパーの予期せぬ終了・起動し直し・諦め・resume を記録する新しいログの種類（intake-stopped・intake-restarted・
  // intake-gave-up）があっても、復元は壊れない（order.md:74 が明示）。type が start・remark・diff のどれでもない行は decode せず
  // 読み飛ばす（前のテストの汎用の未知種類とは別の検証）
  it.effect("ヘルパーが止まった・起動し直した・諦めた・resume のログ（intake-stopped・intake-restarted・intake-gave-up）を含んでいても、復元は同じマップに戻り、それらの行はマップに反映されない", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
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
      const restored = yield* restore(withIntakeEvents);

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      // intake 系の行の内容（stderr 等）がマップへ漏れていない
      expect(JSON.stringify(yield* restored.exportJson)).not.toContain("boom");
    }));

  it.effect("復元したセッションは続きの発言を受け取り、元のセッションと同じ入力・同じマップになる", () =>
    Effect.gen(function* () {
      const { events, lone } = yield* original();
      const next = remark("続きの発言");
      const more: Op[] = [{ op: "add", ref: "t9", parent: "root", kind: "議題", text: "続き", evidence: [lone.id, next.id] }];

      const cont = scripted(more);
      const contEvents: LogEvent[] = [];
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), collectLog(contEvents))));
      yield* restored.push(next);
      yield* restored.idle;

      // 未処理だった発言は、復元後の最初の差分更新に、続きの発言と合わせて渡る
      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([lone.id, next.id]);
      // 直前の発言は、復元前に処理済みだった最後の 3 つ
      expect(cont.calls[0]!.recent).toHaveLength(3);
      expect(cont.calls[0]!.map.nodes["n3"]).toMatchObject({ text: "3 回にする", planStatus: "却下" });
      // ログに書くのは復元後の新しいイベントだけ（発言と差分）。start は書き直さない
      expect(contEvents.map((e) => e.type)).toEqual(["remark", "diff"]);
      expect((yield* restored.snapshot).nodes.find((n) => n.text === "続き")).toMatchObject({ parent: "root", evidence: [lone.id, next.id] });
    }));

  it.effect("続きの差分更新が受け取る直前の発言・マップは、元のセッションが続けた場合と同じ", () =>
    Effect.gen(function* () {
      // 元のセッションをそのまま続けた場合と、復元して続けた場合で、差分更新への入力が一致する
      const p = [remark("一"), remark("二"), remark("三"), remark("四")];
      const first: Op[] = [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [p[0]!.id] }];
      const events: LogEvent[] = [];
      const live = scripted(first, []);
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(live.update), collectLog(events))));
      yield* session.push(p[0]!);
      yield* session.push(p[1]!);
      yield* session.idle;
      yield* session.push(p[2]!); // 未処理のまま落ちる
      yield* session.idle;

      const restoredScript = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(restoredScript.update), silentLog)));
      yield* session.push(p[3]!);
      yield* restored.push(p[3]!);
      yield* session.idle;
      yield* restored.idle;

      expect(restoredScript.calls).toHaveLength(1);
      expect(restoredScript.calls[0]).toEqual(live.calls[1]);
      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
    }));

  it.effect("中身のない発言は、印の有無にかかわらず復元後の未反映にも続きの差分更新の入力にも入れない", () =>
    Effect.gen(function* () {
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
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));

      expect((yield* restored.unreflectedRemarks).map((r) => r.id)).toEqual([real.id]);
      yield* restored.push(next);
      yield* restored.idle;
      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([real.id, next.id]);
    }));

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

  it.effect("処理済みだった中身のない発言は、復元後の最初の差分更新の直前の発言に入れない", () =>
    Effect.gen(function* () {
      const { r1, events } = legacyLogWithProcessedFillers();
      const n1 = remark("担当は佐藤さんで");
      const n2 = remark("来週までに");
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(n1);
      yield* restored.push(n2);
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.recent.map((u) => u.id)).toEqual([r1.id]);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([n1.id, n2.id]);
    }));

  it.effect("中身のない発言を処理済みから除いても、復元した回数・変わったこと・マップは変わらない", () =>
    Effect.gen(function* () {
      const { r1, f2, events } = legacyLogWithProcessedFillers();
      const restored = yield* restore(viaJsonl(events));
      const snap = yield* restored.snapshot;

      expect(snap.round).toBe(2);
      expect(snap.changes).toEqual([{ change: "追加", node: "n1", kind: "議題", text: "採用", round: 2, at: f2.end }]);
      expect(snap.nodes.find((n) => n.id === "n1")).toMatchObject({ text: "採用", evidence: [r1.id] });
    }));
});

// 段 6 の互換: 今の形式の log.jsonl（at・intake-*・noContent・error つきの diff・dropped つきの diff を含む合成のログ）を、そのまま復元できる
describe("済み（close）を含むログからの復元", () => {
  // 手の n 番目が round n。1: 追加 / 2: 何もしない / 3: 閉じる（有効 2 つ・無効 3 つ）/ 4: 済みの論点の下に追加して開き直す / 5: 別の議題を閉じる
  const closedSession = Effect.fn("closedSession")(function* () {
    const p = Array.from({ length: 5 }, () => [remark("発言"), remark("発言")] as const);
    const id = (i: number, j: 0 | 1) => p[i]![j].id;
    const { update } = scripted(
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [id(0, 0)] },
        { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [id(0, 0)] },
        { op: "add", ref: "t3", parent: "root", kind: "議題", text: "予算", evidence: [id(0, 1)] },
      ],
      [{ op: "noop", reason: "雑談" }],
      [
        { op: "close", node: "n2" },
        { op: "close", node: "n1" },
        { op: "close", node: "n99" }, // 存在しない
        { op: "close", node: "n2" }, // すでに済み
        { op: "close", node: "root" }, // 議題・論点でない
      ],
      [{ op: "add", ref: "t4", parent: "n2", kind: "案", text: "3 回", evidence: [id(3, 0)] }],
      [{ op: "close", node: "n3" }],
    );
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));
    for (const pair of p) {
      for (const r of pair) yield* session.push(r);
      yield* session.idle;
    }
    return { session, events };
  });

  it.effect("閉じる・無効な閉じる・開き直しを含むログから復元したセッションが、スナップショットもエクスポートも元と一致する", () =>
    Effect.gen(function* () {
      const { session, events } = yield* closedSession();
      const live = yield* session.snapshot;
      // 前提: 済みのノードがあり、開き直しが起きており、無効な閉じるが dropped に残っている
      expect(live.nodes.filter((n) => n.talkStatus === "済み").map((n) => n.id)).toEqual(["n3"]);
      expect(live.nodes.find((n) => n.id === "n1")).not.toHaveProperty("talkStatus");
      expect(live.nodes.find((n) => n.id === "n2")).not.toHaveProperty("talkStatus");
      const dropped = events.flatMap((e) => (e.type === "diff" ? e.dropped : []));
      expect(dropped.map((d) => d.op.op)).toEqual(["close", "close", "close"]);

      const restored = yield* restore(viaJsonl(events));

      expect(yield* restored.snapshot).toEqual(live);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
    }));

  it.effect("ログに開き直しのための新しいイベントは足されない（イベントは start・remark・diff だけ）", () =>
    Effect.gen(function* () {
      const { events } = yield* closedSession();
      expect([...new Set(events.map((e) => e.type))].sort()).toEqual(["diff", "remark", "start"]);
      expect(events.filter((e) => e.type === "diff")).toHaveLength(5);
    }));
});

describe("今の形式の log.jsonl（fixtures）からの復元", () => {
  const lines = readFileSync(new URL("./fixtures/session.log.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l): unknown => JSON.parse(l));

  it("fixture は、行ごとに at を持つ今の形式で、intake-*・知らない type・noContent・error・dropped を含む（テストの前提）", () => {
    const types = lines.map((l) => (l as { type: string }).type);
    expect(new Set(types)).toEqual(new Set(["start", "remark", "diff", "intake-restarted", "intake-stopped", "future-event"]));
    expect(lines.every((l) => typeof (l as { at?: unknown }).at === "string")).toBe(true);
    expect(lines.some((l) => (l as { noContent?: boolean }).noContent === true)).toBe(true);
    expect(lines.some((l) => typeof (l as { error?: unknown }).error === "string")).toBe(true);
    expect(lines.some((l) => ((l as { dropped?: unknown[] }).dropped ?? []).length > 0)).toBe(true);
  });

  it.effect("ノード・根拠の発言・変わったこと・round・今の議題・今の時刻が、ログの内容どおりに戻る", () =>
    Effect.gen(function* () {
      const restored = yield* restore(lines);
      const snap = yield* restored.snapshot;

      expect(snap.nodes.map((n) => [n.id, n.kind, n.text])).toEqual([
        ["root", "会議", "定例"],
        ["n1", "議題", "採用"],
        ["n2", "論点", "面接は何回か"],
        ["n3", "決定", "2 回にする"],
      ]);
      expect(snap.nodes.find((n) => n.id === "n2")).toMatchObject({ pointStatus: "決定済み" });
      expect(snap.round).toBe(2); // 失敗した 3 回目の反映では進まない
      expect(snap.changes).toEqual([
        { round: 1, at: 19, change: "追加", node: "n1", kind: "議題", text: "採用" },
        { round: 1, at: 19, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" },
        { round: 2, at: 49, change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
        { round: 2, at: 49, change: "追加", node: "n3", kind: "決定", text: "2 回にする" },
      ]);
      expect(snap.remarks.map((r) => r.id)).toEqual(["r1", "r2", "r4"]); // 根拠に挙がった発言だけ
      expect(snap.currentTopic).toBe("n1");
      expect(snap.now).toBe(90); // 最後に受け取った発言（r9）の end
    }));

  it.effect("差分更新に渡さなかった発言だけが未反映に残る（重複の印つき・中身のない発言・error の回に渡した発言は含まない）", () =>
    Effect.gen(function* () {
      const restored = yield* restore(lines);
      expect((yield* restored.unreflectedRemarks).map((r) => r.id)).toEqual(["r9"]);
    }));

  it.effect("復元したセッションは、そのまま続きの発言を受け取って差分更新を呼べる", () =>
    Effect.gen(function* () {
      const cont = scripted([]);
      const restored = yield* restoreSession(lines).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(remark("続きの発言"));
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual(["r9", `r${seq}`]);
      // 直前の発言は、処理済み（error の回に渡した r7・r8 も含む）の最後の 3 つ。中身のない r3 は含まない
      expect(cont.calls[0]!.recent.map((u) => u.id)).toEqual(["r5", "r7", "r8"]);
    }));
});

describe("壊れたログは InvalidLogEvent で失敗する", () => {
  const start = { type: "start", title: "定例" };
  const r1 = { id: "r1", track: "相手", start: 0, end: 9, text: "採用の話" };
  const flip = (events: unknown[]) => restore(events).pipe(Effect.flip);

  it.effect("開始のイベントがないログは、ルートの本文を推測せず InvalidLogEvent で失敗する", () =>
    Effect.gen(function* () {
      const { events } = yield* original();
      const withoutStart = viaJsonl(events).filter((e) => (e as { type: string }).type !== "start");
      const error = yield* flip(withoutStart);
      expect(error).toBeInstanceOf(InvalidLogEvent);
      expect(error).toMatchObject({ _tag: "InvalidLogEvent" });
      expect((yield* flip([]))._tag).toBe("InvalidLogEvent");
    }));

  it.effect("diff が start より前にあるログは、その diff の位置（0 始まり）の InvalidLogEvent で失敗し、理由に start の欠落を示す", () =>
    Effect.gen(function* () {
      const diff = { type: "diff", input: { recent: [], fresh: [], nodeCount: 0 }, ops: [], dropped: [] };
      const error = yield* flip([{ type: "intake-restarted", trigger: "auto" }, diff, start]);
      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 1 });
      expect(error.reason).toContain("start がありません");
    }));

  it.effect("diff が挙げた発言がログに無ければ、その diff の位置の InvalidLogEvent で失敗し、理由に発言の ID を示す", () =>
    Effect.gen(function* () {
      const diff = { type: "diff", input: { recent: [], fresh: ["r-missing"], nodeCount: 0 }, ops: [], dropped: [] };
      const error = yield* flip([start, { type: "remark", remark: r1 }, diff]);
      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 2 });
      expect(error.reason).toContain("r-missing");
    }));

  const broken: [string, unknown[], number][] = [
    ["start の title が無い", [{ type: "start" }], 0],
    ["remark の remark が無い", [start, { type: "remark" }], 1],
    ["remark の track が知らない値", [start, { type: "remark", remark: { ...r1, track: "第三者" } }], 1],
    ["remark の本文が文字列でない", [start, { type: "remark", remark: { ...r1, text: 7 } }], 1],
    ["diff の ops が配列でない", [start, { type: "remark", remark: r1 }, { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: "なし", dropped: [] }], 2],
    ["diff の ops に知らない操作がある", [start, { type: "remark", remark: r1 }, { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [{ op: "teleport" }], dropped: [] }], 2],
    ["diff の input が無い", [start, { type: "diff", ops: [], dropped: [] }], 1],
  ];
  for (const [name, events, index] of broken) {
    it.effect(`見分けた type で項目が壊れた行（${name}）は、その行の位置の InvalidLogEvent で失敗する`, () =>
      Effect.gen(function* () {
        const error = yield* flip(events);
        expect(error).toMatchObject({ _tag: "InvalidLogEvent", index });
        expect(error.reason).not.toBe("");
      }));
  }

  it.effect("壊れた行より後ろの行は見ない（最初に壊れた行の位置を返す）", () =>
    Effect.gen(function* () {
      const error = yield* flip([start, { type: "remark" }, { type: "remark", remark: 1 }, { type: "diff" }]);
      expect(error).toMatchObject({ index: 1 });
    }));

  it.effect("type が start・remark・diff でない行は、中身が壊れていても失敗の理由にならず読み飛ばす", () =>
    Effect.gen(function* () {
      const restored = yield* restore([{ type: "intake-stopped", code: "不正" }, start, { type: "mystery", remark: 1 }, { type: 5 }, null, "文字列", { type: "remark", remark: r1 }]);
      expect((yield* restored.unreflectedRemarks).map((r) => r.id)).toEqual(["r1"]);
    }));
});

describe("開始のイベント", () => {
  it.effect("makeSession は最初のイベントとしてタイトルを持つ開始のイベントを SessionLog に書く", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(scripted().update), collectLog(events))));
      expect(events).toEqual([{ type: "start", title: "定例" }]);
    }));
});

describe("共有画面の復元（restoreSession の第 2 引数が screens/ から画像を読む）", () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);
  const shot = (start: number, id: string): ScreenChange => ({ start, image: { id, bytes: bytesOf(`bytes:${id}`) } });
  const gone = (start: number): ScreenChange => ({ start, image: null });
  // 比べるのは映り始めた時刻とバイト列だけ（復元した画像の id はファイル名で、元の id とは違う）
  const view = (list: readonly ScreenChange[] | undefined) => list?.map((s) => ({ start: s.start, bytes: s.image === null ? null : Array.from(s.image.bytes) }));
  const spoken = (id: string, end: number): Remark => ({ id, track: "相手", start: end - 1, end, text: `発言${id}` });

  type Screens = { file: string; bytes: Uint8Array }[];
  // screens/ から読む手段の偽物。読んだファイル名を記録する
  const reader = (stored: Screens) => {
    const reads: string[] = [];
    const read = (file: string): Effect.Effect<Uint8Array, { readonly _tag: "ScreenMissing"; readonly file: string }> => {
      reads.push(file);
      const found = stored.find((s) => s.file === file);
      return found ? Effect.succeed(found.bytes) : Effect.fail({ _tag: "ScreenMissing", file });
    };
    return { reads, read };
  };

  // 元のセッション: 2 回目の呼び出しは失敗。最後の呼び出しの後に、まだ添えていない変化が 3 件残る（F は最後の diff の区切りより前の時刻だが、行は diff より後）
  //   call 1 (cutoff 11): A@1, B@2 / call 2 (cutoff 21, 失敗): C@15 → 最後に添えた 2 件は B, C
  //   diff より後に受けた: F@18（区切り 21 以下）, D@100, E(なし)@120
  const original = Effect.gen(function* () {
    const events: LogEvent[] = [];
    const screens: Screens = [];
    const live = scripted([], { _tag: "UpdateFailed", message: "失敗" }, []);
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(live.update), collectLog(events, screens))));
    yield* session.pushScreen(shot(1, "A"));
    yield* session.pushScreen(shot(2, "B"));
    yield* session.push(spoken("a1", 10));
    yield* session.push(spoken("a2", 11));
    yield* session.idle;
    yield* session.pushScreen(shot(15, "C"));
    yield* session.push(spoken("a3", 20));
    yield* session.push(spoken("a4", 21));
    yield* session.idle;
    yield* session.pushScreen(shot(18, "F"));
    yield* session.pushScreen(shot(100, "D"));
    yield* session.pushScreen(gone(120));
    return { session, live, events, screens };
  });

  it.effect("続きの呼び出しに添える画面（まだ添えていなかった変化）と、送り直す 2 件が、元のセッションと一致する", () =>
    Effect.gen(function* () {
      const { session, live, events: logged, screens } = yield* original;
      const events = [...logged]; // 続きを入れる前までのログ
      const next = [spoken("a5", 200), spoken("a6", 201)];
      for (const r of next) yield* session.push(r);
      yield* session.idle;
      const expected = live.calls[2]!;
      // 元のセッションの続きで、3 件添える（F・D・E）と、2 件送り直す（B・C）ことが前提
      expect(view(expected.screens)!.map((s) => s.start)).toEqual([18, 100, 120]);
      expect(view(expected.previousScreens)!.map((s) => s.start)).toEqual([2, 15]);

      const cont = scripted([]);
      const { read } = reader(screens);
      const restored = yield* restoreSession(viaJsonl(events), read).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      for (const r of next) yield* restored.push(r);
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(view(cont.calls[0]!.screens)).toEqual(view(expected.screens));
      expect(view(cont.calls[0]!.previousScreens)).toEqual(view(expected.previousScreens));
      // 画面以外の入力も元と同じ
      expect(cont.calls[0]!.fresh).toEqual(expected.fresh);
    }));

  it.effect("読むのは、まだ添えていない変化と最後に添えた 2 件の画像だけ（「なし」と古い画面は読まない）", () =>
    Effect.gen(function* () {
      const { events, screens } = yield* original;
      const { read, reads } = reader(screens);
      yield* restoreSession(viaJsonl(events), read).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));
      expect([...reads].sort()).toEqual(["0002.0.jpg", "0015.0.jpg", "0018.0.jpg", "0100.0.jpg"]);
    }));

  it.effect("復元した後に同じ時刻の画面を受けても、前の画像を上書きしない（ファイル名は -2 から番号が付く）", () =>
    Effect.gen(function* () {
      const { events, screens } = yield* original;
      const written: Screens = [];
      const lines: LogEvent[] = [];
      const { read } = reader(screens);
      const restored = yield* restoreSession(viaJsonl(events), read).pipe(Effect.provide(Layer.merge(forbiddenUpdater, collectLog(lines, written))));
      yield* restored.pushScreen(shot(2, "again")); // B と同じ秒
      yield* restored.pushScreen(shot(18, "again2")); // 添えていない F と同じ秒
      yield* restored.pushScreen(shot(1, "old")); // 最後に添えた 2 件には入らない A と同じ秒
      expect(written.map((w) => w.file)).toEqual(["0002.0-2.jpg", "0018.0-2.jpg", "0001.0-2.jpg"]);
      expect(lines.filter((l) => l.type === "screen")).toEqual([
        { type: "screen", start: 2, image: "0002.0-2.jpg" },
        { type: "screen", start: 18, image: "0018.0-2.jpg" },
        { type: "screen", start: 1, image: "0001.0-2.jpg" },
      ]);
    }));

  // 応答待ちの間に受けた画面は、呼び出しが成功でも失敗でも、続きに添える画面として残る（選んだ時点までに受けた数が diff の行に残る）
  const duringCall: [string, ChangeKind][] = [["成功", "success"], ["失敗", "failure"]];
  type ChangeKind = "success" | "failure";
  for (const [label, kind] of duringCall) {
    for (const [imageLabel, lateImage] of [["画像あり", shot(18, "F")], ["「なし」", gone(18)]] as const) {
      it.effect(`応答待ちの間に受けた画面（${imageLabel}）は、呼び出しが${label}でも復元後の続きに残り、元のセッションと一致する`, () =>
        Effect.gen(function* () {
          const events: LogEvent[] = [];
          const screens: Screens = [];
          const gate = yield* Deferred.make<void>();
          const calls: DiffInput[] = [];
          const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> => {
            calls.push(input);
            if (calls.length > 1) return Effect.succeed({ ops: [] });
            const result: Effect.Effect<DiffOutput, UpdateFailure> = kind === "success" ? Effect.succeed({ ops: [] }) : Effect.fail({ _tag: "UpdateFailed", message: "失敗" });
            return Deferred.await(gate).pipe(Effect.andThen(result));
          };
          const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events, screens))));
          yield* session.pushScreen(shot(1, "A"));
          yield* session.pushScreen(shot(2, "B"));
          yield* session.push(spoken("a1", 10));
          yield* session.push(spoken("a2", 20));
          yield* settleUntil(() => calls.length === 1); // 1 回目が応答待ちになるまで
          expect(calls).toHaveLength(1);
          yield* session.pushScreen(lateImage);
          yield* session.pushScreen(gone(19));
          yield* Deferred.succeed(gate, undefined);
          yield* session.idle;

          const logged = [...events];
          const next = [spoken("a3", 200), spoken("a4", 201)];
          for (const r of next) yield* session.push(r);
          yield* session.idle;
          expect(calls).toHaveLength(2);
          const expected = calls[1]!;
          expect(view(expected.screens)!.map((x) => x.start)).toEqual([18, 19]);
          expect(view(expected.previousScreens)!.map((x) => x.start)).toEqual([1, 2]);

          const cont = scripted([]);
          const restored = yield* restoreSession(viaJsonl(logged), reader(screens).read).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
          for (const r of next) yield* restored.push(r);
          yield* restored.idle;
          expect(cont.calls).toHaveLength(1);
          expect(view(cont.calls[0]!.screens)).toEqual(view(expected.screens));
          expect(view(cont.calls[0]!.previousScreens)).toEqual(view(expected.previousScreens));
          expect(cont.calls[0]!.fresh).toEqual(expected.fresh);
        }));
    }
  }

  it.effect("diff の screenCount が、そこまでに読んだ screen の行の数より大きいログは、その diff の位置の InvalidLogEvent で失敗する", () =>
    Effect.gen(function* () {
      const events = [
        { type: "start", title: "定例" },
        { type: "screen", start: 1, image: null },
        { type: "remark", remark: spoken("r1", 10) },
        { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0, screenCount: 2 }, ops: [], dropped: [] },
      ];
      const error = yield* Effect.flip(restore(events));
      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 3 });
    }));

  it.effect("1 回の呼び出しで 3 件添えていたログは、その中の新しい 2 件を送り直す", () =>
    Effect.gen(function* () {
      const files = ["0001.0.jpg", "0002.0.jpg", "0004.0.jpg"];
      const stored: Screens = files.map((file) => ({ file, bytes: bytesOf(`bytes:${file}`) }));
      const events: unknown[] = [
        { type: "start", title: "定例" },
        { type: "screen", start: 1, image: files[0] },
        { type: "screen", start: 2, image: files[1] },
        { type: "screen", start: 3, image: null },
        { type: "screen", start: 4, image: files[2] },
        { type: "remark", remark: spoken("r1", 10) },
        { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0, screenCount: 4, screens: [{ start: 2, image: files[1] }, { start: 3, image: null }, { start: 4, image: files[2] }] }, ops: [], dropped: [] },
      ];
      const cont = scripted([]);
      const restored = yield* restoreSession(events, reader(stored).read).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(spoken("r2", 20));
      yield* restored.push(spoken("r3", 21));
      yield* restored.idle;
      // 区切りは 10: 映り始めが 1〜4 の変化はすべて添え済み
      expect("screens" in cont.calls[0]!).toBe(false);
      expect(view(cont.calls[0]!.previousScreens)).toEqual([{ start: 3, bytes: null }, { start: 4, bytes: Array.from(bytesOf("bytes:0004.0.jpg")) }]);
    }));

  it.effect("画像を読めなかったら、読み手の失敗でそのまま失敗する", () =>
    Effect.gen(function* () {
      const events = [{ type: "start", title: "定例" }, { type: "screen", start: 1, image: "0001.0.jpg" }];
      const error = yield* Effect.flip(restoreSession(events, reader([]).read).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog))));
      expect(error).toEqual({ _tag: "ScreenMissing", file: "0001.0.jpg" });
    }));

  it.effect("壊れた screen の行は、その行の位置の InvalidLogEvent で失敗する", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(restore([{ type: "start", title: "定例" }, { type: "screen", start: "x", image: null }]));
      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 1 });
    }));

  it.effect("共有画面の無いログは今までどおり。画像の読み手を渡さなくても復元でき、続きの入力に画面のキーは付かない", () =>
    Effect.gen(function* () {
      const p = [remark("一"), remark("二"), remark("三")];
      const events: LogEvent[] = [];
      const live = scripted([]);
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(live.update), collectLog(events))));
      yield* session.push(p[0]!);
      yield* session.push(p[1]!);
      yield* session.idle;
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(p[2]!);
      yield* restored.flush;
      expect(Object.keys(cont.calls[0]!).sort()).toEqual(["fresh", "map", "recent"]);
    }));
});
