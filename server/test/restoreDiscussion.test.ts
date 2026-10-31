import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeSession, restoreState, type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { reviewSnapshot } from "../src/core/review.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const spoken = (end: number): Remark => ({ id: `r${end}`, track: "相手", start: end - 1, end, text: "合成の発言です。" });
const point = (ref: string, end: number): Op[] => [{ op: "add", ref, parent: "root", kind: "論点", text: ref, evidence: [`r${end}`] }];
const plans = (parent: string, end: number): Op[] => Array.from({ length: 3 }, (_, i) => ({ op: "add", ref: `a${end}-${i}`, parent, kind: "案", text: `案${end}-${i}`, evidence: [`r${end}`] }));
const script: Record<number, Op[]> = {
  1: point("p", 1),
  200: plans("n1", 200),
  700: [{ op: "add", ref: "d", parent: "n1", kind: "決定", text: "採用", evidence: ["r700"] }],
  800: [{ op: "delete", node: "n5" }],
  1000: point("q", 1000),
  1200: plans("n6", 1200),
  1500: plans("n1", 1500),
};

const recorded = Effect.fnUntraced(function* () {
  const events: LogEvent[] = [];
  let ops: Op[] = [];
  const session = yield* makeSession({ title: "合成会議" }).pipe(Effect.provide(Layer.merge(collectLog(events), updaterLayer(() => Effect.succeed({ ops })))));
  for (const end of [1, 200, 650, 700, 800, 1000, 1200, 1500]) {
    ops = script[end] ?? [];
    yield* session.push(spoken(end));
    yield* session.idle;
  }
  yield* session.push({ ...spoken(1700), duplicate: true });
  yield* session.idle;
  return events.map((event): unknown => JSON.parse(JSON.stringify(event)));
});

const diarization = (at: number): unknown[] => [
  ...Array.from({ length: 30 }, (_, slot) => ({ at, type: "speaker", track: "相手", start: at, end: at + 1, slot, final: slot % 2 === 0 })),
  { at, type: "speaker-settled", track: "相手", to: at },
  { at, type: "speaker-centroid", track: "相手", slot: 0, centroid: [0.1, 0.2] },
  { at, type: "vocab", words: ["語"] },
];

describe("話者分離や通知を挟むログの復元", () => {
  it.effect("話者分離のイベントを挟んでも、論点の期間と通知の済みを含めて同じ状態に戻る", () => Effect.gen(function* () {
    const events = yield* recorded();
    expect(events.flatMap((event) => (event as LogEvent).type === "discussion-notice" ? [(event as { at: number }).at] : [])).toEqual([650, 1500]);
    const plain = yield* restoreState(events);
    const interleaved = yield* restoreState(events.flatMap((event, i) => [...diarization(i), event]));
    expect(interleaved).toEqual(plain);
    expect(plain.discussion).toEqual({
      lastAt: 1500,
      points: new Map([
        ["n1", { status: "active", origin: "reopened", since: 800, baseline: new Set(["n2", "n3", "n4", "n5"]), children: new Set(["n2", "n3", "n4", "n5", "n10", "n11", "n12"]), notified: true, readyAt: 1500 }],
        ["n6", { status: "active", origin: "evidence", since: 999, baseline: new Set(), children: new Set(["n7", "n8", "n9"]), notified: false, readyAt: 1700 }],
      ]),
    });
    expect(reviewSnapshot(events.flatMap((event, i) => [event, ...diarization(i)]))).toEqual(reviewSnapshot(events));
  }));
});
