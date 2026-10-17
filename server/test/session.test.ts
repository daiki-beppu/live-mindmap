import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { exportFiles, hasContent, makeSession, restoreSession, type DiffInput, type DiffOutput, type InferredSpeakerName, type LogEvent, type Op, type Remark, type Session, type Snapshot, type SnapshotNode } from "../src/core/index.ts";
import { playBatches } from "./fixtures/batches.ts";
import { collectLog, logLayer, settleUntil, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

// セッションは Scope を要る Effect（makeSession）。差分更新・ログは偽物の Service を Layer で渡す。
// 差分更新は、呼び出し中でなければ発言 1 件ですぐ呼ぶ。時間に依る呼び出しは無いので、「呼ばれない」ことは TestClock を進めて確かめる。

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

const freshIds = (input: DiffInput) => input.fresh.map((u) => u.id);

const open = (update: (input: DiffInput) => Effect.Effect<DiffOutput, UpdateFailure>, events: LogEvent[] = []) =>
  makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));

const setup = Effect.fn("setup")(function* (...script: Op[][]) {
  const { calls, update } = scripted(...script);
  const events: LogEvent[] = [];
  const session = yield* open(update, events);
  return { session, calls, events };
});

// 台本の 1 手ごとに発言を 2 つ流し、差分更新を 1 回ずつ起こす（2 つは前の呼び出し中に届き、まとめて 1 回で渡る）。流した発言の ID を手ごとに返す。
const play = Effect.fn("play")(function* (...script: (Op[] | ((ids: string[][]) => Op[]))[]) {
  const pairs = script.map(() => [remark("発言"), remark("発言")] as const);
  const ids = pairs.map((p) => p.map((u) => u.id));
  const resolved = script.map((s) => (typeof s === "function" ? s(ids) : s));
  const { session, calls, events } = yield* playBatches(pairs, resolved);
  const snap = yield* session.snapshot;
  const byText = (text: string) => snap.nodes.find((n) => n.text === text);
  const dropped = events.flatMap((e) => (e.type === "diff" ? e.dropped : []));
  const ends = pairs.map(([a, b]) => Math.max(a.end, b.end)); // 手ごとの新しい発言の終了時刻の最大値
  return { session, calls, events, snap, byText, dropped, ids, ends };
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
        call: { startedAt: expect.any(String), endedAt: expect.any(String) },
      });
    }));

  it.effect("差分更新がトークン数を返すと、diff の行の usage にそのまま入り、返さない回の行には usage のキー自体が付かない", () =>
    Effect.gen(function* () {
      const usage = { input: 120, cacheWrite: 30, cacheRead: 4000, output: 55, model: "claude-haiku-5-5" };
      let n = 0;
      const events: LogEvent[] = [];
      const session = yield* open(
        () => Effect.sync(() => (n++ === 0 ? { ops: [], usage } : { ops: [] })),
        events,
      );
      for (const text of ["一つ目", "二つ目"]) {
        yield* session.push(remark(text));
        yield* session.idle;
      }

      const diffs = events.flatMap((e) => (e.type === "diff" ? [e] : []));
      expect(diffs).toHaveLength(2);
      expect(diffs[0]!.usage).toEqual(usage);
      expect(diffs[1]).not.toHaveProperty("usage");
    }));

  it.effect("差分更新が判定の記録（judge）を返すと、diff の行に usage と並べてそのまま残り、返さない回の行には judge のキー自体が付かない", () =>
    Effect.gen(function* () {
      const usage = { input: 120, cacheWrite: 30, cacheRead: 4000, output: 55, model: "claude-haiku-5-5" };
      const judge = { model: "claude-haiku-5-5", ms: 42, confidence: 0.12 };
      const failedJudge = { model: "claude-sonnet-5-5", ms: 1000, failure: "時間切れ" };
      const results = [{ ops: [], usage, judge }, { ops: [], judge: failedJudge }, { ops: [] }];
      let n = 0;
      const events: LogEvent[] = [];
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
        updaterLayer(() => Effect.sync(() => results[n++]!)), collectLog(events))));
      for (const text of ["一つ目", "二つ目", "三つ目"]) {
        yield* session.push(remark(text));
        yield* session.idle;
      }

      const diffs = events.flatMap((e) => (e.type === "diff" ? [e] : []));
      expect(diffs).toHaveLength(3);
      expect(diffs[0]).toMatchObject({ usage, judge });
      expect(diffs[1]).toMatchObject({ judge: failedJudge });
      expect(diffs[1]!.judge).not.toHaveProperty("confidence");
      expect(diffs[1]).not.toHaveProperty("usage");
      expect(diffs[2]).not.toHaveProperty("judge");
    }));

  it.effect("失敗した回の diff の行には usage を付けず、error の形は変わらない", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const session = yield* open(() => Effect.fail({ _tag: "ClaudeResultFailed", message: "timeout" }), events);
      yield* session.push(remark("発言"));
      yield* session.idle;

      const diff = events.find((e) => e.type === "diff");
      expect(diff).toMatchObject({ type: "diff", error: expect.stringContaining("timeout") });
      expect(diff).not.toHaveProperty("usage");
    }));

  it.effect("失敗値の judge は error の diff の行に残り、judge の無い失敗の行にはキーが付かない。往復しても restoreSession が読める", () =>
    Effect.gen(function* () {
      const judge = { model: "claude-sonnet-5-5", ms: 7, confidence: 0.9 };
      const failures: UpdateFailure[] = [{ _tag: "Fake", message: "x", judge }, { _tag: "Fake", message: "y" }];
      let n = 0;
      const events: LogEvent[] = [];
      const session = yield* open(() => Effect.fail(failures[n++]!), events);
      for (const text of ["一つ目", "二つ目"]) {
        yield* session.push(remark(text));
        yield* session.idle;
      }
      const diffs = events.flatMap((e) => (e.type === "diff" ? [e] : []));
      expect(diffs[0]).toMatchObject({ error: "Fake: x", judge, ops: [] });
      expect(diffs[1]).toMatchObject({ error: "Fake: y" });
      expect(diffs[1]).not.toHaveProperty("judge");

      const roundTripped = events.map((e): unknown => JSON.parse(JSON.stringify(e)));
      const restored = yield* restoreSession(roundTripped).pipe(Effect.provide(Layer.merge(updaterLayer(() => Effect.succeed({ ops: [] })), collectLog([]))));
      expect((yield* restored.snapshot).nodes.length).toBe(1);
    }));

  it.effect("反映数が不正な回の error の行にも judge が残り、正しい反映数の成功行は error を持たない", () =>
    Effect.gen(function* () {
      const judge = { model: "claude-haiku-5-5", ms: 3, confidence: 0.1 };
      const results = [{ ops: [], judge, processedRemarks: 2 }, { ops: [], judge, processedRemarks: 1 }];
      let n = 0;
      const events: LogEvent[] = [];
      const session = yield* open(() => Effect.succeed(results[n++]!), events);
      for (const text of ["一つ目", "二つ目"]) {
        yield* session.push(remark(text));
        yield* session.idle;
      }
      const diffs = events.flatMap((e) => (e.type === "diff" ? [e] : []));
      expect(diffs[0]).toMatchObject({ error: "InvalidProcessedRemarks: 反映数が入力の発言数に対して不正です", judge });
      expect(diffs[1]).toMatchObject({ judge });
      expect(diffs[1]).not.toHaveProperty("error");
    }));

  // 差分更新の呼び出しの開始・終了の時刻（Issue #862）。at と同じ実時刻の ISO 文字列
  const isIso = (s: string) => DateTime.formatIso(DateTime.makeUnsafe(s)) === s;
  const ms = (s: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(s));

  // 実時刻が直前の値より進むまで回ってから、その時刻を返す（sleep ではない。ISO はミリ秒まで持つので、段階の間を厳密な不等号で区別できる）
  const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
  const advanced = () => {
    const before = nowMs();
    let t = nowMs();
    while (t <= before) t = nowMs();
    return t;
  };
  type Call = { startedAt: string; endedAt: string };

  it.effect("成功した回の diff の行に、update に入った時刻以前の開始と、応答した時刻以後の終了を ISO 形式で残す", () =>
    Effect.gen(function* () {
      let entered = 0, replied = 0;
      const events: LogEvent[] = [];
      const session = yield* open(
        () => Effect.sync(() => { entered = advanced(); }).pipe(
          Effect.andThen(Effect.sync(() => { replied = advanced(); return { ops: [] }; })),
        ),
        events,
      );
      yield* session.push(remark("発言"));
      yield* session.idle;

      const call = (events.find((e) => e.type === "diff") as { call?: Call } | undefined)?.call;
      expect(call).toBeDefined();
      expect(isIso(call!.startedAt)).toBe(true);
      expect(isIso(call!.endedAt)).toBe(true);
      expect(ms(call!.startedAt)).toBeLessThanOrEqual(entered);
      expect(entered).toBeLessThan(replied);
      expect(replied).toBeLessThanOrEqual(ms(call!.endedAt));
      expect(ms(call!.startedAt)).toBeLessThan(ms(call!.endedAt));
    }));

  it.effect("失敗した回（型付きの失敗・defect）の diff の行にも、update に入った時刻以前の開始と、失敗した時刻以後の終了を残す", () =>
    Effect.gen(function* () {
      for (const make of [
        () => Effect.fail({ _tag: "ClaudeResultFailed", message: "timeout" }),
        () => Effect.die("壊れた"),
      ] as const) {
        let entered = 0, failedAt = 0;
        const events: LogEvent[] = [];
        const session = yield* open(
          () => Effect.sync(() => { entered = advanced(); }).pipe(
            Effect.andThen(Effect.sync(() => { failedAt = advanced(); }).pipe(Effect.andThen(make()))),
          ),
          events,
        );
        yield* session.push(remark("発言"));
        yield* session.idle;

        const diff = events.find((e) => e.type === "diff") as { error?: string; call?: Call } | undefined;
        expect(diff?.error).toBeDefined();
        expect(diff?.call).toBeDefined();
        expect(isIso(diff!.call!.startedAt)).toBe(true);
        expect(isIso(diff!.call!.endedAt)).toBe(true);
        expect(ms(diff!.call!.startedAt)).toBeLessThanOrEqual(entered);
        expect(failedAt).toBeLessThanOrEqual(ms(diff!.call!.endedAt));
        expect(ms(diff!.call!.startedAt)).toBeLessThan(ms(diff!.call!.endedAt));
      }
    }));

  it.effect("画像を添えた回の開始の時刻は、画像の読み戻しを終えた時刻以後になる", () =>
    Effect.gen(function* () {
      let readEntered = 0, readDone = 0;
      const files = new Map<string, Uint8Array>();
      const events: LogEvent[] = [];
      const layer = Layer.merge(
        updaterLayer(() => Effect.succeed({ ops: [] })),
        logLayer(
          (event) => Effect.sync(() => { events.push(event); }),
          (file, bytes) => Effect.sync(() => { files.set(file, bytes); }),
          (file) => Effect.sync(() => {
            readEntered = advanced();
            readDone = advanced();
            return files.get(file)!;
          }),
        ),
      );
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(layer));
      yield* session.pushScreen({ start: 1, image: { id: "s1", bytes: new TextEncoder().encode("bytes:s1") } });
      yield* session.push(remark("発言"));
      yield* session.idle;

      const diff = events.find((e) => e.type === "diff") as { input: { screens?: unknown[] }; call?: Call } | undefined;
      expect(diff?.input.screens).toBeDefined();
      expect(diff?.call).toBeDefined();
      expect(readEntered).toBeLessThan(readDone);
      expect(readDone).toBeLessThanOrEqual(ms(diff!.call!.startedAt));
    }));

  it.effect("call の付いた diff の行を JSON で往復しても restoreSession が読める", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const session = yield* open(() => Effect.succeed({ ops: [] }), events);
      yield* session.push(remark("発言"));
      yield* session.idle;
      expect(events.some((e) => e.type === "diff" && e.call !== undefined)).toBe(true);

      const roundTripped = events.map((e): unknown => JSON.parse(JSON.stringify(e)));
      const restored = yield* restoreSession(roundTripped).pipe(Effect.provide(Layer.merge(updaterLayer(() => Effect.succeed({ ops: [] })), collectLog([]))));
      expect((yield* restored.snapshot).nodes.length).toBe(1);
    }));

  it.effect("makeSession は最初のイベントとして、タイトルを持つ開始のイベントを SessionLog に書く", () =>
    Effect.gen(function* () {
      const { events } = yield* setup();
      expect(events).toEqual([{ type: "start", title: "定例" }]);
    }));
});

