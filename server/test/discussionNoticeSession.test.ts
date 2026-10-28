import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { exportFiles, makeSession, nextDiscussionNotice, playback, restoreSession, restoreState, type LogEvent, type Op, type Remark, type Session } from "../src/core/index.ts";
import { embedReviewLog, mapOnlyReviewEvents, reviewSnapshot } from "../src/core/review.ts";
import { embeddedText, TEMPLATE } from "./fixtures/review.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const spoken = (end: number): Remark => ({ id: `r${end}`, track: "相手", start: end - 1, end, text: "合成の発言です。" });
const point = (ref: string, end: number): Op => ({ op: "add", ref, parent: "root", kind: "論点", text: ref, evidence: [`r${end}`] });
const plans = (parent: string, count: number, end: number): Op[] => Array.from({ length: count }, (_, i) => ({
  op: "add", ref: `a${parent}-${end}-${i}`, parent, kind: "案", text: `案${end}-${i}`, evidence: [`r${end}`],
}));
const notices = (events: readonly LogEvent[]) => events.filter((event) => event.type === "discussion-notice");

const open = Effect.fnUntraced(function* (criteria: readonly string[]) {
  const events: LogEvent[] = [];
  let nextOps: Op[] = [];
  const layer = Layer.merge(collectLog(events), updaterLayer(() => Effect.succeed({ ops: nextOps })));
  const session = yield* makeSession({ title: "合成会議", criteria }).pipe(Effect.provide(layer));
  const advance = Effect.fnUntraced(function* (target: Session, end: number, ops: Op[]) {
    nextOps = ops;
    yield* target.push(spoken(end));
    yield* target.idle;
    const diff = events.filter((event) => event.type === "diff").at(-1);
    expect(diff).toMatchObject({ dropped: [] });
    expect(diff).not.toHaveProperty("error");
  });
  const resume = (rows: Iterable<unknown>) => restoreSession(rows).pipe(Effect.provide(layer));
  return { session, events, advance, resume };
});

