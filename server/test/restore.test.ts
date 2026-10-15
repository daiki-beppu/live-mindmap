import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, InvalidLogEvent, makeSession, restoreSession, type DiffInput, type DiffOutput, type LogEvent, type Op, type Remark, type ScreenChange, type Session } from "../src/core/index.ts";
import { playBatches } from "./fixtures/batches.ts";
import { remark, restore, scripted, type Step } from "./fixtures/restore.ts";
import { collectLog, forbiddenUpdater, logLayer, settleUntil, silentLog, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

// 差分更新が呼ばれたら記録して defect にする偽物。復元が LLM を呼ばないことの確認に使う。
function forbidden() {
  const calls: DiffInput[] = [];
  const layer = updaterLayer((input) => {
    calls.push(input);
    return Effect.die("復元で差分更新が呼ばれた");
  });
  return { calls, layer };
}

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
  // 1 回の呼び出しに 2 件を渡すため、組ごとに前の呼び出し中に届かせる。重複の印つきの発言は差分更新に渡らない
  const duplicate = remark("予算は来週決めます", { track: "自分", duplicate: true });
  const { session, events } = yield* playBatches([p[0]!, p[1]!, p[2]!, [duplicate, ...p[3]!], p[4]!, p[5]!], script);
  // 最後の発言は、差分更新に渡った（返事を待っている）が、まだ反映されていない。台本が尽きているので、この呼び出しは返らない
  const lone = remark("最後の発言");
  yield* session.push(lone);
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

  // Issue #1021: log.jsonl の発言の行に決まった話者が残る。復元でも話者を保ち、話者を持たない古い行は話者なしとして戻す
  it.effect("発言の行の話者（相手 A・自分）は復元しても保たれ、話者を持たない古い行は話者なしのまま。speaker の行は読み飛ばす", () =>
    Effect.gen(function* () {
      const labeled = remark("ラベルつき", { speaker: "相手 A" });
      const own = remark("自分の発言", { track: "自分", speaker: "自分" });
      const old = remark("話者のない古い行");
      // speaker の行は SessionSink が書く行（LogEvent ではない）。ファイルから読み直した形にして渡す
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
      const { session, events } = yield* playBatches([[a!, b!], [c!, d!]], [
        [
          { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a!.id] },
          { op: "add", ref: "t2", parent: "root", kind: "議題", text: "予算", evidence: [b!.id] },
        ],
        [
          { op: "update", node: "n2", text: "予算2", evidence: [c!.id] },
          { op: "update", node: "n1", text: "採用2", evidence: [d!.id] },
        ],
      ]);

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

  // Issue #1019: wordTimes（語ごとの区間）を持つ remark の行を含む新しいログも、持たない古い行と同じように復元できる
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

  // Issue #863: 相手の音声が届かないときに残る tap-silent の行があっても、復元は同じマップに戻る
  it.effect("tap-silent のログを含んでいても、復元は同じマップに戻る", () =>
    Effect.gen(function* () {
      const { session, events } = yield* original();
      const lines = viaJsonl(events);
      const withTapSilent = [lines[0], { type: "tap-silent", start: 10.5 }, ...lines.slice(1, 3), { type: "tap-silent", start: 42 }, ...lines.slice(3)];
      const restored = yield* restore(withTapSilent);

      expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* session.exportJson);
    }));

  // Issue #1069: 自分の休止のログ（self-paused / self-resumed）があっても、復元は同じマップに戻る
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

  // Issue #1020: 話者の区間の生の記録（speaker・speaker-off）があっても、復元は同じマップに戻る
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
      // 元のセッション: 1 回目の呼び出し中に p[1]〜p[3] が届き、2 回目の呼び出しに 3 件まとめて渡る
      const { session, calls, events } = yield* playBatches([[p[0]!], [p[1]!, p[2]!, p[3]!]], [first, []]);
      // 復元するのは、1 回目の反映まで書いて落ちた時点のログ。p[1]・p[2] は未処理のまま、p[3] はまだ届いていない
      const secondDiff = events.findIndex((e, i) => e.type === "diff" && events.slice(0, i).some((x) => x.type === "diff"));
      const logged = events.slice(0, secondDiff).filter((e) => !(e.type === "remark" && e.remark.id === p[3]!.id));
      expect(secondDiff).toBeGreaterThan(0);

      const restoredScript = scripted([]);
      const restored = yield* restoreSession(viaJsonl(logged)).pipe(Effect.provide(Layer.merge(updaterLayer(restoredScript.update), silentLog)));
      expect((yield* restored.unreflectedRemarks).map((r) => r.id)).toEqual([p[1]!.id, p[2]!.id]);
      yield* restored.push(p[3]!);
      yield* restored.idle;

      expect(restoredScript.calls).toHaveLength(1);
      expect(restoredScript.calls[0]).toEqual(calls[1]);
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
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(n1);
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.recent.map((u) => u.id)).toEqual([r1.id]);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual([n1.id]);
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
        { op: "close", node: "n99" }, // 存在しない
        { op: "close", node: "n2" }, // すでに済み
        { op: "close", node: "root" }, // 議題・論点でない
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

describe("共有画面の復元（復元はファイル名だけを戻し、画像は続きの呼び出しで SessionLog.readScreen が screens/ から読む）", () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);
  const shot = (start: number, id: string): ScreenChange => ({ start, image: { id, bytes: bytesOf(`bytes:${id}`) } });
  const gone = (start: number): ScreenChange => ({ start, image: null });
  // 比べるのは映り始めた時刻とバイト列だけ（復元した画像の id はファイル名で、元の id とは違う）
  const view = (list: readonly ScreenChange[] | undefined) => list?.map((s) => ({ start: s.start, bytes: s.image === null ? null : Array.from(s.image.bytes) }));
  const spoken = (id: string, end: number): Remark => ({ id, track: "相手", start: end - 1, end, text: `発言${id}` });

  type Screens = { file: string; bytes: Uint8Array }[];
  // screens/ から読む SessionLog の偽物。読んだファイル名を記録する。無いファイルは defect（読み戻しの失敗）。
  // lines・written を渡すと、書いた行と画像もためる
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

  // 元のセッション: 2 回目の呼び出しは失敗。最後の呼び出しの後に、まだ添えていない変化が 3 件残る（F は最後の diff の区切りより前の時刻だが、行は diff より後）
  // 発言 1 件ごとに 1 回呼ぶ。
  //   call 1 (cutoff 10): A@1 を添え、B@2 は 10 秒未満なので持ち越す / call 2 (cutoff 40, 失敗): 持ち越した B と C@15 → 最後に添えた 2 件は B, C
  //   diff より後に受けた: F@28（区切り 40 以下）, D@100, E(なし)@120
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

  it.effect("続きの呼び出しに添える画面（まだ添えていなかった変化）と、送り直す 2 件が、元のセッションと一致する", () =>
    Effect.gen(function* () {
      const { session, live, events: logged, screens } = yield* original;
      const events = [...logged]; // 続きを入れる前までのログ
      const next = [spoken("a3", 200)];
      for (const r of next) yield* session.push(r);
      yield* session.idle;
      const expected = live.calls[2]!;
      // 元のセッションの続きで、3 件添える（F・D・E）と、2 件送り直す（B・C）ことが前提
      expect(view(expected.screens)!.map((s) => s.start)).toEqual([28, 100, 120]);
      expect(view(expected.previousScreens)!.map((s) => s.start)).toEqual([2, 15]);

      const cont = scripted([]);
      const { log } = reader(screens);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), log)));
      for (const r of next) yield* restored.push(r);
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(view(cont.calls[0]!.screens)).toEqual(view(expected.screens));
      expect(view(cont.calls[0]!.previousScreens)).toEqual(view(expected.previousScreens));
      // 画面以外の入力も元と同じ
      expect(cont.calls[0]!.fresh).toEqual(expected.fresh);
    }));

  it.effect("復元では画像を読まない。続きの呼び出しで読むのは、添える変化と送り直す 2 件の画像だけ（「なし」と古い画面は読まない）", () =>
    Effect.gen(function* () {
      const { events, screens } = yield* original;
      const { log, reads } = reader(screens);
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), log)));
      expect(reads).toEqual([]);
      yield* restored.push(spoken("a3", 200));
      yield* restored.idle;
      expect([...reads].sort()).toEqual(["0002.0.jpg", "0015.0.jpg", "0028.0.jpg", "0100.0.jpg"]);
    }));

  it.effect("復元した後に同じ時刻の画面を受けても、前の画像を上書きしない（ファイル名は -2 から番号が付く）", () =>
    Effect.gen(function* () {
      const { events, screens } = yield* original;
      const written: Screens = [];
      const lines: LogEvent[] = [];
      const { log } = reader(screens, lines, written);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(forbiddenUpdater, log)));
      yield* restored.pushScreen(shot(2, "again")); // B と同じ秒
      yield* restored.pushScreen(shot(28, "again2")); // 添えていない F と同じ秒
      yield* restored.pushScreen(shot(1, "old")); // 最後に添えた 2 件には入らない A と同じ秒
      expect(written.map((w) => w.file)).toEqual(["0002.0-2.jpg", "0028.0-2.jpg", "0001.0-2.jpg"]);
      expect(lines.filter((l) => l.type === "screen")).toEqual([
        { type: "screen", start: 2, image: "0002.0-2.jpg" },
        { type: "screen", start: 28, image: "0028.0-2.jpg" },
        { type: "screen", start: 1, image: "0001.0-2.jpg" },
      ]);
    }));

  // 応答待ちの間に受けた画面は、呼び出しが成功でも失敗でも、続きに添える画面として残る（選んだ時点までに受けた数が diff の行に残る）
  const duringCall: [string, ChangeKind][] = [["成功", "success"], ["失敗", "failure"]];
  type ChangeKind = "success" | "failure";
  for (const [label, kind] of duringCall) {
    for (const [imageLabel, lateImage] of [["画像あり", shot(23, "F")], ["「なし」", gone(23)]] as const) {
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
          yield* session.pushScreen(shot(12, "B"));
          yield* session.push(spoken("a1", 25));
          yield* settleUntil(() => calls.length === 1); // 1 回目が応答待ちになるまで
          expect(calls).toHaveLength(1);
          yield* session.pushScreen(lateImage);
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
          expect(view(expected.previousScreens)!.map((x) => x.start)).toEqual([1, 12]);

          const cont = scripted([]);
          const restored = yield* restoreSession(viaJsonl(logged)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), reader(screens).log)));
          for (const r of next) yield* restored.push(r);
          yield* restored.idle;
          expect(cont.calls).toHaveLength(1);
          expect(view(cont.calls[0]!.screens)).toEqual(view(expected.screens));
          expect(view(cont.calls[0]!.previousScreens)).toEqual(view(expected.previousScreens));
          expect(cont.calls[0]!.fresh).toEqual(expected.fresh);
        }));
    }
  }

  // 持ち越し（Issue #927）: ログに残るのは添えた画面（diff の screens）だけ。持ち越しの変化と 10 秒の起点は、ログから同じに求め直せること
  describe("持ち越しと 10 秒の起点の復元", () => {
    // 同じ入力列を、元のセッションと、途中のログから復元したセッションの両方へ流して、続きの呼び出しに添える画面を比べる
    const compare = (prepare: (s: Session) => Effect.Effect<void>, next: readonly number[], images = true) =>
      Effect.gen(function* () {
        const events: LogEvent[] = [];
        const screens: Screens = [];
        const live = scripted([]);
        const session = yield* makeSession({ title: "定例", images }).pipe(Effect.provide(Layer.merge(updaterLayer(live.update), collectLog(events, screens))));
        yield* prepare(session);
        const logged = [...events];
        const before = live.calls.length;
        const cont = scripted([]);
        const restored = yield* restoreSession(viaJsonl(logged)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), reader(screens).log)));
        for (const [i, end] of next.entries()) {
          yield* session.push(spoken(`n${i}`, end));
          yield* session.idle;
          yield* restored.push(spoken(`n${i}`, end));
          yield* restored.idle;
        }
        return { liveCalls: live.calls.slice(before), restoredCalls: cont.calls };
      });
    const startsOfCall = (c: DiffInput) => view(c.screens)?.map((x) => x.start);
    const previousOfCall = (c: DiffInput) => view(c.previousScreens)?.map((x) => x.start);

    it.effect("持ち越している変化は、復元した後も、10 秒が過ぎるまで添えず、過ぎたら添える（復元しなかった場合と同じ）", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* compare(
          (s) =>
            Effect.gen(function* () {
              yield* s.pushScreen(shot(0, "X"));
              yield* s.push(spoken("p1", 1));
              yield* s.idle;
              yield* s.pushScreen(shot(4, "Y"));
              yield* s.pushScreen(shot(8, "Z"));
              yield* s.push(spoken("p2", 9));
              yield* s.idle;
            }),
          [9.5, 10, 20],
        );
        // 前提: 元のセッションは Z を 10 秒が過ぎた呼び出しで 1 度だけ添える
        expect(liveCalls.map(startsOfCall)).toEqual([undefined, [8], undefined]);
        expect(restoredCalls.map(startsOfCall)).toEqual(liveCalls.map(startsOfCall));
        expect(restoredCalls.map(previousOfCall)).toEqual(liveCalls.map(previousOfCall));
        expect(liveCalls.map((c) => view(c.screens))).toEqual(restoredCalls.map((c) => view(c.screens)));
      }));

    it.effect("10 秒の起点は、送り直す 2 件（最後に添えた画面）から画像が押し出されても、復元後に失われない", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* compare(
          (s) =>
            Effect.gen(function* () {
              yield* s.pushScreen(shot(0, "X"));
              yield* s.push(spoken("p1", 1));
              yield* s.idle;
              for (const [i, t] of [2, 3, 4].entries()) {
                yield* s.pushScreen(gone(t));
                yield* s.push(spoken(`q${i}`, t + 0.5));
                yield* s.idle;
              }
              yield* s.pushScreen(shot(8, "Z")); // X から 10 秒未満。最後に添えた 2 件は「なし」だけ
            }),
          [9, 10],
        );
        expect(liveCalls.map(startsOfCall)).toEqual([undefined, [8]]);
        expect(restoredCalls.map(startsOfCall)).toEqual(liveCalls.map(startsOfCall));
      }));

    it.effect("共有の終了を添えたあとでも、10 秒の起点は最後に添えた画像のまま復元される", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* compare(
          (s) =>
            Effect.gen(function* () {
              yield* s.pushScreen(shot(0, "X"));
              yield* s.push(spoken("p1", 1));
              yield* s.idle;
              yield* s.pushScreen(gone(5));
              yield* s.push(spoken("p2", 6));
              yield* s.idle;
              yield* s.pushScreen(shot(12, "W"));
            }),
          [13],
        );
        expect(liveCalls.map(startsOfCall)).toEqual([[12]]);
        expect(restoredCalls.map(startsOfCall)).toEqual([[12]]);
      }));

    it.effect("画像を添えない会議（screen-input-skipped）で捨てた最新の画像は、復元しても持ち越しにならない", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* compare(
          (s) =>
            Effect.gen(function* () {
              yield* s.pushScreen(shot(1, "X"));
              yield* s.push(spoken("p1", 9));
              yield* s.idle;
            }),
          [30],
          false,
        );
        expect(liveCalls.map(startsOfCall)).toEqual([undefined]);
        expect(restoredCalls.map(startsOfCall)).toEqual([undefined]);
      }));

    it.effect("途中の変化は復元後も添えない（持ち越した 1 件だけが残る）", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* compare(
          (s) =>
            Effect.gen(function* () {
              yield* s.pushScreen(shot(0, "X"));
              yield* s.push(spoken("p1", 1));
              yield* s.idle;
              yield* s.pushScreen(shot(3, "Y"));
              yield* s.pushScreen(shot(6, "Z"));
              yield* s.push(spoken("p2", 7));
              yield* s.idle;
            }),
          [30, 40],
        );
        expect(liveCalls.map(startsOfCall)).toEqual([[6], undefined]);
        expect(restoredCalls.map(startsOfCall)).toEqual([[6], undefined]);
      }));

    // 一時停止の回は diff の行を書かない。復元は選ぶ前の画面の状態から続けるので、ライブも選ぶ前に戻って再試行する
    // paused の回（paused 番目の呼び出し）を Deferred で止め、その間に during を受けてから一時停止させる。
    // 続きの発言を元のセッション（時計を進めて再試行）と復元したセッションの両方へ流して、添える画面を比べる
    const comparePaused = (prepare: (s: Session) => Effect.Effect<void>, pausedEnd: number, during: readonly ScreenChange[], next: readonly number[]) =>
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
        yield* settleUntil(() => calls.length === pausedCall);
        for (const change of during) yield* session.pushScreen(change);
        yield* Deferred.succeed(gate, undefined);
        yield* session.idle;
        expect(events.at(-1)).toMatchObject({ type: "diff-update-paused" });
        const logged = [...events];
        const before = calls.length;
        const cont = scripted([]);
        const restored = yield* restoreSession(viaJsonl(logged)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), reader(screens).log)));
        // 復元したセッションも一時停止のまま戻るので、どちらも 1 つ目の発言を受けてから時計を進めて再試行する。どちらも一時停止した発言を含む
        yield* session.push(spoken("n0", next[0]!));
        yield* restored.push(spoken("n0", next[0]!));
        yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
        yield* settleUntil(() => calls.length === before + 1 && cont.calls.length === 1);
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

    it.effect("一時停止した回で新しい持ち越しができても、復元と元のセッションの続きは一致する（持ち越しは選ぶ前に戻る）", () =>
      Effect.gen(function* () {
        const { liveCalls, restoredCalls } = yield* comparePaused(
          (s) =>
            Effect.gen(function* () {
              yield* s.pushScreen(shot(0, "X"));
              yield* s.push(spoken("p1", 1));
              yield* s.idle;
              yield* s.pushScreen(shot(4, "Y"));
            }),
          5, [], [12, 20],
        );
        expect(liveCalls.map(startsOfCall)).toEqual([undefined, [4]]);
        expect(restoredCalls.map(startsOfCall)).toEqual(liveCalls.map(startsOfCall));
        expect(restoredCalls.map(previousOfCall)).toEqual(liveCalls.map(previousOfCall));
        expect(restoredCalls.map(previousOfCall)).toEqual([[0], [0]]);
      }));

    it.effect("一時停止した回で、それまでの持ち越しが添える対象に選ばれても、復元と元のセッションの続きは一致する（選んだ画面は戻る）", () =>
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
          10, [], [11],
        );
        expect(liveCalls.map(startsOfCall)).toEqual([[8]]);
        expect(restoredCalls.map(startsOfCall)).toEqual([[8]]);
        expect(liveCalls.map(previousOfCall)).toEqual([[0]]);
        expect(restoredCalls.map(previousOfCall)).toEqual([[0]]);
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
        expect(restoredCalls.map(previousOfCall)).toEqual(liveCalls.map(previousOfCall));
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
      const restored = yield* restoreSession(events).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), reader(stored).log)));
      yield* restored.push(spoken("r2", 20));
      yield* restored.idle;
      // 区切りは 10: 映り始めが 1〜4 の変化はすべて添え済み
      expect("screens" in cont.calls[0]!).toBe(false);
      expect(view(cont.calls[0]!.previousScreens)).toEqual([{ start: 3, bytes: null }, { start: 4, bytes: Array.from(bytesOf("bytes:0004.0.jpg")) }]);
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
  const failure = (message: string): UpdateFailure => ({ _tag: "UpdateFailed", message });

  const continued = (events: LogEvent[], next: Remark) =>
    Effect.gen(function* () {
      const cont = scripted([]);
      const restored = yield* restoreSession(viaJsonl(events)).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(next);
      yield* restored.idle;
      return cont.calls;
    });

  it.effect("最後の差分更新が成功したログから続けると、その応答の対応と捨てた操作が入力に載り、元のセッションの続きと一致する", () =>
    Effect.gen(function* () {
      const p = [remark("一"), remark("二"), remark("三")];
      const dropOp: Op = { op: "add", ref: "u9", parent: "n99", kind: "課題", text: "親が無い", evidence: [p[0]!.id] };
      const first: Op[] = [{ op: "add", ref: "u1", parent: "root", kind: "議題", text: "採用", evidence: [p[0]!.id] }, dropOp];
      const { calls, events } = yield* playBatches([[p[0]!], [p[1]!, p[2]!]], [first, []]);
      const secondDiff = events.findIndex((e, i) => e.type === "diff" && events.slice(0, i).some((x) => x.type === "diff"));
      const logged = events.slice(0, secondDiff).filter((e) => !(e.type === "remark" && e.remark.id === p[2]!.id));

      const got = yield* continued(logged, p[2]!);
      expect(got[0]!.previousResponse).toEqual({ refs: { u1: "n1" }, dropped: [{ op: dropOp, reason: "親が存在しない" }] });
      expect(got[0]).toEqual(calls[1]);
    }));

  it.effect("最後の差分更新が失敗したログから続けると、続きの入力に前回の応答は載らない", () =>
    Effect.gen(function* () {
      const p = [remark("一"), remark("二"), remark("三")];
      const { events } = yield* playBatches(
        [[p[0]!], [p[1]!]],
        [[{ op: "add", ref: "u1", parent: "root", kind: "議題", text: "採用", evidence: [p[0]!.id] }], failure("timeout")],
      );
      const got = yield* continued(events, p[2]!);
      expect(got).toHaveLength(1);
      expect("previousResponse" in got[0]!).toBe(false);
    }));
});