describe("差分更新の呼び出し", () => {
  it.effect("呼び出し中でなければ、発言 1 件の push で、時間を進めなくても差分更新を呼び、返った追加をマップに入れる", () =>
    Effect.gen(function* () {
      const a = remark("今日は採用の話をします");
      const { session, calls } = yield* setup([
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] },
      ]);

      yield* session.push(a);
      expect(calls).toHaveLength(1); // idle も TestClock も進めていない
      expect(calls[0]!.fresh.map((u) => u.id)).toEqual([a.id]);
      yield* session.idle;

      expect(calls).toHaveLength(1);
      const snap = yield* session.snapshot;
      const topic = snap.nodes.find((n) => n.text === "採用")!;
      expect(topic).toMatchObject({ kind: "議題", parent: "root", evidence: [a.id] });
    }));

  it.effect("呼び出しが終わっていれば、次の発言も 1 件ですぐ呼ぶ。入力の recent は処理済みの発言", () =>
    Effect.gen(function* () {
      const [a, b] = [remark("一"), remark("二")];
      const { session, calls } = yield* setup();

      yield* session.push(a);
      yield* session.idle;
      yield* session.push(b);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.fresh.map((u) => u.id)).toEqual([b.id]);
      expect(calls[1]!.recent.map((u) => u.id)).toEqual([a.id]);
    }));

  it.effect("重複の印が付いた発言は呼び出しを起こさず入力にも入れないが、ログには残す", () =>
    Effect.gen(function* () {
      const a = remark("予算は来週決めます", { track: "相手" });
      const echo = remark("予算は来週決めます", { track: "自分", duplicate: true });
      const b = remark("担当は佐藤さんで");
      const { session, calls, events } = yield* setup();

      yield* session.push(a);
      yield* session.idle;
      expect(calls).toHaveLength(1);
      yield* session.push(echo);
      yield* session.idle;
      expect(calls).toHaveLength(1);

      yield* session.push(b);
      yield* session.idle;
      expect(calls).toHaveLength(2);
      expect(calls.flatMap((c) => c.fresh.map((u) => u.id))).toEqual([a.id, b.id]);
      const logged = events.flatMap((e) => (e.type === "remark" ? [e.remark] : []));
      expect(logged).toContainEqual(echo);
    }));

  it.effect("呼び出し中に届いた重複の印つきの発言は、終わった後の呼び出しに混ざらない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a);
      yield* session.push(b);
      yield* session.push(remark("反響", { duplicate: true }));
      yield* session.push(c);
      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(freshIds(calls[1]!.input)).toEqual([b.id, c.id]);
    }));

  it.effect("呼び出し中は次を呼ばず、その間にたまった発言を、届いた順に次の 1 回へまとめる。呼び出しは重ならない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c, d, e] = ["一", "二", "三", "四", "五"].map((t) => remark(t));

      for (const r of [a!, b!, c!, d!, e!]) yield* session.push(r);
      expect(calls).toHaveLength(1);
      expect(freshIds(calls[0]!.input)).toEqual([a!.id]);

      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(freshIds(calls[1]!.input)).toEqual([b!.id, c!.id, d!.id, e!.id]);
      expect(calls[1]!.input.recent.map((u) => u.id)).toEqual([a!.id]);

      calls[1]!.reply();
      yield* session.idle;
      expect(calls).toHaveLength(2);
    }));

  it.effect("呼び出しが続けて終わるとき、呼び出しは 1 つずつで、前の返事より先に次の呼び出しは始まらない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a);
      yield* session.push(b);
      yield* settle;
      expect(calls).toHaveLength(1);
      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      yield* session.push(c); // 2 つ目の呼び出し中に届く
      yield* settle;
      expect(calls).toHaveLength(2);
      calls[1]!.reply();
      yield* settleUntil(() => calls.length === 3);
      expect(calls.map((c2) => freshIds(c2.input))).toEqual([[a.id], [b.id], [c.id]]);
    }));

  it.effect("差分更新が失敗しても、理由をログに残して次の呼び出しへ進む", () =>
    Effect.gen(function* () {
      let n = 0;
      const events: LogEvent[] = [];
      const update = (): Effect.Effect<DiffOutput, UpdateFailure> =>
        n++ === 0 ? Effect.fail({ _tag: "UpdateFailed", message: "timeout" }) : Effect.succeed({ ops: [{ op: "noop", reason: "雑談" }] });
      const session = yield* open(update, events);
      for (const t of ["一", "二"]) {
        yield* session.push(remark(t));
        yield* session.idle;
      }

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

  it.effect("呼び出し中の flush は、続けて起きるたまった発言の呼び出しが終わるまで待つ。残りが無ければ何も呼ばない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b] = [remark("一"), remark("二")];

      yield* session.push(a);
      yield* session.push(b);
      let flushed = false;
      const flushing = yield* session.flush.pipe(Effect.andThen(Effect.sync(() => { flushed = true; })), Effect.forkChild);
      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      yield* settle;
      expect(flushed).toBe(false); // b の呼び出しの返事を待っている
      calls[1]!.reply();
      yield* Fiber.join(flushing);
      expect(flushed).toBe(true);
      expect(calls).toHaveLength(2);

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
      yield* session.idle;
      yield* session.push(filler);
      yield* session.idle;
      expect(calls).toHaveLength(1); // フィラーでは呼ばない

      yield* session.push(b);
      yield* session.idle;
      expect(calls).toHaveLength(2);
      expect(calls[1]!.fresh.map((u) => u.id)).toEqual([b.id]);
      expect(calls[1]!.recent.map((u) => u.id)).toEqual([a.id]);

      expect(events).toContainEqual({ type: "remark", remark: filler, noContent: true });
      expect(events).toContainEqual({ type: "remark", remark: a });
      const marked = events.filter((e) => e.type === "remark" && "noContent" in e);
      expect(marked).toHaveLength(1);
    }));

  it.effect("中身のない発言だけでは差分更新を呼ばない。時間が経っても呼ばない", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* setup();
      yield* session.push(remark("あ", { track: "自分" }));
      yield* session.push(remark("えー"));
      yield* session.push(remark("うん"));
      yield* session.idle;
      yield* TestClock.adjust("1 hour");
      yield* session.idle;
      expect(calls).toHaveLength(0);
    }));

  it.effect("呼び出し中に届いた中身のない発言は、終わった後の呼び出しに混ざらず、それだけでは次の呼び出しも起こさない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b] = [remark("今日は採用の話をします"), remark("担当は佐藤さんで")];

      yield* session.push(a);
      yield* session.push(remark("あ", { track: "自分" }));
      calls[0]!.reply();
      yield* session.idle;
      yield* settle;
      expect(calls).toHaveLength(1); // フィラーだけが届いていたので、終わっても次は呼ばない

      yield* session.push(remark("えー"));
      yield* session.push(b);
      yield* session.push(remark("うん"));
      expect(calls).toHaveLength(2);
      expect(freshIds(calls[1]!.input)).toEqual([b.id]);
    }));
});

