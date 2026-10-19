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

// settlingがdrainで作った発言も、sinkの再起動位置へ届く結合だけをここで確かめる。

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

const openRecorded = Effect.fn("openRecorded")(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-last-remark-end-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(root);
  const sink = yield* sinks.open({
    dir, title: "録画", model: defaultClaude, updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer,
    publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void, diffUpdate: () => Effect.void,
    recorded: { realtime: false, selfTrack: false, progress: () => Effect.void, paused: () => Effect.void },
  });
  yield* sink.speaker(SPEAKER_OFF);
  return sink;
});

const layerFor = (updaterLayer: Layer.Layer<DiffUpdater>) =>
  SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer }) }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer })));

describe("SessionSink.lastRemarkEnds（録画: 最後に作った発言の end）", () => {
  it.effect("drain が確定していない途中結果を発言にした分も数える（drain の前は確定した分の end、後は drain が発言にした分の end）", () => {
    const gate = Effect.runSync(Deferred.make<void>());
    return Effect.scoped(Effect.gen(function* () {
      const sink = yield* openRecorded();
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
});
