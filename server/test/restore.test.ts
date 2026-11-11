import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, InvalidLogEvent, makeSession, restoreSession, restoreState, type DiffInput, type DiffOutput, type LogEvent, type Op, type Remark, type ScreenChange, type Session, type SessionWriteFailed } from "../src/core/index.ts";
import { reflectSupplement, type ReflectionState } from "../src/core/reflection.ts";
import { playBatches } from "./fixtures/batches.ts";
import { remark, restore, scripted, type Step } from "./fixtures/restore.ts";
import { collectLog, forbiddenUpdater, logLayer, settleUntil, silentLog, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

function forbidden() {
  const calls: DiffInput[] = [];
  const layer = updaterLayer((input) => {
    calls.push(input);
    return Effect.die("復元で差分更新が呼ばれた");
  });
  return { calls, layer };
}

const viaJsonl = (events: LogEvent[]): unknown[] =>
  events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-01T00:00:0${i % 10}.000Z`, ...e })));

const original = Effect.fn("original")(function* () {
  const p = Array.from({ length: 6 }, () => [remark("発言"), remark("発言")] as const);
  const id = (i: number, j: 0 | 1) => p[i]![j].id;
  const script: Step[] = [
    [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [id(0, 0)] },
      { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [id(0, 0)] },
      { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: [id(0, 1)] },
      { op: "add", ref: "t4", parent: "root", kind: "課題", text: "面接官が足りない", evidence: [id(0, 1)] },
      { op: "add", ref: "t5", parent: "root", kind: "課題", text: "面接の担当が偏る", evidence: [id(0, 0)] },
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
    [{ op: "delete", node: "n99" }],
    { _tag: "UpdateFailed", message: "timeout" },
    [
      { op: "move", node: "n3", parent: "n1" },
      { op: "add", ref: "t8", parent: "root", kind: "論点", text: "予算", evidence: [id(5, 0)] },
    ],
  ];
  const duplicate = remark("予算は来週決めます", { track: "自分", duplicate: true });
  const { session, events } = yield* playBatches([p[0]!, p[1]!, p[2]!, [duplicate, ...p[3]!], p[4]!, p[5]!], script);
  const lone = remark("最後の発言");
  yield* session.push(lone);
  return { session, events, lone };
});

describe("ログからの復元", () => {
  it.effect("補足行をJSONLで往復すると、補足と消した語を含む説明済み集合が戻る", () => Effect.gen(function* () {
    const { events } = yield* original();
    const before = yield* restoreState(events);
    const parent = before.map.nodes.n3!;
    const otherParent = before.map.nodes.n4!;
    const id = `n${before.map.nextId}`;
    const rows: Extract<LogEvent, { type: "supplement" }>[] = [
      { type: "supplement", op: { op: "add", parent: parent.id, text: "消す説明", evidence: [...parent.evidence], origin: "会議の外" }, category: "用語", term: "最初の語", ms: 1, reflectedAt: 99 },
      { type: "supplement", op: { op: "delete", node: id }, category: null, ms: 1, reflectedAt: 100 },
      { type: "supplement", op: { op: "add", parent: parent.id, text: "残す説明", evidence: [...parent.evidence], origin: "会議の中" }, category: "用語", term: "次の語", ms: 2, reflectedAt: 101, usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, model: "synthetic" } },
      { type: "supplement", op: { op: "add", parent: otherParent.id, text: "別の説明", evidence: [...otherParent.evidence], origin: "会議の外" }, category: "用語", term: "別の語", ms: 1, reflectedAt: 102 },
    ];
    const start: ReflectionState = { map: before.map, explainedTerms: before.explainedTerms, history: before, ledger: { byId: new Map(before.remarks.map((r) => [r.id, r])), known: before.known, processed: before.processed } };
    const folded = rows.reduce((s, event) => reflectSupplement(s, event).state, start);
    const restored = yield* restoreState(viaJsonl([...events, ...rows]));
    expect(restored.map).toEqual(folded.map);
    expect(restored.explainedTerms).toEqual(folded.explainedTerms);
    const session = yield* restore(viaJsonl([...events, ...rows]));
    const snapshot = yield* session.snapshot;
    const ownId = `n${before.map.nextId + 1}`;
    const otherId = `n${before.map.nextId + 2}`;
    const next: ReflectionState = { map: restored.map, explainedTerms: restored.explainedTerms, history: restored, ledger: { byId: new Map(restored.remarks.map((r) => [r.id, r])), known: restored.known, processed: restored.processed } };
    const own: Extract<LogEvent, { type: "supplement" }> = { type: "supplement", op: { op: "update", node: ownId, text: "本人の言い直し", evidence: [...parent.evidence], origin: "会議の中" }, category: "用語", term: "次の語", ms: 1, reflectedAt: 103 };
    const accepted = reflectSupplement(next, own);
    expect(accepted.dropped).toEqual([]);
    expect(accepted.state.map.nodes[ownId]!.text).toBe("本人の言い直し");
    const blocked = reflectSupplement(next, { ...own, term: "最初の語", op: { op: "update", node: otherId, text: "拒否する言い直し", evidence: [...otherParent.evidence], origin: "会議の外" } });
    expect(blocked.dropped).toHaveLength(1);
    expect(blocked.state.map.nodes[otherId]!.text).toBe(snapshot.nodes.find((n) => n.id === otherId)!.text);
  }));

  it.effect("ログのイベントを順に適用して、ノードの ID を含め元のマップと一致するマップに戻す", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const restored = yield* restore(viaJsonl(events));

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      expect((yield* restored.snapshot).changes).toEqual((yield* session.snapshot).changes);
      expect((yield* restored.snapshot).round).toBe((yield* session.snapshot).round);
    }));

  it.effect("screen-off（指定・許可なし）の行を挟んだログも restoreSession で戻せ、挟まないログと同じ状態になる（壊れた行にならない）", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const withOff: LogEvent[] = [
        events[0]!,
        { type: "screen-off", start: 0, reason: "指定" },
        ...events.slice(1, 4),
        { type: "screen-off", start: 12.5, reason: "許可なし" },
        ...events.slice(4),
        { type: "screen-off", start: 99, reason: "許可なし" },
      ];
      expect(withOff.filter((e) => e.type === "screen-off")).toHaveLength(3);
      const restored = yield* restore(viaJsonl(withOff));
      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      expect(yield* restored.unreflectedRemarks).toEqual(yield* session.unreflectedRemarks);
    }));

  it.effect("発言の行の話者（相手 A・自分）は復元しても保たれ、話者を持たない古い行は話者なしのまま。speaker の行は読み飛ばす", () =>
    Effect.gen(function* () {
      const labeled = remark("ラベルつき", { speaker: "相手 A" });
      const own = remark("自分の発言", { track: "自分", speaker: "自分" });
      const old = remark("話者のない古い行");
      const rows: ReadonlyArray<{ readonly type: string; readonly [key: string]: unknown }> = [
        { type: "start", title: "定例" },
        { type: "speaker", track: "相手", start: 0, end: 1, slot: 2, final: true },
        { type: "remark", remark: labeled },
        { type: "speaker-settled", track: "相手", to: 1 },
        { type: "speaker-off", start: 5, reason: "途中で停止" },
        { type: "remark", remark: own },
        { type: "remark", remark: old },
      ];

      const restored = yield* restore(rows.map((row, i) => JSON.parse(JSON.stringify({ at: `2026-10-01T00:00:0${i}.000Z`, ...row }))));

      const back = yield* restored.unreflectedRemarks;
      expect(back).toEqual([labeled, own, old]);
      expect(back.map((r) => r.speaker)).toEqual(["相手 A", "自分", undefined]);
      expect("speaker" in back[2]!).toBe(false);
    }));

  it.effect("元のマップにこの経路の全種類の変化が出ている（テストの前提）", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const snap = yield* session.snapshot;
      const node = (id: string) => snap.nodes.find((n) => n.id === id);
      expect(snap.nodes[0]).toMatchObject({ id: "root", text: "定例" });
      expect(node("n3")).toMatchObject({ text: "3 回にする", planStatus: "却下", parent: "n1" });
      expect(node("n5")).toBeUndefined();
      expect(node("n6")).toBeUndefined();
      expect(node("n2")).toMatchObject({ pointStatus: "未決" });
      const diffs = events.flatMap((e) => (e.type === "diff" ? [e] : []));
      expect(diffs.some((d) => d.dropped.length > 0)).toBe(true);
      expect(diffs.some((d) => d.error !== undefined)).toBe(true);
      expect(snap.round).toBe(5);
      const types = new Set(snap.changes.map((c) => c.change));
      expect(types).toEqual(new Set(["追加", "更新", "決定済み化", "却下", "移動", "統合"]));
      expect(snap.changes.find((c) => c.change === "統合")).toMatchObject({ node: "n4", round: 2 });
      expect(snap.changes.find((c) => c.change === "決定済み化")).toMatchObject({ node: "n2", round: 2 });
      expect(snap.changes.find((c) => c.change === "却下")).toMatchObject({ node: "n3", round: 2 });
    }));

  it.effect("wordTimes 付きの remark の行を含むログも、wordTimes を除いたログと同じマップ・書き出しに復元される", () =>
    Effect.gen(function* () {
      const { events } = yield* original();
      const plain = viaJsonl(events);
      const withTimes = plain.map((line) => {
        const e = line as { type?: string; remark?: { text: string } };
        return e.type === "remark"
          ? { ...e, wordTimes: [{ location: 0, length: e.remark!.text.length, start: 0, end: 1 }] }
          : line;
      });
      expect(withTimes.some((line) => "wordTimes" in (line as object))).toBe(true);

      const restoredPlain = yield* restore(plain);
      const restoredTimes = yield* restore(withTimes);
      expect(yield* restoredTimes.snapshot).toEqual(yield* restoredPlain.snapshot);
      expect(yield* restoredTimes.exportJson).toEqual(yield* restoredPlain.exportJson);
      expect(JSON.stringify(yield* restoredTimes.exportJson)).not.toContain("wordTimes");
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
        { type: "future", remark: { id: "r-x", track: "相手", start: 0, end: 1, text: "x" }, ops: [{ op: "delete", node: "n1" }] },
        ...lines.slice(4),
        unknown(2),
      ];
      const restored = yield* restore(withUnknown);

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
    }));

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
      expect(JSON.stringify(yield* restored.exportJson)).not.toContain("boom");
    }));

  it.effect("tap-silent のログを含んでいても、復元は同じマップに戻る", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const lines = viaJsonl(events);
      const withTapSilent = [lines[0], { type: "tap-silent", start: 10.5 }, ...lines.slice(1, 3), { type: "tap-silent", start: 42 }, ...lines.slice(3)];
      const restored = yield* restore(withTapSilent);

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
    }));

  it.effect("self-paused / self-resumed のログを含んでいても、復元は同じマップに戻る", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const lines = viaJsonl(events);
      const withSelfPause = [
        lines[0],
        { type: "self-paused", reason: "手動", start: 10.5 },
        ...lines.slice(1, 3),
        { type: "self-resumed", reason: "手動", start: 42 },
        { type: "self-paused", reason: "自動", start: 50 },
        { type: "self-resumed", reason: "判定できない", start: 60 },
        ...lines.slice(3),
      ];
      const restored = yield* restore(withSelfPause);

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      expect(JSON.stringify(yield* restored.exportJson)).not.toContain("手動");
    }));

  it.effect("speaker・speaker-off のログを含んでいても、復元は同じマップに戻る", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const lines = viaJsonl(events);
      const withSpeaker = [
        lines[0],
        { type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true },
        ...lines.slice(1, 3),
        { type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 1, final: false },
        { type: "speaker-settled", track: "相手", to: 1.5 },
        { type: "speaker-off", start: 9, reason: "途中で停止" },
        ...lines.slice(3),
      ];
      const restored = yield* restore(withSpeaker);

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
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

      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([lone.id, next.id]);
      expect(cont.calls[0]!.recent).toHaveLength(3);
      expect(cont.calls[0]!.map.nodes["n3"]).toMatchObject({ text: "3 回にする", planStatus: "却下" });
      expect(contEvents.map((e) => e.type)).toEqual(["remark", "diff"]);
      expect((yield* restored.snapshot).nodes.find((n) => n.text === "続き")).toMatchObject({ parent: "root", evidence: [lone.id, next.id] });
    }));

  it.effect("続きの差分更新が受け取る直前の発言・マップは、元のセッションが続けた場合と同じ", () =>
    Effect.gen(function* () {
      const p = [remark("一"), remark("二"), remark("三"), remark("四")];
      const first: Op[] = [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [p[0]!.id] }];
      const { session, calls, events } = yield* playBatches([[p[0]!], [p[1]!, p[2]!, p[3]!]], [first, []]);
      const secondDiff = events.findIndex((e, i) => e.type === "diff" && events.slice(0, i).some((x) => x.type === "diff"));
      const logged = events.slice(0, secondDiff).filter((e) => !(e.type === "remark" && e.remark.id === p[3]!.id));
      expect(secondDiff).toBeGreaterThan(0);

      const restoredScript = scripted([]);
      const restored = yield* restoreSession(viaJsonl(logged)).pipe(Effect.provide(Layer.merge(updaterLayer(restoredScript.update), silentLog)));
      expect((yield* restored.unreflectedRemarks).map((r) => r.id)).toEqual([p[1]!.id, p[2]!.id]);
      yield* restored.push(p[3]!);
      yield* restored.idle;

      expect(restoredScript.calls).toHaveLength(1);
      expect(restoredScript.calls[0]!.map).toEqual(calls[1]!.map);
      expect(restoredScript.calls[0]!.recent).toEqual(calls[1]!.recent);
      expect(restoredScript.calls[0]!.fresh).toEqual(calls[1]!.fresh);
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
        { type: "remark", remark: filler },
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
    return { r1, events };
  }

  it.effect("処理済みだった中身のない発言は、復元後の最初の差分更新の直前の発言に入れない", () =>
    Effect.gen(function* () {
      const { r1, events } = legacyLogWithProcessedFillers();
      const n1 = remark("担当は佐藤さんで");
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(n1);
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.recent.map((u) => u.id)).toEqual([r1.id]);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([n1.id]);
    }));

  it.effect("diff-update-state の stopped を含むログを復元しても running で戻る", () =>
    Effect.gen(function* () {
      const restored = yield* restore(viaJsonl([
        { type: "start", title: "定例" },
        { type: "diff-update-state", state: { status: "restarting" } },
        { type: "diff-update-state", state: { status: "stopped" } },
      ]));

      expect(yield* restored.diffUpdate).toEqual({ status: "running" });
    }));
});

describe("話者の名前を含むログからの復元", () => {
  const namedSession = Effect.fnUntraced(function* () {
    const first = remark("採用を相談します", { speaker: "相手 A" });
    const second = remark("田中です", { speaker: "相手 B" });
    const live = scripted([{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [first.id] }], []);
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(live.update), collectLog(events))));
    yield* session.push(first);
    yield* session.idle;
    yield* session.nameSpeaker({ label: "相手 A", name: "佐藤", source: "手入力" });
    yield* session.push(second);
    yield* session.idle;
    yield* session.nameSpeaker({ label: "相手 B", name: "田中", source: "推定", basis: "呼びかけへの応答" });
    return { session, events, live };
  });

  it.effect("手入力と推定の名前を付けた元のセッションと、復元後のsnapshot・export・続きの名前入力が一致する", () =>
    Effect.gen(function* () {
      const { session, events, live } = yield* namedSession();
      const cont = scripted([]);
      const logged: LogEvent[] = [];
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), collectLog(logged))));
      const expected = { "相手 A": "佐藤", "相手 B": "田中" };
      expect((yield* session.exportJson).speakerNames).toEqual(expected);
      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      expect(logged).toEqual([]);
      expect(cont.calls).toEqual([]);

      const next = remark("続きの発言です", { speaker: "相手 B" });
      yield* session.push(next);
      yield* session.idle;
      yield* restored.push(next);
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(live.calls.at(-1)!.speakerNames).toEqual(new Map(Object.entries(expected)));
      expect(cont.calls[0]!.speakerNames).toEqual(live.calls.at(-1)!.speakerNames);
      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      expect(logged.map((event) => event.type)).toEqual(["remark", "diff"]);
    }));

  it.effect("名前行とdiff行の相対位置を変えても、元と同じ名前・マップ・発言に戻る", () =>
    Effect.gen(function* () {
      const { session, events } = yield* namedSession();
      const names = events.filter((event) => event.type === "speaker-name");
      const others = events.filter((event) => event.type !== "speaker-name");
      const before = yield* restore(viaJsonl([others[0]!, ...names, ...others.slice(1)]));
      const after = yield* restore(viaJsonl([...others, ...names]));
      for (const restored of [before, after]) {
        expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
        expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
        expect(yield* restored.unreflectedRemarks).toEqual(yield* session.unreflectedRemarks);
      }
    }));

  it.effect("復元後も手入力名への推定は無変更・追記なしで、推定名への名乗りは変更して同じログに1行だけ追記する", () =>
    Effect.gen(function* () {
      const { session, events } = yield* namedSession();
      const restoredLog: LogEvent[] = [];
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(forbiddenUpdater, collectLog(restoredLog))));
      expect((yield* restored.exportJson).speakerNames).toEqual({ "相手 A": "佐藤", "相手 B": "田中" });
      expect(restoredLog).toEqual([]);
      const count = events.length;
      const protectedChange = { label: "相手 A", name: "高橋", source: "推定", basis: "名乗り" } as const;
      yield* session.nameSpeaker(protectedChange);
      yield* restored.nameSpeaker(protectedChange);
      expect((yield* restored.exportJson).speakerNames).toEqual({ "相手 A": "佐藤", "相手 B": "田中" });
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      expect(events).toHaveLength(count);
      expect(restoredLog).toEqual([]);

      const rename = { label: "相手 B", name: "鈴木", source: "推定", basis: "名乗り" } as const;
      yield* session.nameSpeaker(rename);
      yield* restored.nameSpeaker(rename);
      expect((yield* restored.exportJson).speakerNames).toEqual({ "相手 A": "佐藤", "相手 B": "鈴木" });
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
      expect(restoredLog).toEqual([{ type: "speaker-name", label: "相手 B", name: "鈴木", source: "推定" }]);
      expect(events.slice(count)).toEqual(restoredLog);
    }));

  for (const source of ["手入力", "推定"] as const) {
    it.effect(`トップレベルのspeaker-nameの名前を復元する（${source}）`, () =>
      Effect.gen(function* () {
        const restored = yield* restore(viaJsonl([
          { type: "start", title: "定例" },
          { type: "speaker-name", label: "相手 A", name: "田中", source },
        ]));
        expect((yield* restored.exportJson).speakerNames).toEqual({ "相手 A": "田中" });
      }));
  }

  it.effect("名前行がないログは、本文・別typeの同名フィールド・入れ子に名前表現があっても名前表を作らない", () =>
    Effect.gen(function* () {
      const spoken = remark("speaker-name", { speaker: "相手 A" });
      const restored = yield* restore([
        { type: "start", title: "定例" },
        { type: "remark", remark: spoken },
        { type: "future", label: "相手 A", name: "田中", source: "手入力", event: { type: "speaker-name", label: "相手 A", name: "田中", source: "手入力" } },
      ]);
      expect(yield* restored.unreflectedRemarks).toEqual([spoken]);
      expect(yield* restored.exportJson).not.toHaveProperty("speakerNames");
    }));

  for (const [field, value] of [["label", 1], ["name", null], ["source", "不明"], ["source", undefined]] as const) {
    it.effect(`壊れたspeaker-nameの${field}=${String(value)}は位置つきInvalidLogEventで失敗する`, () =>
      Effect.gen(function* () {
        const error = yield* restore([
          { type: "start", title: "定例" },
          { type: "speaker-name", label: "相手 A", name: "田中", source: "手入力", [field]: value },
        ]).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidLogEvent);
        expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 1 });
        expect(error).toHaveProperty("reason", expect.stringMatching(/\S/));
      }));
  }
});

describe("済み（close）を含むログからの復元", () => {
  const closedSession = Effect.fn("closedSession")(function* () {
    const p = Array.from({ length: 5 }, () => [remark("発言"), remark("発言")] as const);
    const id = (i: number, j: 0 | 1) => p[i]![j].id;
    const { session, events } = yield* playBatches(p, [
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [id(0, 0)] },
        { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [id(0, 0)] },
        { op: "add", ref: "t3", parent: "root", kind: "議題", text: "予算", evidence: [id(0, 1)] },
      ],
      [{ op: "noop", reason: "雑談" }],
      [
        { op: "close", node: "n2" },
        { op: "close", node: "n1" },
        { op: "close", node: "n99" },
        { op: "close", node: "n2" },
        { op: "close", node: "root" },
      ],
      [{ op: "add", ref: "t4", parent: "n2", kind: "案", text: "3 回", evidence: [id(3, 0)] }],
      [{ op: "close", node: "n3" }],
    ]);
    return { session, events };
  });

  it.effect("閉じる・無効な閉じる・開き直しを含むログから復元したセッションが、スナップショットもエクスポートも元と一致する", () =>
    Effect.gen(function* () {
      const { session, events } = yield* closedSession();
      const live = yield* session.snapshot;
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
      expect(error).toHaveProperty("reason", expect.stringContaining("start がありません"));
    }));

  it.effect("diff が挙げた発言がログに無ければ、その diff の位置の InvalidLogEvent で失敗する", () =>
    Effect.gen(function* () {
      const diff = { type: "diff", input: { recent: [], fresh: ["r-missing"], nodeCount: 0 }, ops: [], dropped: [] };
      const error = yield* flip([start, { type: "remark", remark: r1 }, diff]);
      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 2, reason: "ログに発言がありません: r-missing" });
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
        expect(error).toHaveProperty("reason", expect.stringMatching(/\S/));
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

describe("共有画面の復元（復元はファイル名だけを戻し、画像は続きの呼び出しで SessionLog.readScreen が screens/ から読む）", () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);
  const shot = (start: number, id: string): ScreenChange => ({ start, image: { id, bytes: bytesOf(`bytes:${id}`) } });
  const gone = (start: number): ScreenChange => ({ start, image: null });
  const view = (list: readonly ScreenChange[] | undefined) => list?.map((s) => ({ start: s.start, bytes: s.image === null ? null : Array.from(s.image.bytes) }));
  const spoken = (id: string, end: number): Remark => ({ id, track: "相手", start: end - 1, end, text: `発言${id}` });

  type Screens = { file: string; bytes: Uint8Array }[];
  const reader = (stored: Screens, lines?: LogEvent[], written?: Screens) => {
    const reads: string[] = [];
    const log = logLayer(
      (event) => Effect.sync(() => void lines?.push(event)),
      (file, bytes) => Effect.sync(() => void written?.push({ file, bytes })),
      (file) =>
        Effect.suspend(() => {
          reads.push(file);
          const found = stored.find((s) => s.file === file);
          return found ? Effect.succeed(found.bytes) : Effect.die(`ScreenMissing: ${file}`);
        }),
    );
    return { reads, log };
  };

  const original = Effect.gen(function* () {
    const events: LogEvent[] = [];
    const screens: Screens = [];
    const live = scripted([], { _tag: "UpdateFailed", message: "失敗" }, []);
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(live.update), collectLog(events, screens))));
    yield* session.pushScreen(shot(1, "A"));
    yield* session.pushScreen(shot(2, "B"));
    yield* session.push(spoken("a1", 10));
    yield* session.idle;
    yield* session.pushScreen(shot(15, "C"));
    yield* session.push(spoken("a2", 40));
    yield* session.idle;
    yield* session.pushScreen(shot(28, "F"));
    yield* session.pushScreen(shot(100, "D"));
    yield* session.pushScreen(gone(120));
    return { session, live, events, screens };
  });

  it.effect("続きの呼び出しに添える未送画面が、元のセッションと一致する", () =>
    Effect.gen(function* () {
      const { session, live, events: logged, screens } = yield* original;
      const events = [...logged];
      const next = [spoken("a3", 200)];
      for (const r of next) yield* session.push(r);
      yield* session.idle;
      const expected = live.calls[2]!;
      expect(view(expected.screens)!.map((s) => s.start)).toEqual([28, 100, 120]);

      const cont = scripted([]);
      const { log } = reader(screens);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), log)));
      for (const r of next) yield* restored.push(r);
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(view(cont.calls[0]!.screens)).toEqual(view(expected.screens));
      expect(cont.calls[0]!.fresh).toEqual(expected.fresh);
    }));

  it.effect("復元では画像を読まず、続きでは新しく添える未送画面だけを読む", () =>
    Effect.gen(function* () {
      const { events, screens } = yield* original;
      const { log, reads } = reader(screens);
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), log)));
      expect(reads).toEqual([]);
      yield* restored.push(spoken("a3", 200));
      yield* restored.idle;
      expect([...reads].sort()).toEqual(["0028.0.jpg", "0100.0.jpg"]);
    }));

  it.effect("復元した後に同じ時刻の画面を受けても、前の画像を上書きしない（ファイル名は -2 から番号が付く）", () =>
    Effect.gen(function* () {
      const { events, screens } = yield* original;
      const written: Screens = [];
      const lines: LogEvent[] = [];
      const { log } = reader(screens, lines, written);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(forbiddenUpdater, log)));
      yield* restored.pushScreen(shot(2, "again"));
      yield* restored.pushScreen(shot(28, "again2"));
      yield* restored.pushScreen(shot(1, "old"));
      yield* restored.pushScreen(shot(3, "new-time"));
      expect(written.map((w) => w.file)).toEqual(["0002.0-2.jpg", "0028.0-2.jpg", "0001.0-2.jpg", "0003.0.jpg"]);
      expect(lines.filter((l) => l.type === "screen")).toEqual([
        { type: "screen", start: 2, image: "0002.0-2.jpg" },
        { type: "screen", start: 28, image: "0028.0-2.jpg" },
        { type: "screen", start: 1, image: "0001.0-2.jpg" },
        { type: "screen", start: 3, image: "0003.0.jpg" },
      ]);
    }));

  it.effect("応答待ちの間に受けた画像は、成功した呼び出しの復元後の続きに残り、元のセッションと一致する", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const screens: Screens = [];
      const gate = yield* Deferred.make<void>();
      const calls: DiffInput[] = [];
      const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> => {
        calls.push(input);
        if (calls.length > 1) return Effect.succeed({ ops: [] });
        return Deferred.await(gate).pipe(Effect.as({ ops: [] }));
      };
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events, screens))));
      yield* session.pushScreen(shot(1, "A"));
      yield* session.pushScreen(shot(12, "B"));
      yield* session.push(spoken("a1", 25));
      yield* settleUntil(() => calls.length === 1);
      expect(calls).toHaveLength(1);
      yield* session.pushScreen(shot(23, "F"));
      yield* session.pushScreen(gone(24));
      yield* Deferred.succeed(gate, undefined);
      yield* session.idle;

      const logged = [...events];
      const next = [spoken("a2", 200)];
      for (const r of next) yield* session.push(r);
      yield* session.idle;
      expect(calls).toHaveLength(2);
      const expected = calls[1]!;
      expect(view(expected.screens)!.map((x) => x.start)).toEqual([23, 24]);

      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(logged)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), reader(screens).log)));
      for (const r of next) yield* restored.push(r);
      yield* restored.idle;
      expect(cont.calls).toHaveLength(1);
      expect(view(cont.calls[0]!.screens)).toEqual(view(expected.screens));
      expect(cont.calls[0]!.fresh).toEqual(expected.fresh);
    }));

  describe("画像設定と一時停止からの復元", () => {
    const startsOfCall = (c: DiffInput) => view(c.screens)?.map((x) => x.start);

    it.effect("画像を添えない会議は復元した後に新しい画面を受けても、元の続きと同じく画像を添えない", () =>
      Effect.gen(function* () {
        const events: LogEvent[] = [];
        const screens: Screens = [];
        const live = scripted([], [], []);
        const session = yield* makeSession({ title: "定例", images: false }).pipe(Effect.provide(Layer.merge(updaterLayer(live.update), collectLog(events, screens))));
        yield* session.pushScreen(shot(1, "X"));
        yield* session.push(spoken("p1", 9));
        yield* session.idle;
        const cont = scripted([], []);
        const restoredScreens = [...screens];
        const { log, reads } = reader(restoredScreens, undefined, restoredScreens);
        const restored = yield* restoreSession(viaJsonl([...events])).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), log)));
        for (const s of [session, restored]) {
          yield* s.pushScreen(shot(20, "new"));
          yield* s.push(spoken("n1", 30));
          yield* s.idle;
          yield* s.push(spoken("n2", 50));
          yield* s.idle;
        }
        const liveCalls = live.calls.slice(1);
        expect(liveCalls).toHaveLength(2);
        expect(cont.calls).toHaveLength(2);
        expect(liveCalls.map(startsOfCall)).toEqual([undefined, undefined]);
        expect(cont.calls.map(startsOfCall)).toEqual(liveCalls.map(startsOfCall));
        expect(cont.calls.map((c) => c.fresh)).toEqual(liveCalls.map((c) => c.fresh));
        expect(restoredScreens.map((s) => s.file)).toEqual(["0001.0.jpg", "0020.0.jpg"]);
        expect(reads).toEqual([]);
      }));

    const waitFor = Effect.fnUntraced(function* (condition: () => boolean, message: string) {
      const deadline = Date.now() + 5_000;
      while (!condition()) {
        if (Date.now() >= deadline) return yield* Effect.die(`待機期限: ${message}`);
        yield* Effect.yieldNow;
      }
    });
    const comparePaused = (prepare: (s: Session) => Effect.Effect<void, SessionWriteFailed>, pausedEnd: number, during: readonly ScreenChange[], next: readonly number[], whilePaused: readonly ScreenChange[] = []) =>
      Effect.gen(function* () {
        const events: LogEvent[] = [];
        const screens: Screens = [];
        const gate = yield* Deferred.make<void>();
        const calls: DiffInput[] = [];
        let pausedCall = Number.POSITIVE_INFINITY;
        const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> => {
          calls.push(input);
          if (calls.length !== pausedCall) return Effect.succeed({ ops: [] });
          return Deferred.await(gate).pipe(Effect.andThen(Effect.fail(new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "上限" }))));
        };
        const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events, screens))));
        yield* prepare(session);
        pausedCall = calls.length + 1;
        yield* session.push(spoken("pz", pausedEnd));
        yield* waitFor(() => calls.length === pausedCall, "一時停止する更新の開始");
        for (const change of during) yield* session.pushScreen(change);
        yield* Deferred.succeed(gate, undefined);
        yield* session.idle;
        expect(events.at(-1)).toMatchObject({ type: "diff-update-paused" });
        for (const change of whilePaused) yield* session.pushScreen(change);
        const logged = [...events];
        const before = calls.length;
        const cont = scripted([]);
        const restored = yield* restoreSession(viaJsonl(logged)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), reader(screens).log)));
        yield* session.push(spoken("n0", next[0]!));
        yield* restored.push(spoken("n0", next[0]!));
        yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
        yield* waitFor(() => calls.length === before + 1 && cont.calls.length === 1, "元と復元したセッションの再試行");
        yield* session.idle;
        yield* restored.idle;
        for (const [i, end] of next.slice(1).entries()) {
          yield* session.push(spoken(`n${i + 1}`, end));
          yield* session.idle;
          yield* restored.push(spoken(`n${i + 1}`, end));
          yield* restored.idle;
        }
        return { liveCalls: calls.slice(before), restoredCalls: cont.calls };
      });



    it.effect("一時停止のログから復元しても停止中にたまった4件以上の画面を最初の回に全部添える", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* comparePaused(
          () => Effect.void, 1, [], [100],
          [shot(10, "A"), shot(50, "E"), shot(20, "B"), shot(30, "C"), shot(40, "D")],
        );
        expect(liveCalls).toHaveLength(1);
        expect(restoredCalls).toHaveLength(1);
        expect(liveCalls.map(startsOfCall)).toEqual([[10, 20, 30, 40, 50]]);
        expect(restoredCalls.map((c) => view(c.screens))).toEqual(liveCalls.map((c) => view(c.screens)));
        expect(restoredCalls.map((c) => c.fresh)).toEqual(liveCalls.map((c) => c.fresh));
      }));

    it.effect("一時停止した回の応答待ちの間に受けた画面は、選ぶ前に戻した後も失われず、復元と元のセッションの続きは一致する", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* comparePaused(
          (s) =>
            Effect.gen(function* () {
              yield* s.pushScreen(shot(0, "X"));
              yield* s.push(spoken("p1", 1));
              yield* s.idle;
              yield* s.pushScreen(shot(8, "Z"));
              yield* s.push(spoken("p2", 9));
              yield* s.idle;
            }),
          10, [shot(25, "W")], [11, 30],
        );
        expect(liveCalls.map(startsOfCall)).toEqual([[8], [25]]);
        expect(restoredCalls.map(startsOfCall)).toEqual([[8], [25]]);
      }));
  });

  it.effect("diff の screenCount が、そこまでに読んだ screen の行の数より大きいログは、その diff の位置の InvalidLogEvent で失敗する", () =>
    Effect.gen(function* () {
      const events = [
        { type: "start", title: "定例" },
        { type: "screen", start: 1, image: null },
        { type: "remark", remark: spoken("r1", 10) },
        { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0, screenCount: 2 }, ops: [], dropped: [] },
      ];
      const error = yield* Effect.flip(restore(events));
      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 3,
        reason: "diff の screenCount 2 が、ここまでの screen の行の数 1 より大きい" });
    }));

  it.effect("画像を読めなくても復元はでき、続きの呼び出しは差分更新を呼ばずに失敗として diff の行に残る", () =>
    Effect.gen(function* () {
      const events = [{ type: "start", title: "定例" }, { type: "screen", start: 1, image: "0001.0.jpg" }];
      const lines: LogEvent[] = [];
      const cont = scripted([]);
      const restored = yield* restoreSession(events).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), reader([], lines).log)));
      yield* restored.push(spoken("r1", 10));
      yield* restored.flush;
      expect(cont.calls).toHaveLength(0);
      const diff = lines.find((l) => l.type === "diff");
      expect(diff).toMatchObject({ type: "diff", input: { fresh: ["r1"], screens: [{ start: 1, image: "0001.0.jpg" }], screenCount: 1 }, ops: [] });
      expect(diff && "error" in diff ? diff.error : undefined).toContain("0001.0.jpg");
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

describe("復元して続けた差分更新の入力: 前回の応答", () => {
  const continued = (events: LogEvent[], next: Remark) =>
    Effect.gen(function* () {
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(next);
      yield* restored.idle;
      return cont.calls;
    });

  it.effect("復元した続きの入力には前回の応答が載らない", () =>
    Effect.gen(function* () {
      const p = [remark("一"), remark("二"), remark("三")];
      const dropOp: Op = { op: "add", ref: "u9", parent: "n99", kind: "課題", text: "親が無い", evidence: [p[0]!.id] };
      const first: Op[] = [{ op: "add", ref: "u1", parent: "root", kind: "議題", text: "採用", evidence: [p[0]!.id] }, dropOp];
      const { calls, events } = yield* playBatches([[p[0]!], [p[1]!, p[2]!]], [first, []]);
      const secondDiff = events.findIndex((e, i) => e.type === "diff" && events.slice(0, i).some((x) => x.type === "diff"));
      const logged = events.slice(0, secondDiff).filter((e) => !(e.type === "remark" && e.remark.id === p[2]!.id));

      expect(calls).toHaveLength(2);
      expect(calls[1]!.previousResponse).toEqual({ refs: { u1: "n1" }, dropped: [{ op: dropOp, reason: "親が存在しない" }] });
      const got = yield* continued(logged, p[2]!);
      expect(got).toHaveLength(1);
      expect(got[0]!.map).toEqual(calls[1]!.map);
      expect(got[0]!.recent).toEqual([p[0]!]);
      expect(got[0]!.fresh).toEqual([p[1]!, p[2]!]);
      expect(got[0]).not.toHaveProperty("previousResponse");
    }));
});