describe("差分更新の呼び出し: 時間では呼ばない", () => {
  it.effect("呼び出しが終わり何もたまっていなければ、時間をいくら進めても呼び出しは増えない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const a = remark("今日は採用の話をします");

      yield* session.push(a);
      calls[0]!.reply();
      yield* session.idle;
      yield* TestClock.adjust("1 hour");
      yield* settle;
      expect(calls).toHaveLength(1);
      expect(freshIds(calls[0]!.input)).toEqual([a.id]);
    }));

  it.effect("呼び出し中にたまった発言は、時間が経っても呼ばず、呼び出しが終わった時点ではじめて 1 回で渡す", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a);
      yield* session.push(b);
      yield* session.push(c);
      yield* TestClock.adjust("1 hour");
      yield* settle;
      expect(calls).toHaveLength(1);

      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(freshIds(calls[1]!.input)).toEqual([b.id, c.id]);
      expect(calls[1]!.input.recent.map((u) => u.id)).toEqual([a.id]);

      calls[1]!.reply();
      yield* session.idle;
      yield* TestClock.adjust("1 hour");
      yield* settle;
      expect(calls).toHaveLength(2);
    }));

  it.effect("呼び出しが終わった時点で 1 件だけたまっていても、待たずにすぐ呼ぶ", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, b] = [remark("一"), remark("二")];

      yield* session.push(a);
      yield* session.push(b);
      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2); // 時間は進めない
      expect(freshIds(calls[1]!.input)).toEqual([b.id]);
    }));

  it.effect("呼び出しの合間に時間が経っても、後から来た発言は届いた時点で呼ぶ（古い時刻に引きずられない）", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* setup();
      const [a, b, c] = [remark("一"), remark("二"), remark("三")];

      yield* session.push(a);
      yield* session.idle;
      yield* TestClock.adjust("1 hour");
      yield* session.push(b);
      expect(calls).toHaveLength(2);
      yield* TestClock.adjust(1);
      yield* session.push(c);
      expect(calls).toHaveLength(3);
      expect(calls.map((c2) => c2.fresh.map((u) => u.id))).toEqual([[a.id], [b.id], [c.id]]);
    }));

  it.effect("flush は、呼び出し中でなくて残りも無ければ何も呼ばず、時間が経っても後から呼び出しを起こさない", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* setup();

      yield* session.push(remark("一"));
      yield* session.flush;
      expect(calls).toHaveLength(1);
      yield* TestClock.adjust("1 hour");
      yield* settle;
      expect(calls).toHaveLength(1);
    }));
});

