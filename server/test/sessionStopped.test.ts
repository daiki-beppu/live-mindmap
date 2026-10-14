import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DiffUpdater, LogEvent, makeSession, restoreState, type DiffInput, type Remark, type Session } from "../src/core/index.ts";
import { fakeAppleLifecycle, waitForDiffState } from "./fixtures/appleLifecycle.ts";
import { collectLog, settleUntil, updaterLayer } from "./fixtures/sessionLayers.ts";

const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}。` });
const ids = (remarks: readonly Remark[]) => remarks.map((r) => r.id);
// 発言 1 件を push して、その呼び出しが終わるまで待つ（差分更新は呼び出し中でなければ発言 1 件ですぐ呼ばれる）
const pushOne = Effect.fnUntraced(function* (session: Session, n: number) {
  yield* session.push(remark(n));
  yield* session.idle;
});

describe("同じ Session の差分更新停止", () => {
  it.effect("停止タグの後は新着・時間経過・flushで更新せず、既存マップと新着の記録を保持する", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 1 ? Effect.succeed({ ops: [{ op: "add", ref: "topic", parent: "root", kind: "議題", text: "採用", evidence: ids(input.fresh) }] })
          : Effect.fail({ _tag: "DiffUpdateStopped", message: "合成の再起動上限" });
      })), collectLog(events),
    )));
    yield* pushOne(session, 1);
    const before = yield* session.snapshot;
    const beforeExport = yield* session.exportJson;
    expect(before.nodes.map((n) => n.text)).toContain("採用");
    yield* pushOne(session, 2);
    expect(yield* session.diffUpdate).toEqual({ status: "stopped" });
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r2"]);
    yield* session.push(remark(3));
    yield* session.push(remark(4));
    yield* TestClock.adjust(3_600_000);
    yield* session.idle;
    yield* session.push(remark(5));
    yield* session.push(remark(6));
    yield* session.flush;
    expect(calls).toHaveLength(2);
    expect((yield* session.snapshot).nodes).toEqual(before.nodes);
    expect((yield* session.snapshot).changes).toEqual(before.changes);
    expect(yield* session.exportJson).toEqual(beforeExport);
    expect(events.filter((e) => e.type === "remark").map((e) => e.remark.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r2", "r3", "r4", "r5", "r6"]);
  }));

  it.effect("再起動中の通常失敗は消費し、状態を上書きせず、復帰後は新着だけを反映する", () => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([{}, { holdReady: true }]);
    const events: LogEvent[] = [];
    const updater = yield* DiffUpdater.pipe(Effect.provide(yield* fake.prepare));
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      Layer.succeed(DiffUpdater, DiffUpdater.of({ ...updater, update: (input) => Effect.suspend(() => { calls.push(input); return updater.update(input); }) })),
      collectLog(events),
    )));
    yield* pushOne(session, 1);
    const before = yield* session.snapshot;
    expect(before.nodes.some((n) => n.text === "面接官は3人")).toBe(true);
    yield* fake.crash(0);
    yield* waitForDiffState(session, "restarting");
    expect(yield* session.diffUpdate).toEqual({ status: "restarting" });
    const requests = fake.requests.length;
    yield* pushOne(session, 2);
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1"], ["r2"]]);
    expect(fake.requests).toHaveLength(requests);
    expect(yield* session.unreflectedRemarks).toEqual([]);
    expect(yield* session.diffUpdate).toEqual({ status: "restarting" });
    expect((yield* session.snapshot).nodes).toEqual(before.nodes);
    expect(events.flatMap((e) => e.type === "diff" && e.error !== undefined ? [e.input.fresh] : [])).toEqual([["r2"]]);
    yield* fake.releaseReady(1);
    yield* waitForDiffState(session, "running");
    expect(yield* session.diffUpdate).toEqual({ status: "running" });
    yield* pushOne(session, 3);
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(ids(calls[2]!.recent)).toContain("r2");
    for (const event of events) yield* Schema.decodeUnknownEffect(LogEvent)(JSON.parse(JSON.stringify(event)));
    const restored = yield* restoreState(events.map((e) => JSON.parse(JSON.stringify(e)) as unknown));
    expect(ids(restored.processed)).toEqual(["r1", "r2", "r3"]);
    expect(restored.pending).toEqual([]);
  }));

  it.effect.each([200, 500])("発言のない間に停止を受け、待っていた HTTP %s の完了でも停止が解除されない", (status) => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([{}, { holdReady: true }, { holdReady: true }, { holdReady: true }]);
    const events: LogEvent[] = [];
    const layer = yield* fake.prepare;
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(layer, collectLog(events))));
    yield* pushOne(session, 1);
    expect((yield* session.snapshot).round).toBe(1);
    for (let i = 0; i < 3; i++) {
      yield* fake.crash(i);
      yield* settleUntil(() => fake.processes.length === i + 2);
      expect(fake.processes).toHaveLength(i + 2);
      yield* waitForDiffState(session, "restarting");
      expect(yield* session.diffUpdate).toEqual({ status: "restarting" });
      yield* fake.releaseReady(i + 1);
      yield* waitForDiffState(session, "running");
      expect(yield* session.diffUpdate).toEqual({ status: "running" });
    }
    const gate = yield* Deferred.make<void>();
    fake.control.holdResponse = gate;
    fake.control.status = status;
    const count = fake.requests.length;
    yield* session.push(remark(3));
    yield* settleUntil(() => fake.requests.length > count);
    expect(fake.requests).toHaveLength(count + 1);
    yield* fake.crash(3);
    yield* waitForDiffState(session, "stopped");
    expect(yield* session.diffUpdate).toEqual({ status: "stopped" });
    yield* Deferred.succeed(gate, undefined);
    yield* session.idle;
    expect(yield* session.diffUpdate).toEqual({ status: "stopped" });
    yield* session.push(remark(4));
    yield* TestClock.adjust(3_600_000);
    yield* session.flush;
    expect(fake.requests).toHaveLength(count + 1);
    expect(ids(yield* session.unreflectedRemarks)).toContain("r4");
    expect((yield* session.exportJson).root.children.length).toBeGreaterThan(0);
  }));
});
