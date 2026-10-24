import { writeFileSync } from "node:fs";
import { NodeFileSystem } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer } from "effect";
import { CaptureFailed, MapCapture } from "../../src/capture.ts";
import type { Snapshot } from "../../src/core/index.ts";
import { ReviewBuild, ReviewPageFailed } from "../../src/review.ts";
import { fakeAudioMix, type FakeMix } from "./audioMix.ts";
import { fakeReadings, type FakeReadings } from "./readings.ts";

export const FAKE_TEMPLATE = "<!doctype html><html><body></body></html>";

export type ExportServicesOptions = {
  capture?: (snapshot: Snapshot, path: string) => Effect.Effect<void, CaptureFailed>;
  build?: Effect.Effect<string, ReviewPageFailed>;
  mix?: FakeMix;
  readings?: FakeReadings;
  fileSystem?: Layer.Layer<FileSystem.FileSystem>;
};

export const fakeExportServices = ({ capture, build, mix = fakeAudioMix(), readings = fakeReadings(), fileSystem = NodeFileSystem.layer }: ExportServicesOptions = {}) =>
  Layer.mergeAll(
    Layer.succeed(MapCapture, MapCapture.of({ capture: capture ?? ((_snapshot, path) => Effect.sync(() => writeFileSync(path, ""))) })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: build ?? Effect.succeed(FAKE_TEMPLATE) })),
    mix.layer,
    readings.layer,
  ).pipe(Layer.provideMerge(fileSystem));

export const failingCapture = (message = "撮影に失敗") => () => Effect.fail(new CaptureFailed({ message }));
export const failingBuild = (message = "ビルドに失敗") => Effect.fail(new ReviewPageFailed({ message }));

export const collectingConsole = () => {
  const errors: string[] = [];
  const service: Console.Console = { ...console, error: (...args: unknown[]) => { errors.push(args.map(String).join(" ")); } };
  return { errors, service };
};