describe("セッションの Scope（Fiber の後始末）", () => {
  it.effect("Scope を閉じると、呼び出し中の差分更新の Fiber も中断され、後から返った結果をログに書かない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const events: LogEvent[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* open(update, events);
          yield* session.push(remark("一"));
          expect(calls).toHaveLength(1);
        }),
      );

      calls[0]!.reply(); // 閉じた後の返事は届かない
      yield* settle;
      expect(events.some((e) => e.type === "diff")).toBe(false);
    }));

  it.effect("Scope を閉じた後は、呼び出し中にたまっていた発言も、時間が経っても差分更新に渡らない", () =>
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

      calls[0]!.reply();
      yield* TestClock.adjust("1 hour");
      yield* settle;
      expect(calls).toHaveLength(1);
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

  // 2 つの発言を、1 回の呼び出しにまとめて渡す組にする。end は呼び出し側が決める。
  const group = (ends: [number, number]) => ends.map((end) => remark("発言", { end, start: end - 1 }));

  it.effect("同じセッションで 反映 → 反映 → 何もしない反映 → 失敗した反映 を続けると、round が進み、記録が積み上がる", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const [a, b] = [remark("一"), remark("二")];
      // 反映 1。新しい発言の end の最大値が at になる（最後の発言の end ではない）
      const first = [{ ...a, start: 1, end: 50 }, { ...b, start: 2, end: 30 }];
      const snaps: Snapshot[] = [];
      yield* playBatches(
        [first, group([60, 70]), group([80, 90]), group([100, 110]), group([120, 125])],
        [
          [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }],
          [{ op: "update", node: "n1", text: "中途採用", evidence: [b.id] }],
          [{ op: "noop", reason: "雑談" }],
          failure("timeout"),
          [{ op: "add", ref: "t2", parent: "n1", kind: "論点", text: "面接は何回か", evidence: [b.id] }],
        ],
        {
          events,
          onApplied: (k, session) =>
            Effect.gen(function* () {
              snaps.push(yield* session.snapshot);
              if (k === 3) expect(events.at(-1)).toMatchObject({ type: "diff", error: expect.stringContaining("timeout") });
            }),
        },
      );

      expect(snaps[0]).toMatchObject({ round: 1, changes: [{ round: 1, at: 50, change: "追加", node: "n1", kind: "議題", text: "採用" }] });
      expect(snaps[1]!.round).toBe(2);
      expect(snaps[1]!.changes).toEqual([
        { round: 1, at: 50, change: "追加", node: "n1", kind: "議題", text: "採用" },
        { round: 2, at: 70, change: "更新", node: "n1", kind: "議題", text: "中途採用" },
      ]);
      // 何もしない反映でも round は進む（前回の赤い枠を消すため）。記録は増えない
      expect(snaps[2]!.round).toBe(3);
      expect(snaps[2]!.changes).toHaveLength(2);
      // 失敗した反映では round も記録も進まない
      expect(snaps[3]!.round).toBe(3);
      expect(snaps[3]!.changes).toHaveLength(2);
      // 失敗の後の反映は、次の round として積み上がる
      expect(snaps[4]!.round).toBe(4);
      expect(snaps[4]!.changes.at(-1)).toEqual({ round: 4, at: 125, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" });
      expect(snaps[4]!.changes).toHaveLength(3);
    }));

  it.effect("SessionLog.write が呼ばれた時点のスナップショットに、その反映の round と記録がすでに載っている（送信より先に記録する）", () =>
    Effect.gen(function* () {
      const [a, b] = [remark("一"), remark("二")];
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
      for (const r of [a, b]) {
        yield* session.push(r);
        yield* session.idle;
      }

      expect(seen).toEqual([
        { failed: false, round: 1, changes: 1 },
        { failed: true, round: 1, changes: 1 },
      ]);
    }));

  it.effect("snapshot が返す changes は、あとから書き換えてもセッションの記録に影響しない", () =>
    Effect.gen(function* () {
      const a = remark("一");
      const update = stepped([{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [a.id] }]);
      const session = yield* open(update);
      yield* session.push(a);
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
      const { session } = yield* playBatches([[a, b]], [[add("t1", "採用", [a.id, b.id])]]);

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
      const { session } = yield* playBatches([[a, echo, b]], [[add("t1", "採用", [b.id, a.id])]]);
      yield* session.push(c); // 呼び出し中（反映待ち）の発言は、根拠になっていないので含めない

      expect((yield* session.snapshot).remarks.map((r) => r.id)).toEqual([a.id, b.id]);
    }));

  it.effect("複数のノードが同じ発言を根拠にしても、発言は 1 度だけ含める", () =>
    Effect.gen(function* () {
      const [a, b] = [remark("一"), remark("二")];
      const { session } = yield* playBatches([[a, b]], [[add("t1", "採用", [a.id]), add("t2", "評価", [a.id, b.id])]]);

      expect((yield* session.snapshot).remarks.map((r) => r.id)).toEqual([a.id, b.id]);
    }));

  it.effect("同じセッションで update が根拠を足すと、その発言が次の snapshot から含まれる", () =>
    Effect.gen(function* () {
      const [a, b, c, d] = [remark("一"), remark("二"), remark("三"), remark("四")];
      const seen: string[][] = [];
      const { session } = yield* playBatches(
        [[a, b], [c, d]],
        [[add("t1", "採用", [a.id])], [{ op: "update", node: "n1", evidence: [c.id] }]],
        { onApplied: (_, s) => Effect.map(s.snapshot, (snap) => { seen.push(snap.remarks.map((r) => r.id)); }) },
      );
      expect(seen).toEqual([[a.id], [a.id, c.id]]);
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
      const { session } = yield* playBatches([[a, b]], [[add("t1", "採用", [a.id])]]);

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

      yield* session.push(a); // すぐ渡り、結果待ちになる
      expect(yield* ids).toEqual([a.id]);
      yield* session.push(dup);
      expect(yield* ids).toEqual([a.id]);
      yield* session.push(b); // 呼び出し中なので、渡さずにためる
      yield* session.push(c);
      expect(yield* ids).toEqual([a.id, b.id, c.id]);

      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2); // b・c が 1 回にまとまって渡り、結果待ちになる
      expect(freshIds(calls[1]!.input)).toEqual([b.id, c.id]);
      expect(yield* ids).toEqual([b.id, c.id]);

      calls[1]!.reply();
      yield* session.idle;
      expect(yield* ids).toEqual([]);
    }));

  it.effect("中身のない発言は、渡す前も結果待ちの間も含まない", () =>
    Effect.gen(function* () {
      const { calls, update } = manual();
      const session = yield* open(update);
      const [a, filler, b, filler2] = [remark("ア"), remark("あ", { track: "自分" }), remark("イ"), remark("えー")];
      const ids = Effect.map(session.unreflectedRemarks, (rs) => rs.map((r) => r.id));

      yield* session.push(a); // 結果待ち
      yield* session.push(filler);
      expect(yield* ids).toEqual([a.id]);
      yield* session.push(b); // 渡さずにためる
      yield* session.push(filler2);
      expect(yield* ids).toEqual([a.id, b.id]);

      calls[0]!.reply();
      yield* settleUntil(() => calls.length === 2);
      expect(yield* ids).toEqual([b.id]);
      calls[1]!.reply();
      yield* session.idle;
      expect(yield* session.unreflectedRemarks).toEqual([]);
    }));

  it.effect("返した発言を書き換えても、セッションの記録にも次の呼び出しにも影響しない", () =>
    Effect.gen(function* () {
      const { update } = manual();
      const session = yield* open(update);
      const a = remark("元の本文");
      yield* session.push(a); // 結果待ち

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
      const pairs = [[remark("発言"), remark("発言")], [remark("発言"), remark("発言")]];
      const { session } = yield* playBatches(pairs, [nested([pairs[0]!.map((r) => r.id)]), { _tag: "UpdateFailed", message: "timeout" }]);
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

// 触れたノードの touchedAt（その反映の新しい発言の end の最大値）と evidenceRound（根拠が足された反映の番号）
describe("ノードの最後に触れた時刻（touchedAt）と最後に根拠が足された反映の番号（evidenceRound）", () => {
  const base = (ids: string[][]): Op[] => [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: [ids[0]![1]!] },
    { op: "add", ref: "t4", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!] },
  ];
  // base の ID: n1 採用 / n2 面接は何回か / n3 3 回 / n4 予算

  it.effect("議題の下の論点に案を追加すると、案・論点・議題の touchedAt がその反映の最大値になり、兄弟の議題とルートは変わらない", () =>
    Effect.gen(function* () {
      const { byText, snap, ends } = yield* play(base, (ids) => [
        { op: "add", ref: "t5", parent: "n2", kind: "案", text: "2 回", evidence: [ids[1]![0]!] },
      ]);
      const [first, second] = ends as [number, number];
      expect(first).not.toBe(second);
      expect(byText("2 回")!.touchedAt).toBe(second);
      expect(byText("面接は何回か")!.touchedAt).toBe(second);
      expect(byText("採用")!.touchedAt).toBe(second);
      // 触れていないノードは前の反映の値のまま（先に値があることも確かめる）
      expect(byText("予算")!.touchedAt).toBe(first);
      expect(byText("3 回")!.touchedAt).toBe(first);
      const root = snap.nodes.find((n) => n.parent === null)!;
      expect(root).not.toHaveProperty("touchedAt");
      expect(root).not.toHaveProperty("evidenceRound");
    }));

  it.effect("追加したノードの evidenceRound はその反映の番号。祖先の evidenceRound は変わらない", () =>
    Effect.gen(function* () {
      const { byText, snap } = yield* play(base, (ids) => [
        { op: "add", ref: "t5", parent: "n2", kind: "案", text: "2 回", evidence: [ids[1]![0]!] },
      ]);
      expect(snap.round).toBe(2);
      expect(byText("2 回")!.evidenceRound).toBe(2);
      expect(byText("面接は何回か")!.evidenceRound).toBe(1);
      expect(byText("採用")!.evidenceRound).toBe(1);
      expect(byText("3 回")!.evidenceRound).toBe(1);
    }));

  it.effect("新しい根拠を足す更新は、ノードと祖先の touchedAt を進め、そのノードだけ evidenceRound を進める", () =>
    Effect.gen(function* () {
      const { byText, ends } = yield* play(base, (ids) => [
        { op: "update", node: "n3", text: "3 回にする", evidence: [ids[1]![0]!] },
      ]);
      const [first, second] = ends as [number, number];
      for (const t of ["3 回にする", "面接は何回か", "採用"]) expect(byText(t)!.touchedAt).toBe(second);
      expect(byText("予算")!.touchedAt).toBe(first);
      expect(byText("3 回にする")!.evidenceRound).toBe(2);
      expect(byText("面接は何回か")!.evidenceRound).toBe(1);
    }));

  it.effect("案の状態だけの更新（既存の根拠）は touchedAt を進めるが、evidenceRound は進めない", () =>
    Effect.gen(function* () {
      const { byText, ends } = yield* play(base, (ids) => [
        { op: "update", node: "n3", planStatus: "却下", evidence: [ids[0]![1]!] },
      ]);
      const [first, second] = ends as [number, number];
      expect(byText("3 回")!.planStatus).toBe("却下");
      for (const t of ["3 回", "面接は何回か", "採用"]) expect(byText(t)!.touchedAt).toBe(second);
      expect(byText("予算")!.touchedAt).toBe(first);
      expect(byText("3 回")!.evidenceRound).toBe(1);
    }));

  it.effect("本文だけの更新（既存の根拠を再指定）は touchedAt を進めるが、evidenceRound は進めない", () =>
    Effect.gen(function* () {
      const { byText, ends } = yield* play(base, (ids) => [
        { op: "update", node: "n3", text: "2 回", evidence: [ids[0]![1]!] },
      ]);
      const [first, second] = ends as [number, number];
      expect(first).not.toBe(second);
      for (const t of ["2 回", "面接は何回か", "採用"]) expect(byText(t)!.touchedAt).toBe(second);
      expect(byText("予算")!.touchedAt).toBe(first);
      expect(byText("2 回")!.evidenceRound).toBe(1);
    }));

  it.effect("根拠だけの更新（本文・状態は変えない）は touchedAt を進め、そのノードだけ evidenceRound を進める", () =>
    Effect.gen(function* () {
      const { byText, ends } = yield* play(base, (ids) => [
        { op: "update", node: "n3", evidence: [ids[1]![0]!] },
      ]);
      const [first, second] = ends as [number, number];
      expect(first).not.toBe(second);
      for (const t of ["3 回", "面接は何回か", "採用"]) expect(byText(t)!.touchedAt).toBe(second);
      expect(byText("予算")!.touchedAt).toBe(first);
      expect(byText("3 回")!.evidenceRound).toBe(2);
      expect(byText("面接は何回か")!.evidenceRound).toBe(1);
    }));

  it.effect("移動は、元の親側と新しい親側の祖先の touchedAt を進める。根拠は足されないので evidenceRound は変わらない", () =>
    Effect.gen(function* () {
      // n1 採用 > n2 面接 > n3 案 を、別の議題 n4 予算 の下の論点 n5 へ移す。n6 は無関係の議題
      const { byText, ends } = yield* play(
        (ids) => [
          ...base(ids),
          { op: "add", ref: "t5", parent: "t4", kind: "論点", text: "上限", evidence: [ids[0]![1]!] },
          { op: "add", ref: "t6", parent: "root", kind: "議題", text: "備品", evidence: [ids[0]![1]!] },
        ],
        [{ op: "move", node: "n3", parent: "n5" }],
      );
      const [first, second] = ends as [number, number];
      for (const t of ["3 回", "上限", "予算", "面接は何回か", "採用"]) expect(byText(t)!.touchedAt).toBe(second);
      expect(byText("備品")!.touchedAt).toBe(first);
      expect(byText("3 回")!.evidenceRound).toBe(1);
    }));

  it.effect("統合は、統合先と祖先・統合元の元の親側の祖先の touchedAt を進め、統合先の evidenceRound は統合元・統合先の大きい方を引き継ぐ（進めない）", () =>
    Effect.gen(function* () {
      // n1 採用 > n2 論点（統合元）、n3 予算 > n4 論点（統合先）、n5 備品（無関係）
      const { byText, ends } = yield* play(
        (ids) => [
          { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
          { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
          { op: "add", ref: "t3", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!] },
          { op: "add", ref: "t4", parent: "t3", kind: "論点", text: "上限はいくらか", evidence: [ids[0]![1]!] },
          { op: "add", ref: "t5", parent: "root", kind: "議題", text: "備品", evidence: [ids[0]![1]!] },
        ],
        [{ op: "combine", from: "n2", into: "n4" }],
      );
      const [first, second] = ends as [number, number];
      expect(byText("面接は何回か")).toBeUndefined();
      for (const t of ["上限はいくらか", "予算", "採用"]) expect(byText(t)!.touchedAt).toBe(second);
      expect(byText("備品")!.touchedAt).toBe(first);
      expect(byText("上限はいくらか")!.evidenceRound).toBe(1);
      expect(byText("予算")!.evidenceRound).toBe(1);
    }));

  it.effect("統合元のほうが新しい evidenceRound を持つとき、統合先は統合元の番号を引き継ぐ（統合した反映の番号にはしない）", () =>
    Effect.gen(function* () {
      // 1 回目: n1 採用 > n2 論点（統合元）、n3 予算 > n4 論点（統合先）。2 回目: n2 に根拠を足す。3 回目: n2 を n4 へ統合
      const { byText } = yield* play(
        (ids) => [
          { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
          { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
          { op: "add", ref: "t3", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!] },
          { op: "add", ref: "t4", parent: "t3", kind: "論点", text: "上限はいくらか", evidence: [ids[0]![1]!] },
        ],
        (ids) => [{ op: "update", node: "n2", evidence: [ids[1]![0]!] }],
        [{ op: "combine", from: "n2", into: "n4" }],
      );
      expect(byText("面接は何回か")).toBeUndefined();
      expect(byText("上限はいくらか")!.evidenceRound).toBe(2);
      expect(byText("予算")!.evidenceRound).toBe(1);
    }));

  it.effect("削除は、元の親側の祖先の touchedAt を進め、無関係の議題は進めない", () =>
    Effect.gen(function* () {
      const { byText, ends } = yield* play(base, [{ op: "delete", node: "n3" }]);
      const [first, second] = ends as [number, number];
      expect(byText("3 回")).toBeUndefined();
      for (const t of ["面接は何回か", "採用"]) expect(byText(t)!.touchedAt).toBe(second);
      expect(byText("予算")!.touchedAt).toBe(first);
    }));

  it.effect("捨てた操作は touchedAt・evidenceRound を変えない", () =>
    Effect.gen(function* () {
      const { byText, ends, dropped } = yield* play(base, [
        { op: "update", node: "n3", text: "変える", evidence: ["r-unknown"] },
        { op: "delete", node: "n1" }, // 子を持つので捨てられる
      ]);
      const [first] = ends as [number, number];
      expect(dropped).toHaveLength(2);
      for (const t of ["3 回", "面接は何回か", "採用"]) expect(byText(t)!.touchedAt).toBe(first);
      expect(byText("3 回")!.evidenceRound).toBe(1);
    }));

  it.effect("差分更新が失敗した反映は、ノードの値を変えない", () =>
    Effect.gen(function* () {
      const ps = [remark("発言"), remark("発言")];
      const later = [remark("発言"), remark("発言")];
      let before: SnapshotNode | undefined;
      const { session, calls } = yield* playBatches(
        [ps, later],
        [[{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ps[0]!.id] }], { _tag: "UpdateFailed", message: "timeout" }],
        {
          onApplied: (k, s) =>
            Effect.gen(function* () {
              if (k !== 0) return;
              before = (yield* s.snapshot).nodes.find((x) => x.text === "採用")!;
              expect(before.touchedAt).toBe(ps[1]!.end);
              expect(before.evidenceRound).toBe(1);
            }),
        },
      );
      expect(calls).toHaveLength(2);
      expect((yield* session.snapshot).nodes.find((x) => x.text === "採用")).toEqual(before);
    }));

  it.effect("エクスポートの JSON のノードに touchedAt・evidenceRound は出ない", () =>
    Effect.gen(function* () {
      const { session, snap } = yield* play(base);
      expect(snap.nodes.filter((n) => n.touchedAt !== undefined && n.evidenceRound !== undefined)).toHaveLength(4);
      const json = yield* session.exportJson;
      const keys = (nodes: readonly object[]): string[] => nodes.flatMap((n) => [...Object.keys(n), ...("children" in n ? keys(n.children as object[]) : [])]);
      const all = keys([json.root]);
      expect(all).toContain("text");
      expect(all).not.toContain("touchedAt");
      expect(all).not.toContain("evidenceRound");
    }));
});

// 議題・論点の「済み」（talkStatus）。閉じる（close）は applyOps が判定し、適用・復元の両方で同じ結果になる。
// 手の n 番目が round n。根拠が足された反映の番号（evidenceRound）と今の round を比べて、閉じるを通すか捨てるかを決める。
describe("議題・論点の済みと閉じる（close）", () => {
  // 手ごとに発言を 2 つ流して反映を起こし（2 つは前の呼び出し中に届き、まとめて 1 回で渡る）、手ごとのスナップショットを返す
  const replay = Effect.fn("replay")(function* (...script: (Op[] | ((ids: string[][]) => Op[]))[]) {
    const pairs = script.map(() => [remark("発言"), remark("発言")] as const);
    const ids = pairs.map((p) => p.map((u) => u.id));
    const snaps: Snapshot[] = [];
    const { session, events } = yield* playBatches(pairs, script.map((s) => (typeof s === "function" ? s(ids) : s)), {
      onApplied: (_, s) => Effect.map(s.snapshot, (snap) => { snaps.push(snap); }),
    });
    const dropped = events.flatMap((e) => (e.type === "diff" ? e.dropped : []));
    return { session, events, snaps, snap: snaps.at(-1)!, dropped, ids };
  });
  const closedIds = (snap: { nodes: readonly { id: string; talkStatus?: string }[] }) =>
    snap.nodes.filter((n) => n.talkStatus === "済み").map((n) => n.id).sort();
  const noopHand: Op[] = [{ op: "noop", reason: "雑談" }];

  // n1 採用 / n2 選考 / n3 面接は何回か / n4 3 回 / n5 日程 / n6 予算 / n7 上限 / n8 2 回
  // n1 ⊃ n2 ⊃ n3 ⊃ n4、n1 ⊃ n5、n6 ⊃ n7 ⊃ n8
  const tree = (ids: string[][]): Op[] => [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t2", parent: "t1", kind: "議題", text: "選考", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t3", parent: "t2", kind: "論点", text: "面接は何回か", evidence: [ids[0]![0]!] },
    { op: "add", ref: "t4", parent: "t3", kind: "案", text: "3 回", evidence: [ids[0]![1]!] },
    { op: "add", ref: "t5", parent: "t1", kind: "論点", text: "日程", evidence: [ids[0]![1]!] },
    { op: "add", ref: "t6", parent: "root", kind: "議題", text: "予算", evidence: [ids[0]![1]!] },
    { op: "add", ref: "t7", parent: "t6", kind: "論点", text: "上限", evidence: [ids[0]![1]!] },
    { op: "add", ref: "t8", parent: "t7", kind: "案", text: "2 回", evidence: [ids[0]![1]!] },
  ];
  const closeAll: Op[] = ["n1", "n2", "n3", "n5", "n6", "n7"].map((node) => ({ op: "close" as const, node }));
  const ALL = ["n1", "n2", "n3", "n5", "n6", "n7"];

  describe("閉じる", () => {
    it.effect("作ったばかりの議題・論点は話し中（talkStatus を持たない）で、閉じると議題・論点が済みになる。配下の論点・子の議題・兄弟は変わらない", () =>
      Effect.gen(function* () {
        const { snaps, dropped } = yield* replay(tree, noopHand, [{ op: "close", node: "n1" }]);
        for (const n of snaps[0]!.nodes) expect(n).not.toHaveProperty("talkStatus");
        expect(snaps[1]!.nodes.filter((n) => "talkStatus" in n)).toEqual([]);
        expect(dropped).toEqual([]);
        // 議題 n1 だけが済み。配下の議題 n2・論点 n3・n5 と兄弟の議題 n6 は話し中のまま
        expect(closedIds(snaps[2]!)).toEqual(["n1"]);
        for (const id of ["n2", "n3", "n5", "n6", "n7"]) expect(snaps[2]!.nodes.find((n) => n.id === id)).not.toHaveProperty("talkStatus");
      }));

    it.effect("論点も閉じて済みにできる", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(tree, noopHand, [{ op: "close", node: "n3" }]);
        expect(dropped).toEqual([]);
        expect(closedIds(snap)).toEqual(["n3"]);
        expect(snap.nodes.find((n) => n.id === "n3")!.talkStatus).toBe("済み");
      }));

    it.effect("同じ応答の中で、add した仮 ID の議題を閉じることはできない（根拠が足されたばかり）。既存の議題は同じ応答で閉じられる", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(tree, noopHand, (ids) => [
          { op: "add", ref: "x", parent: "root", kind: "議題", text: "新しい議題", evidence: [ids[2]![0]!] },
          { op: "close", node: "x" },
          { op: "close", node: "n6" },
        ]);
        expect(dropped.map((d) => [d.op.op, "node" in d.op ? d.op.node : undefined])).toEqual([["close", "x"]]);
        expect(closedIds(snap)).toEqual(["n6"]);
      }));
  });

  describe("無効な閉じるは理由つきで捨てる", () => {
    it.effect("存在しない・ルート・議題でも論点でもない・すでに済み、の閉じるを捨て、状態は変えない", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(tree, noopHand, [
          { op: "close", node: "n1" }, // 有効（すでに済みの前提を作る）
          { op: "close", node: "n99" }, // 存在しない
          { op: "close", node: "root" }, // ルート
          { op: "close", node: "n4" }, // 案
          { op: "close", node: "n1" }, // すでに済み
        ]);
        expect(closedIds(snap)).toEqual(["n1"]);
        expect(dropped.map((d) => [d.op.op, "node" in d.op ? d.op.node : undefined])).toEqual([
          ["close", "n99"],
          ["close", "root"],
          ["close", "n4"],
          ["close", "n1"],
        ]);
        for (const d of dropped) expect(d.reason).not.toBe("");
        expect(snap.nodes.find((n) => n.id === "n4")).not.toHaveProperty("talkStatus");
        expect(snap.nodes.find((n) => n.id === "root")).not.toHaveProperty("talkStatus");
      }));
  });

  describe("根拠が足された直後は閉じられない", () => {
    it.effect("同じ応答で閉じるより前に子孫へ根拠を足すと、閉じるは捨てられる。無関係の議題は同じ応答で閉じられる", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(tree, noopHand, (ids) => [
          { op: "update", node: "n4", evidence: [ids[2]![0]!] },
          { op: "close", node: "n1" },
          { op: "close", node: "n6" },
        ]);
        expect(dropped.map((d) => [d.op.op, "node" in d.op ? d.op.node : undefined])).toEqual([["close", "n1"]]);
        expect(dropped[0]!.reason).not.toBe("");
        expect(closedIds(snap)).toEqual(["n6"]);
      }));

    it.effect("同じ応答でも、閉じるの後に子孫へ根拠を足した場合は閉じるは通り、その更新で話し中に戻る", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(tree, noopHand, (ids) => [
          { op: "close", node: "n1" },
          { op: "update", node: "n4", evidence: [ids[2]![0]!] },
        ]);
        expect(dropped).toEqual([]);
        expect(closedIds(snap)).toEqual([]);
      }));

    it.effect("直前の反映で子孫に根拠が足されていると閉じるは捨てられ、その次の反映（2 つ前）なら閉じられる", () =>
      Effect.gen(function* () {
        const { snaps, dropped } = yield* replay(
          tree,
          (ids) => [{ op: "update", node: "n4", evidence: [ids[1]![0]!] }], // round 2 で根拠を足す
          [{ op: "close", node: "n1" }], // round 3: 直前なので捨てる
          [{ op: "close", node: "n1" }], // round 4: 2 つ前なので通る
        );
        expect(dropped.map((d) => [d.op.op, "node" in d.op ? d.op.node : undefined])).toEqual([["close", "n1"]]);
        expect(closedIds(snaps[2]!)).toEqual([]);
        expect(closedIds(snaps[3]!)).toEqual(["n1"]);
      }));

    it.effect("対象自身に根拠が足された直前の反映でも閉じるは捨てられる。祖先に根拠が足されただけなら閉じられる", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(
          tree,
          (ids) => [
            { op: "update", node: "n3", evidence: [ids[1]![0]!] }, // 対象自身
            { op: "update", node: "n6", evidence: [ids[1]![0]!] }, // 子孫の祖先側
          ],
          [
            { op: "close", node: "n3" }, // 自身に直前の根拠 → 捨てる
            { op: "close", node: "n7" }, // 祖先 n6 にだけ直前の根拠 → 通る
          ],
        );
        expect(dropped.map((d) => [d.op.op, "node" in d.op ? d.op.node : undefined])).toEqual([["close", "n3"]]);
        expect(closedIds(snap)).toEqual(["n7"]);
      }));

    it.effect("根拠を足さない更新（本文だけ・既存の根拠）は閉じるを妨げない", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(
          tree,
          (ids) => [{ op: "update", node: "n4", text: "4 回", evidence: [ids[0]![1]!] }],
          [{ op: "close", node: "n1" }],
        );
        expect(dropped).toEqual([]);
        expect(closedIds(snap)).toEqual(["n1"]);
      }));
  });

  describe("統合だけでは根拠が足された扱いにならない", () => {
    // n1 議題 A > n2 論点 a、n3 議題 B > n4 論点 b（根拠はどちらも 1 回目の発言）
    const two = (ids: string[][]): Op[] => [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "A", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "a", evidence: [ids[0]![0]!] },
      { op: "add", ref: "t3", parent: "root", kind: "議題", text: "B", evidence: [ids[0]![1]!] },
      { op: "add", ref: "t4", parent: "t3", kind: "論点", text: "b", evidence: [ids[0]![1]!] },
    ];

    it.effect("統合と同じ応答の中で、統合先の議題・論点を閉じられる", () =>
      Effect.gen(function* () {
        const { snap, dropped } = yield* replay(two, noopHand, [
          { op: "combine", from: "n2", into: "n4" },
          { op: "close", node: "n4" },
          { op: "close", node: "n3" },
        ]);
        expect(dropped).toEqual([]);
        expect(closedIds(snap)).toEqual(["n3", "n4"]);
      }));

    it.effect("統合の次の反映で、統合先の議題・論点を閉じられる", () =>
      Effect.gen(function* () {
        const { snaps, dropped } = yield* replay(
          two,
          [{ op: "combine", from: "n2", into: "n4" }], // round 2: 統合
          [{ op: "close", node: "n3" }, { op: "close", node: "n4" }], // round 3
        );
        expect(dropped).toEqual([]);
        expect(closedIds(snaps[1]!)).toEqual([]);
        expect(closedIds(snaps[2]!)).toEqual(["n3", "n4"]);
      }));

    it.effect("統合元に直前の反映で根拠が足されていれば、統合と同じ応答で統合先とその祖先を閉じるのは捨てられ、次の反映なら通る", () =>
      Effect.gen(function* () {
        const { snaps, dropped } = yield* replay(
          two,
          (ids) => [{ op: "update", node: "n2", evidence: [ids[1]![0]!] }], // round 2: 統合元に根拠
          [{ op: "combine", from: "n2", into: "n4" }, { op: "close", node: "n4" }, { op: "close", node: "n3" }], // round 3: 統合元の根拠が移っているので捨てる
          [{ op: "close", node: "n3" }], // round 4: 通る
        );
        expect(dropped.map((d) => [d.op.op, "node" in d.op ? d.op.node : undefined])).toEqual([
          ["close", "n4"],
          ["close", "n3"],
        ]);
        expect(closedIds(snaps[2]!)).toEqual([]);
        expect(closedIds(snaps[3]!)).toEqual(["n3"]);
      }));

    it.effect("統合元に直前の反映で根拠が足されていれば、統合の次の反映で統合先とその祖先を閉じるのは捨てられ、その次の反映なら通る", () =>
      Effect.gen(function* () {
        const { snaps, dropped } = yield* replay(
          two,
          (ids) => [
            { op: "update", node: "n2", evidence: [ids[1]![0]!] },
            { op: "combine", from: "n2", into: "n4" },
          ], // round 2: 統合元に根拠を足して統合
          [{ op: "close", node: "n4" }, { op: "close", node: "n3" }], // round 3: 捨てる
          [{ op: "close", node: "n3" }], // round 4: 通る
        );
        expect(dropped.map((d) => [d.op.op, "node" in d.op ? d.op.node : undefined])).toEqual([
          ["close", "n4"],
          ["close", "n3"],
        ]);
        expect(closedIds(snaps[2]!)).toEqual([]);
        expect(closedIds(snaps[3]!)).toEqual(["n3"]);
      }));
  });

  describe("自動の開き直し", () => {
    // 3 手目までに全部を済みにし、4 手目の操作でどこが話し中に戻るかを見る
    const reopen = Effect.fn("reopen")(function* (hand: Op[] | ((ids: string[][]) => Op[])) {
      const r = yield* replay(tree, noopHand, closeAll, hand);
      expect(closedIds(r.snaps[2]!)).toEqual(ALL); // 前提: 全部が済み
      expect(r.dropped).toEqual([]);
      return r;
    });

    it.effect("追加: 済みの論点の下に追加すると、論点とその祖先の議題がすべて話し中に戻る。別の枝の済みは変わらない", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen((ids) => [{ op: "add", ref: "x", parent: "n3", kind: "案", text: "1 回", evidence: [ids[3]![0]!] }]);
        expect(closedIds(snap)).toEqual(["n5", "n6", "n7"]);
      }));

    it.effect("更新（本文だけ・既存の根拠を再指定）でも、案の祖先の済みがすべて話し中に戻る。別の枝の済みは変わらない", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen((ids) => [{ op: "update", node: "n4", text: "4 回", evidence: [ids[0]![1]!] }]);
        expect(closedIds(snap)).toEqual(["n5", "n6", "n7"]);
      }));

    it.effect("値が変わらない更新（本文なし・計画の状態なし・既存の根拠のみ）でも、案の祖先の済みがすべて話し中に戻る。別の枝の済みは変わらない", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen((ids) => [{ op: "update", node: "n4", evidence: [ids[0]![1]!] }]);
        expect(closedIds(snap)).toEqual(["n5", "n6", "n7"]);
      }));

    it.effect("更新の対象自身が済みの論点なら、それ自身と祖先が話し中に戻る", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen((ids) => [{ op: "update", node: "n3", text: "面接の回数", evidence: [ids[0]![0]!] }]);
        expect(closedIds(snap)).toEqual(["n5", "n6", "n7"]);
      }));

    it.effect("統合: 統合先の祖先がすべて話し中に戻る。統合元の元の祖先は済みのまま", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen([{ op: "combine", from: "n8", into: "n4" }]);
        expect(closedIds(snap)).toEqual(["n5", "n6", "n7"]);
        expect(snap.nodes.find((n) => n.id === "n8")).toBeUndefined();
      }));

    it.effect("移動: 移したノードの新しい祖先がすべて話し中に戻る。移動元の祖先は済みのまま", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen([{ op: "move", node: "n8", parent: "n3" }]);
        expect(snap.nodes.find((n) => n.id === "n8")!.parent).toBe("n3");
        expect(closedIds(snap)).toEqual(["n5", "n6", "n7"]);
      }));

    it.effect("移動: 済みの論点そのものを別の議題の下へ移すと、それ自身と新しい祖先が話し中に戻る。移動元の議題は済みのまま", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen([{ op: "move", node: "n7", parent: "n1" }]);
        expect(closedIds(snap)).toEqual(["n2", "n3", "n5", "n6"]);
      }));

    it.effect("移動: 同じ親への移動も、起点とその祖先を話し中に戻す", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen([{ op: "move", node: "n4", parent: "n3" }]);
        expect(closedIds(snap)).toEqual(["n5", "n6", "n7"]);
      }));

    it.effect("開き直すのは起点と祖先だけ。済みの議題が話し中に戻っても、配下の済みの論点・子の議題は済みのまま", () =>
      Effect.gen(function* () {
        // n5（n1 の下の済みの論点）は n1 の子孫だが、n5 の下に何かを足したとき n1 は戻り、n2・n3 は戻らない
        const { snap } = yield* reopen((ids) => [{ op: "add", ref: "x", parent: "n5", kind: "案", text: "来週", evidence: [ids[3]![0]!] }]);
        expect(closedIds(snap)).toEqual(["n2", "n3", "n6", "n7"]);
      }));

    it.effect("削除: 済みの論点の下の案を削除しても、元の祖先の済みは変わらない", () =>
      Effect.gen(function* () {
        const { snap } = yield* reopen([{ op: "delete", node: "n8" }]);
        expect(snap.nodes.find((n) => n.id === "n8")).toBeUndefined();
        expect(closedIds(snap)).toEqual(ALL);
      }));

    it.effect("捨てられた操作は開き直さない", () =>
      Effect.gen(function* () {
        const r = yield* replay(tree, noopHand, closeAll, [
          { op: "add", ref: "x", parent: "n3", kind: "案", text: "1 回", evidence: ["r-unknown"] }, // 知らない発言で捨てる
          { op: "update", node: "n4", text: "x", evidence: ["r-unknown"] }, // 捨てる
          { op: "move", node: "n1", parent: "n3" }, // 自分の子孫の下へは移せないので捨てる
        ]);
        expect(r.dropped).toHaveLength(3);
        expect(closedIds(r.snap)).toEqual(ALL);
      }));
  });

  describe("変わったこと・エクスポート", () => {
    it.effect("閉じるだけの反映は round が進むが、変わったことに何も足さない。開き直しを伴う追加は「追加」だけが出る", () =>
      Effect.gen(function* () {
        const { snaps } = yield* replay(
          tree,
          noopHand,
          closeAll,
          (ids) => [{ op: "add", ref: "x", parent: "n3", kind: "案", text: "1 回", evidence: [ids[3]![0]!] }],
        );
        expect(snaps[2]!.round).toBe(3);
        expect(closedIds(snaps[2]!)).toEqual(ALL);
        expect(snaps[2]!.changes).toEqual(snaps[1]!.changes);
        expect(snaps[2]!.changes.filter((c) => c.round === 3)).toEqual([]);
        // 閉じても今の議題は動かない
        expect(snaps[2]!.currentTopic).toBe(snaps[1]!.currentTopic);
        const added = snaps[3]!.changes.filter((c) => c.round === 4);
        expect(added.map((c) => c.change)).toEqual(["追加"]);
        expect(closedIds(snaps[3]!)).toEqual(["n5", "n6", "n7"]);
      }));

    it.effect("エクスポートは済みの議題の中身も含む全ノードを出し、済みの印は出ない。close だけを除いた同じ台本のエクスポートと一致する", () =>
      Effect.gen(function* () {
        const closed = yield* replay(tree, noopHand, closeAll);
        const open = yield* replay(tree, noopHand, noopHand);
        expect(closedIds(closed.snap)).toEqual(ALL);
        const json = yield* closed.session.exportJson;
        // 発言の id と時刻は別々のセッションで違うので、本文と話者だけを残してそろえる
        const norm = <T extends { evidence: readonly { text: string; track: "自分" | "相手" }[]; children: T[] }>(n: T): T =>
          ({ ...n, evidence: n.evidence.map((e) => ({ id: "r", start: 0, end: 0, text: e.text, track: e.track })), children: n.children.map(norm) });
        const files = exportFiles({ root: norm(json.root) });
        const openJson = yield* open.session.exportJson;
        const openFiles = exportFiles({ root: norm(openJson.root) });
        const keys = (nodes: readonly object[]): string[] => nodes.flatMap((n) => [...Object.keys(n), ...("children" in n ? keys(n.children as object[]) : [])]);
        const all = keys([json.root]);
        expect(all).not.toContain("talkStatus");
        expect(JSON.stringify(json)).not.toContain("済み");
        expect(JSON.stringify(json)).toContain("面接は何回か");
        expect(JSON.stringify(json)).toContain("3 回");
        expect(norm(json.root)).toEqual(norm(openJson.root));
        expect(files).toEqual(openFiles);
      }));
  });
});

