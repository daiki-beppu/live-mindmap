import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { makeSession, playback, restoreSession, type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const spoken = (end: number): Remark => ({ id: `r${end}`, track: "相手", start: end - 1, end, text: "検討を続けます。" });
const proposals = (end: number, count: number): Op[] => Array.from({ length: count }, (_, i) => ({ op: "add", ref: `a${end}-${i}`, parent: "n1", kind: "案", text: `案${i}`, evidence: [`r${end}`] }));
const notices = (events: readonly LogEvent[]) => events.filter((event) => event.type === "discussion-notice");

function operations(status: "決定済み" | "済み", end: number, count: number): Op[] {
  if (end === 101) return [{ op: "add", ref: "p", parent: "root", kind: "論点", text: "進め方", evidence: ["r101"] }];
  if (end === 700) return proposals(end, 3);
  if (end === 800) return status === "済み" ? [{ op: "close", node: "n1" }] : [{ op: "add", ref: "d", parent: "n1", kind: "決定", text: "採用", evidence: ["r800"] }];
  if (end !== 1000) return [];
  return [
    ...(status === "決定済み" ? [{ op: "delete", node: "n5" } satisfies Op] : []),
    { op: "update", node: "n1", evidence: ["r1000"] }, ...proposals(end, count),
  ];
}

const scenario = Effect.fnUntraced(function* (status: "決定済み" | "済み", overlap: boolean, partial: boolean, count: number) {
  const events: LogEvent[] = [];
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const layer = Layer.merge(collectLog(events), updaterLayer((input) => Effect.gen(function* () {
    const end = input.fresh[0]!.end;
    if (end === (partial ? 900 : 1000)) {
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
    }
    return { ops: operations(status, end, count), processedRemarks: 1 };
  })));
  const session = yield* makeSession({ title: "再開時刻" }).pipe(Effect.provide(layer));
  for (const end of [101, 700, 701, 702, 800]) {
    yield* session.push(spoken(end));
    yield* session.idle;
  }
  expect(notices(events)).toHaveLength(1);
  expect((yield* session.snapshot).nodes.find((node) => node.id === "n1")).toHaveProperty(status === "済み" ? "talkStatus" : "pointStatus", status);
  if (partial) {
    yield* session.push(spoken(900));
    yield* Deferred.await(started);
    yield* session.push(spoken(1000));
    yield* session.push(spoken(1001));
    yield* Deferred.succeed(release, undefined);
    yield* session.idle;
  } else if (!overlap) {
    const playing = yield* playback(session, [spoken(1000), spoken(1001)], { sleep: () => session.idle }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(playing);
  } else {
    yield* session.push(spoken(1000));
    yield* Deferred.await(started);
    yield* session.push(spoken(1001));
    yield* Deferred.succeed(release, undefined);
    yield* session.idle;
  }
  const recorded: unknown[] = events.map((event) => JSON.parse(JSON.stringify(event)));
  const restoredEvents: LogEvent[] = [];
  const restored = yield* restoreSession(recorded).pipe(Effect.provide(Layer.merge(collectLog(restoredEvents), updaterLayer(() => Effect.succeed({ ops: [] })))));
  expect(restoredEvents).toEqual([]);
  for (const [target, output, previous] of [[session, events, 1], [restored, restoredEvents, 0]] as const) {
    yield* target.push(spoken(1599)); yield* target.idle;
    expect(notices(output)).toHaveLength(previous);
    yield* target.push(spoken(1600)); yield* target.idle;
    yield* target.push(spoken(1700)); yield* target.idle;
  }
  const expected = count === 3 ? [{ pointId: "n1", at: 1600 }] : [];
  expect(notices(events).slice(1).map(({ pointId, at }) => ({ pointId, at }))).toEqual(expected);
  expect(notices(restoredEvents).map(({ pointId, at }) => ({ pointId, at }))).toEqual(expected);
  for (const event of events) if (event.type === "diff") { expect(event.dropped).toEqual([]); expect(event.error).toBeUndefined(); }
  if (partial) expect(events.filter((event) => event.type === "diff").some((event) => event.input.fresh.length === 2 && event.processedRemarks === 1)).toBe(true);
});

describe("差分自身の会議時刻で再開期間を確定する", () => {
  for (const status of ["決定済み", "済み"] as const) {
    it.effect.each([false, true])(`${status}から再開し、1001秒の先行受信=%sでも復元後も1600秒に再通知する`, (overlap) => scenario(status, overlap, false, 3));
    it.effect(`${status}から部分反映で再開しても未反映の1001秒を起点にしない`, () => scenario(status, true, true, 3));
    it.effect(`${status}から再開しても新しい子2件では通知しない`, () => scenario(status, true, false, 2));
  }
});