describe("堂々巡りの通知をセッションから記録する", () => {
  it.effect.each([false, true])("初回期間に古い根拠を統合=%sで通知の起点を更新し、同じログから復元する", (combine) => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 1, [point("A", 1)]);
    yield* advance(session, 301, [point("B", 301)]);
    yield* advance(session, 400, plans("n2", 3, 400));
    expect(notices(events)).toHaveLength(0);
    yield* advance(session, 601, combine ? [{ op: "combine", from: "n1", into: "n2" }] : []);
    const expected = { type: "discussion-notice", pointId: "n2", at: 601, text: "「B」が 10 分決まっていません。何を重視して決めるかを先に確かめませんか" };
    expect(notices(events)).toEqual(combine ? [expected] : []);
    const prefix = events.slice(0, events.findLastIndex((event) => event.type === "diff") + 1);
    const restored = yield* restoreState(prefix.map((event) => JSON.parse(JSON.stringify(event))));
    expect(nextDiscussionNotice(restored.discussion, restored.map, 601, [])).toEqual(combine ? expected : undefined);
    if (combine) {
      const notified = yield* restoreState(events.map((event) => JSON.parse(JSON.stringify(event))));
      expect(nextDiscussionNotice(notified.discussion, notified.map, 901, [])).toBeUndefined();
      yield* advance(session, 901, []);
      expect(notices(events)).toEqual([expected]);
    } else {
      yield* advance(session, 900, []);
      expect(notices(events)).toEqual([{ ...expected, at: 900 }]);
    }
  }));

  it.effect("発言の受信と差分完了が重なっても同じ通知を二重に記録しない", () => Effect.gen(function* () {
    const events: LogEvent[] = [];
    const completing = yield* Deferred.make<void>();
    const session = yield* makeSession({ title: "合成会議" }).pipe(Effect.provide(Layer.merge(
      collectLog(events), updaterLayer((input) => input.map.order.length === 1
        ? Effect.succeed({ ops: [point("進め方", 101), ...plans("進め方", 3, 101)] })
        : Effect.as(Deferred.await(completing), { ops: [] })),
    )));
    yield* session.push(spoken(101));
    yield* session.idle;
    yield* Effect.all([session.push(spoken(700)), session.push(spoken(701))], { concurrency: "unbounded" });
    yield* Deferred.succeed(completing, undefined);
    yield* session.idle;
    expect(notices(events)).toHaveLength(1);
    const restoredEvents: LogEvent[] = [];
    const restored = yield* restoreSession(events.map((event) => JSON.parse(JSON.stringify(event)))).pipe(Effect.provide(Layer.merge(
      collectLog(restoredEvents), updaterLayer(() => Effect.succeed({ ops: [] })),
    )));
    yield* restored.push(spoken(1400));
    yield* restored.idle;
    expect(notices(restoredEvents)).toHaveLength(0);
  }));
  it.effect("子が3件増えても599秒では出さず、子が増えない次の発言で600秒に達すると出す", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 200, plans("n1", 3, 200));
    yield* advance(session, 699, []);
    expect(notices(events)).toHaveLength(0);
    yield* advance(session, 700, []);
    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]).toHaveProperty("text", "「進め方」が 10 分決まっていません。何を重視して決めるかを先に確かめませんか");
  }));

  it.effect("600秒経っても子2件では出さず、3件目が増えた差分の反映後に出す", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 700, plans("n1", 2, 700));
    expect(notices(events)).toHaveLength(0);
    yield* advance(session, 701, plans("n1", 1, 701));
    expect(notices(events)).toHaveLength(1);
  }));

  it.effect("壁時計だけを進めても通知せず、発言時刻が進むと通知する", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 200, plans("n1", 3, 200));
    yield* TestClock.adjust("1 hour");
    yield* session.idle;
    expect(notices(events)).toHaveLength(0);
    yield* advance(session, 700, []);
    expect(notices(events)).toHaveLength(1);
  }));

  it.effect("判断軸を全件、開始時に渡した順序で通知する", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open(["運用負荷", "採用のしやすさ", "費用"]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 700, plans("n1", 3, 700));
    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]).toHaveProperty("text", "「進め方」が 10 分決まっていません。判断軸「運用負荷」「採用のしやすさ」「費用」で決められそうですか");
  }));

  it.effect("通知行に論点IDと発言から決まる会議時刻を保存する", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 700, plans("n1", 3, 700));
    const recorded = notices(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ pointId: "n1", at: 700 });
  }));

  it.effect("同じ論点は発言と案が増えても同じ期間に再通知しない", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 700, plans("n1", 3, 700));
    expect(notices(events)).toHaveLength(1);
    yield* advance(session, 1400, plans("n1", 3, 1400));
    yield* advance(session, 2000, []);
    expect(notices(events)).toHaveLength(1);
  }));

  it.effect.each(["決定済み", "済み"] as const)("%sの論点は通知せず、再開してから新たに10分と子3件を満たすと通知する", (status) => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 200, plans("n1", 3, 200));
    yield* advance(session, 201, []);
    yield* advance(session, 202, []);
    yield* advance(session, 300, status === "済み"
      ? [{ op: "close", node: "n1" }]
      : [{ op: "add", ref: "決定", parent: "n1", kind: "決定", text: "採用する", evidence: ["r300"] }]);
    expect((yield* session.snapshot).nodes.find((node) => node.id === "n1")).toHaveProperty(status === "済み" ? "talkStatus" : "pointStatus", status);
    yield* advance(session, 700, []);
    expect(notices(events)).toHaveLength(0);
    yield* advance(session, 800, status === "済み"
      ? [{ op: "update", node: "n1", evidence: ["r800"] }]
      : [{ op: "delete", node: "n5" }]);
    yield* advance(session, 1399, plans("n1", 2, 1399));
    expect(notices(events)).toHaveLength(0);
    yield* advance(session, 1400, plans("n1", 1, 1400));
    expect(notices(events)).toHaveLength(1);
  }));

  it.effect.each(["決定済み", "済み"] as const)("通知を復元後に%sを経て再開すると、過去の子と時間を使わず再通知できる", (status) => Effect.gen(function* () {
    const { session, events, advance, resume } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 700, plans("n1", 3, 700));
    expect(notices(events)).toHaveLength(1);
    const restored = yield* resume(events.map((event) => JSON.parse(JSON.stringify(event))));
    yield* advance(restored, 701, []);
    yield* advance(restored, 702, []);
    yield* advance(restored, 800, status === "済み"
      ? [{ op: "close", node: "n1" }]
      : [{ op: "add", ref: "決定", parent: "n1", kind: "決定", text: "採用する", evidence: ["r800"] }]);
    expect((yield* restored.snapshot).nodes.find((node) => node.id === "n1")).toHaveProperty(status === "済み" ? "talkStatus" : "pointStatus", status);
    yield* advance(restored, 1000, [
      ...(status === "決定済み" ? [{ op: "delete", node: "n5" } satisfies Op] : []),
      { op: "update", node: "n1", evidence: ["r1000"] },
    ]);
    yield* advance(restored, 1599, plans("n1", 2, 1599));
    expect(notices(events)).toHaveLength(1);
    yield* advance(restored, 1600, []);
    expect(notices(events)).toHaveLength(1);
    yield* advance(restored, 1601, plans("n1", 1, 1601));
    expect(notices(events)).toHaveLength(2);
  }));

  it.effect("同時に条件を満たした別の論点は299秒待ち、子が増えない300秒後の発言で通知する", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101), point("導入時期", 101)]);
    yield* advance(session, 700, [...plans("n1", 3, 700), ...plans("n2", 3, 700)]);
    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]).toHaveProperty("text", "「進め方」が 10 分決まっていません。何を重視して決めるかを先に確かめませんか");
    yield* advance(session, 999, []);
    expect(notices(events)).toHaveLength(1);
    yield* advance(session, 1000, []);
    expect(notices(events)).toHaveLength(2);
    expect(notices(events)[1]).toHaveProperty("text", "「導入時期」が 15 分決まっていません。何を重視して決めるかを先に確かめませんか");
  }));

  it.effect("通知した実ログをJSON経由で復元し、再通知を抑止しながら待機中の別論点は時刻どおりに出す", () => Effect.gen(function* () {
    const { session, events, advance, resume } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101), point("導入時期", 101)]);
    yield* advance(session, 700, [...plans("n1", 3, 700), ...plans("n2", 3, 700)]);
    expect(notices(events)).toHaveLength(1);
    const saved: unknown[] = events.map((event) => JSON.parse(JSON.stringify(event)));
    const restored = yield* resume(saved);
    expect(notices(events)).toHaveLength(1);
    yield* advance(restored, 999, []);
    expect(notices(events)).toHaveLength(1);
    yield* advance(restored, 1000, []);
    expect(notices(events)).toHaveLength(2);
    expect(notices(events)[1]).toHaveProperty("text", "「導入時期」が 15 分決まっていません。何を重視して決めるかを先に確かめませんか");
    yield* advance(restored, 1600, []);
    expect(notices(events)).toHaveLength(2);
  }));

  it.effect("通知行のない既存ログを復元し、継続した発言で初めて通知する", () => Effect.gen(function* () {
    const { session, events, advance, resume } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 200, plans("n1", 3, 200));
    const restored = yield* resume(events.map((event) => JSON.parse(JSON.stringify(event))));
    expect(notices(events)).toHaveLength(0);
    yield* advance(restored, 700, []);
    expect(notices(events)).toHaveLength(1);
  }));

  it.effect("待ち時間を省いた再生でも発言時刻から同じ通知を記録する", () => Effect.gen(function* () {
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "合成会議" }).pipe(Effect.provide(Layer.merge(
      collectLog(events),
      updaterLayer((input) => Effect.succeed({ ops: input.fresh.flatMap((remark) =>
        remark.end === 101 ? [point("進め方", 101)] : remark.end === 200 ? plans("n1", 3, 200) : []) })),
    )));
    yield* playback(session, [spoken(101), spoken(200), spoken(699), spoken(700)], { sleep: () => Effect.void });
    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]).toHaveProperty("text", "「進め方」が 10 分決まっていません。何を重視して決めるかを先に確かめませんか");
  }));

  it.effect("通知のあるセッションのJSON・Markdown・見返しには通知情報を含めない", () => Effect.gen(function* () {
    const { session, events, advance } = yield* open([]);
    yield* advance(session, 101, [point("進め方", 101)]);
    yield* advance(session, 700, plans("n1", 3, 700));
    expect(notices(events)).toHaveLength(1);
    const withoutNotice = events.filter((event) => !notices([event]).length);
    expect(JSON.parse(embeddedText(embedReviewLog(TEMPLATE, events)))).toEqual(withoutNotice);
    expect(reviewSnapshot(mapOnlyReviewEvents(events))).toEqual(reviewSnapshot(mapOnlyReviewEvents(withoutNotice)));
    expect(mapOnlyReviewEvents(events)).toEqual(mapOnlyReviewEvents(withoutNotice));
    const restored = yield* restoreSession(withoutNotice).pipe(Effect.provide(Layer.merge(collectLog([]), updaterLayer(() => Effect.succeed({ ops: [] })))));
    expect(yield* session.snapshot).toEqual(yield* restored.snapshot);
    expect(exportFiles(yield* session.exportJson)).toEqual(exportFiles(yield* restored.exportJson));
  }));
});