describe("差分更新の入力に載せる前回の応答（仮 ID の対応と捨てた操作）", () => {
  const failure = (message: string): UpdateFailure => ({ _tag: "UpdateFailed", message });
  const pair = () => [remark("発言"), remark("発言")];

  it.effect("1 回目の入力にはキーが無く、2 回目の入力には、1 回目に適用できた add の対応と捨てた操作が載る", () =>
    Effect.gen(function* () {
      const [a, b, c, d] = [...pair(), ...pair()];
      const dropOp: Op = { op: "add", ref: "u9", parent: "n99", kind: "課題", text: "親が無い", evidence: [a!.id] };
      const first: Op[] = [
        { op: "add", ref: "u1", parent: "root", kind: "議題", text: "送料", evidence: [a!.id] },
        dropOp,
      ];
      const { calls } = yield* playBatches([[a!, b!], [c!, d!]], [first, []]);

      expect(calls).toHaveLength(2);
      expect("previousResponse" in calls[0]!).toBe(false);
      expect(calls[1]!.previousResponse).toEqual({ refs: { u1: "n1" }, dropped: [{ op: dropOp, reason: "親が存在しない" }] });
    }));

  it.effect("載るのは最後に適用した応答の分だけ: 3 回目の入力は 2 回目の応答の対応で、1 回目の対応は残らない", () =>
    Effect.gen(function* () {
      const [a, b, c, d, e, f] = [...pair(), ...pair(), ...pair()];
      const { calls } = yield* playBatches(
        [[a!, b!], [c!, d!], [e!, f!]],
        [
          [{ op: "add", ref: "u1", parent: "root", kind: "議題", text: "一", evidence: [a!.id] }],
          [{ op: "add", ref: "u2", parent: "n1", kind: "論点", text: "二", evidence: [c!.id] }],
          [],
        ],
      );
      expect(calls[2]!.previousResponse).toEqual({ refs: { u2: "n2" }, dropped: [] });
    }));

  it.effect("成功した回の後に失敗した回があると、その次の入力には載らない（失敗した回の応答は適用されていない）", () =>
    Effect.gen(function* () {
      const [a, b, c, d, e, f] = [...pair(), ...pair(), ...pair()];
      const { calls } = yield* playBatches(
        [[a!, b!], [c!, d!], [e!, f!]],
        [
          [{ op: "add", ref: "u1", parent: "root", kind: "議題", text: "一", evidence: [a!.id] }],
          failure("timeout"),
          [],
        ],
      );
      expect(calls).toHaveLength(3);
      expect(calls[1]!.previousResponse).toEqual({ refs: { u1: "n1" }, dropped: [] });
      expect("previousResponse" in calls[2]!).toBe(false);
    }));

  it.effect("1 回目が失敗なら、2 回目の入力にも載らない", () =>
    Effect.gen(function* () {
      const [a, b, c, d] = [...pair(), ...pair()];
      const { calls } = yield* playBatches([[a!, b!], [c!, d!]], [failure("timeout"), []]);
      expect("previousResponse" in calls[1]!).toBe(false);
    }));

  it.effect("add も捨てた操作も無い応答（noop）の後の入力には、キーを付けない", () =>
    Effect.gen(function* () {
      const [a, b, c, d] = [...pair(), ...pair()];
      const { calls } = yield* playBatches([[a!, b!], [c!, d!]], [[{ op: "noop", reason: "雑談" }], []]);
      expect("previousResponse" in calls[1]!).toBe(false);
    }));
});

