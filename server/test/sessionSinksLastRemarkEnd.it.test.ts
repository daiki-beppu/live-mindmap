import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { defaultClaude } from "../src/modelSelection.ts";
import { DiffUpdater } from "../src/core/index.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// 起動し直す録画のヘルパーに渡す開始位置（--from）の元になる値。サーバーが「最後に作った発言」の end を SessionSink が持つ。
// 想定する契約: `sink.lastRemarkEnds: Effect<Partial<Record<Track, number>>>` は、settling が作った（emit した）発言の end の最大値をトラックごとに返す。
// 作った発言が無いトラックのキーは無い。溜まり（backlog）で未反映の発言と、2 本録画の並べ替え（trackMerge）で保留中の発言も、作った発言に数える。

const fileIo = trackedFileSystem();
const { settle } = fileIo;

const SPEAKER_OFF = { type: "speaker-off", start: 0, reason: "モデルなし" } as const;

// 1 回目の差分更新だけ、gate が開くまで終わらない偽の DiffUpdater
const gatedUpdater = (gate: Deferred.Deferred<void>) =>
  Layer.succeed(
    DiffUpdater,
    DiffUpdater.of({
      update: () => Deferred.await(gate).pipe(Effect.as({ ops: [] })),
      katakana: (words) => Effect.succeed(words.map((surface) => ({ surface, katakana: surface }))),
    }),
  );

const openRecorded = Effect.fn("openRecorded")(function* (updaterLayer: Layer.Layer<DiffUpdater>, selfTrack: boolean) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-last-remark-end-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(root);
  const sink = yield* sinks.open({
    dir, title: "録画", model: defaultClaude, updaterLayer: yield* sinks.prepare(defaultClaude),
    publish: () => Effect.void, speak: () => Effect.void, diffUpdate: () => Effect.void,
    recorded: { realtime: false, selfTrack, progress: () => Effect.void, paused: () => Effect.void },
  });
  yield* sink.speaker(SPEAKER_OFF);
  return sink;
});

const layerFor = (updaterLayer: Layer.Layer<DiffUpdater>) =>
  SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer) }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer })));

describe("SessionSink.lastRemarkEnds（録画: 最後に作った発言の end）", () => {
  it.effect("作った発言が無いうちは空（途中結果だけでは、まだ発言を作っていない）", () => {
    const gate = Effect.runSync(Deferred.make<void>());
    return Effect.scoped(Effect.gen(function* () {
      const sink = yield* openRecorded(gatedUpdater(gate), false);
      expect(yield* sink.lastRemarkEnds).toEqual({});
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "とちゅう", duplicate: false });
      yield* settle;
      expect(yield* sink.lastRemarkEnds).toEqual({});
    })).pipe(Effect.provide(layerFor(gatedUpdater(gate))));
  });

  it.effect("溜まりに止まっていてセッションにまだ入っていない発言も、作った発言として数える（差分更新が終わらない間に 3 発言を作る）", () => {
    const gate = Effect.runSync(Deferred.make<void>());
    return Effect.scoped(Effect.gen(function* () {
      const sink = yield* openRecorded(gatedUpdater(gate), false);
      yield* sink.final({ track: "相手", start: 590, end: 600, text: "一つ目" });
      yield* sink.final({ track: "相手", start: 600, end: 660, text: "二つ目" });
      yield* sink.final({ track: "相手", start: 700, end: 750, text: "三つ目" });
      yield* settle;
      // 1 回目の差分更新が終わっていないので、2・3 つ目は溜まりの中
      expect(yield* sink.lastRemarkEnds).toEqual({ 相手: 750 });
      yield* Deferred.succeed(gate, undefined);
      yield* sink.drain;
      yield* sink.finishBacklog;
      expect(yield* sink.lastRemarkEnds).toEqual({ 相手: 750 });
    })).pipe(Effect.provide(layerFor(gatedUpdater(gate))));
  });

  it.effect("drain が確定していない途中結果を発言にした分も数える（drain の前は確定した分の end、後は drain が発言にした分の end）", () => {
    const gate = Effect.runSync(Deferred.make<void>());
    return Effect.scoped(Effect.gen(function* () {
      const sink = yield* openRecorded(gatedUpdater(gate), false);
      yield* sink.final({ track: "相手", start: 590, end: 600, text: "確定済み" });
      yield* sink.partial({ track: "相手", start: 760, end: 770, text: "確定していない", duplicate: false });
      yield* settle;
      expect(yield* sink.lastRemarkEnds).toEqual({ 相手: 600 });
      yield* sink.drain;
      expect(yield* sink.lastRemarkEnds).toEqual({ 相手: 770 });
      yield* Deferred.succeed(gate, undefined);
      yield* sink.finishBacklog;
    })).pipe(Effect.provide(layerFor(gatedUpdater(gate))));
  });

  it.effect("2 本の録画で、トラックごとの end の最大値を返す（end の小さい 自分 も落とさない）。並べ替えで保留中の発言も数える", () => {
    const gate = Effect.runSync(Deferred.make<void>());
    return Effect.scoped(Effect.gen(function* () {
      const sink = yield* openRecorded(gatedUpdater(gate), true);
      // 相手 の end 10 の後に 自分 の end 6 を作る
      yield* sink.final({ track: "相手", start: 8, end: 10, text: "相手の発言" });
      yield* sink.final({ track: "自分", start: 5, end: 6, text: "自分の発言" });
      yield* settle;
      expect(yield* sink.lastRemarkEnds).toEqual({ 相手: 10, 自分: 6 });
      yield* Deferred.succeed(gate, undefined);
      yield* sink.drain;
      yield* sink.finishBacklog;
      expect(yield* sink.lastRemarkEnds).toEqual({ 相手: 10, 自分: 6 });
    })).pipe(Effect.provide(layerFor(gatedUpdater(gate))));
  });
});