// Issue #1027: AI が返した話者の名前（names）は、ノードの根拠と同じ消費済みの発言（known）で確かめ、通った名前だけをコールバックで返す。
// 差分更新の応答は names を持ってよい（省略できる）。コールバックは core の外（sink）が名前の表と log.jsonl を更新するための口
describe("話者の名前の確認", () => {
  const spoken = (text: string, speaker: string | undefined, track: "自分" | "相手" = "相手"): Remark => remark(text, { track, ...(speaker !== undefined ? { speaker } : {}) });
  const name = (label: string, evidence: string, who = "田中", basis: InferredSpeakerName["basis"] = "名乗り"): InferredSpeakerName => ({ label, name: who, evidence, basis });

  // 台本の i 番目の応答（ops なしで names だけ）を返す偽の差分更新。processedRemarks も台本で決める
  const withNames = (...script: { names?: InferredSpeakerName[]; processedRemarks?: number }[]) => {
    const calls: DiffInput[] = [];
    const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
      Effect.sync(() => {
        calls.push(input);
        const step = script[calls.length - 1] ?? {};
        return { ops: [], ...(step.names ? { names: step.names } : {}), ...(step.processedRemarks ? { processedRemarks: step.processedRemarks } : {}) };
      });
    return { calls, update };
  };
  // 応答をテストの側から返せる偽の差分更新。i 番目の呼び出しに answers[i] を返す
  const held = (answers: DiffOutput[]) => {
    const calls: DiffInput[] = [];
    const replies: (() => void)[] = [];
    const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
      Effect.callback<DiffOutput, UpdateFailure>((resume) => {
        const answer = answers[calls.length] ?? { ops: [] };
        calls.push(input);
        replies.push(() => resume(Effect.succeed(answer)));
      });
    return { calls, replies, update };
  };
  const received = () => {
    const batches: (readonly InferredSpeakerName[])[] = [];
    return { batches, onSpeakerNames: (names: readonly InferredSpeakerName[]) => Effect.sync(() => void batches.push(names)) };
  };
  const openWith = (update: (input: DiffInput) => Effect.Effect<DiffOutput, UpdateFailure>, onSpeakerNames: (names: readonly InferredSpeakerName[]) => Effect.Effect<void>, events: LogEvent[] = []) =>
    makeSession({ title: "定例", onSpeakerNames }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));

  it.effect("その回で消費した発言を根拠にし、話者がラベルと一致する名前は、コールバックに渡る（基準の種類も渡る）", () =>
    Effect.gen(function* () {
      const intro = spoken("田中です", "相手 B");
      const { update } = withNames({ names: [name("相手 B", intro.id)] });
      const { batches, onSpeakerNames } = received();
      const session = yield* openWith(update, onSpeakerNames);

      yield* session.push(intro);
      yield* session.idle;

      expect(batches).toEqual([[name("相手 B", intro.id)]]);
    }));

  it.effect("前の回で消費した発言を根拠にした名前も通る（known は過去の回の分も含む）", () =>
    Effect.gen(function* () {
      const intro = spoken("田中です", "相手 B");
      const next = spoken("そうですね", "相手 B");
      const { update } = withNames({}, { names: [name("相手 B", intro.id, "田中", "呼びかけへの応答")] });
      const { batches, onSpeakerNames } = received();
      const session = yield* openWith(update, onSpeakerNames);

      yield* session.push(intro);
      yield* session.idle;
      yield* session.push(next);
      yield* session.idle;

      expect(batches).toEqual([[name("相手 B", intro.id, "田中", "呼びかけへの応答")]]);
    }));

  it.effect("根拠の発言が無い・話者がラベルと合わない・自分の発言・ラベルの無い相手の発言を根拠にした名前は捨てる。通る名前だけが渡る", () =>
    Effect.gen(function* () {
      const warmup = spoken("始めます", "相手 A");
      const a = spoken("お願いします", "相手 A");
      const b = spoken("田中です", "相手 B");
      const mine = spoken("田中さんですね", "自分", "自分");
      const bare = spoken("それは来週にしましょう", undefined);
      const { batches, onSpeakerNames } = received();
      const { calls, replies, update } = held([{ ops: [] }, { ops: [], names: [
        name("相手 B", "r999"), // 根拠が無い
        name("相手 B", a.id), // 話者が合わない
        name("自分", mine.id), // 自分には付けない
        name("相手 B", mine.id), // 自分の発言は根拠にならない
        name("相手", bare.id), // ラベルが無い
        name("相手 B", b.id), // 通る
      ] }]);
      const session = yield* openWith(update, onSpeakerNames);

      // 1 件目で呼び出しが始まり、残りは呼び出し中に届いて次の回にまとまる
      yield* session.push(warmup);
      for (const r of [a, b, mine, bare]) yield* session.push(r);
      replies[0]!();
      yield* settleUntil(() => calls.length === 2);
      expect(freshIds(calls[1]!)).toEqual([a.id, b.id, mine.id, bare.id]);
      replies[1]!();
      yield* session.idle;

      expect(batches.flat()).toEqual([name("相手 B", b.id)]);
    }));

  it.effect("まだ消費していない発言（processedRemarks を超えた分）を根拠にした名前は捨てる。話者が合っていても通らない", () =>
    Effect.gen(function* () {
      // 1 件目は単独で呼び出しが始まり、2・3 件目は呼び出し中に届いて次の回にまとまる。次の回は 1 件目（r2）だけ反映する
      const first = spoken("よろしく", "相手 A");
      const second = spoken("佐藤です", "相手 A");
      const third = spoken("田中です", "相手 B");
      const { calls, replies, update } = held([
        { ops: [] },
        { ops: [], processedRemarks: 1, names: [name("相手 A", second.id, "佐藤"), name("相手 B", third.id)] },
      ]);
      const { batches, onSpeakerNames } = received();
      const session = yield* openWith(update, onSpeakerNames);

      yield* session.push(first);
      yield* session.push(second);
      yield* session.push(third);
      replies[0]!();
      yield* settleUntil(() => calls.length === 2);
      expect(freshIds(calls[1]!)).toEqual([second.id, third.id]);
      replies[1]!();
      yield* settleUntil(() => batches.length === 1);

      expect(batches.flat()).toEqual([name("相手 A", second.id, "佐藤")]);
    }));

  it.effect("名前が無い回・通る名前が無い回には、コールバックを呼ばない", () =>
    Effect.gen(function* () {
      const a = spoken("お願いします", "相手 A");
      const b = spoken("はい", "相手 B");
      const { update } = withNames({}, { names: [name("相手 B", a.id)] });
      const { batches, onSpeakerNames } = received();
      const session = yield* openWith(update, onSpeakerNames);

      yield* session.push(a);
      yield* session.idle;
      yield* session.push(b);
      yield* session.idle;

      expect(batches).toEqual([]);
    }));

  it.effect("反映数が不正で失敗した回（processedRemarks が入力の発言数を超える）は、応答に名前があっても使わない", () =>
    Effect.gen(function* () {
      const intro = spoken("田中です", "相手 B");
      const events: LogEvent[] = [];
      const { update } = withNames({ names: [name("相手 B", intro.id)], processedRemarks: 5 });
      const { batches, onSpeakerNames } = received();
      const session = yield* openWith(update, onSpeakerNames, events);

      yield* session.push(intro);
      yield* session.idle;

      expect(events.some((e) => e.type === "diff" && e.error !== undefined)).toBe(true);
      expect(batches).toEqual([]);
    }));

  it.effect("コールバックは diff の行をログに書いた後で呼ぶ（根拠の発言は diff の行より前の remark の行にある）", () =>
    Effect.gen(function* () {
      const intro = spoken("田中です", "相手 B");
      const events: LogEvent[] = [];
      const { update } = withNames({ names: [name("相手 B", intro.id)] });
      const order: string[] = [];
      const session = yield* openWith(update, () => Effect.sync(() => void order.push(`callback after ${events.filter((e) => e.type === "diff").length} diff`)), events);

      yield* session.push(intro);
      yield* session.idle;

      expect(order).toEqual(["callback after 1 diff"]);
    }));

  it.effect("コールバックを渡さないセッション（cli play・復元）では、names を含む応答でも通常どおり反映される", () =>
    Effect.gen(function* () {
      const intro = spoken("田中です", "相手 B");
      const { update } = withNames({ names: [name("相手 B", intro.id)] });
      const events: LogEvent[] = [];
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));

      yield* session.push(intro);
      yield* session.idle;

      expect(events.filter((e) => e.type === "diff")).toHaveLength(1);
    }));
});
