import { writeFileSync } from "node:fs";
import { NodeFileSystem } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer } from "effect";
import { CaptureFailed, MapCapture } from "../../src/capture.ts";
import type { Snapshot } from "../../src/core/index.ts";
import { ReviewBuild, ReviewPageFailed } from "../../src/review.ts";
import { fakeAudioMix, type FakeMix } from "./audioMix.ts";

// 見返し用の HTML は、書き出し（ログの読み込み・埋め込み・書き込み）は本物で、Vite のビルドだけ偽物にする
export const FAKE_TEMPLATE = "<!doctype html><html><body></body></html>";

// 終了時の書き出しが文脈から受け取る Service（MapCapture・ReviewBuild・AudioMix・FileSystem）の偽物の Layer。
// 通常のテストでは、テストごとに Chromium を起動しないよう、撮影は空のファイルを書くだけにする
export type ExportServicesOptions = {
  capture?: (snapshot: Snapshot, path: string) => Effect.Effect<void, CaptureFailed>;
  build?: () => Effect.Effect<string, ReviewPageFailed>;
  mix?: FakeMix;
  fileSystem?: Layer.Layer<FileSystem.FileSystem>; // 省略時は実物（NodeFileSystem）
};

export const fakeExportServices = ({ capture, build, mix = fakeAudioMix(), fileSystem = NodeFileSystem.layer }: ExportServicesOptions = {}) =>
  Layer.mergeAll(
    Layer.succeed(MapCapture, MapCapture.of({ capture: capture ?? ((_snapshot, path) => Effect.sync(() => writeFileSync(path, ""))) })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: build ?? (() => Effect.succeed(FAKE_TEMPLATE)) })),
    mix.layer,
  ).pipe(Layer.provideMerge(fileSystem));

// 失敗の文面は、警告の「…を書き出せませんでした: <理由>」にそのまま出る
export const failingCapture = (message = "撮影に失敗") => () => Effect.fail(new CaptureFailed({ message }));
export const failingBuild = (message = "ビルドに失敗") => () => Effect.fail(new ReviewPageFailed({ message }));

// Console.error に出た行をためる Console（警告の観測）。Layer ではなく Service の値で返し、Effect.provideService(Console.Console, …) で渡す
export const collectingConsole = () => {
  const errors: string[] = [];
  const service: Console.Console = { ...console, error: (...args: unknown[]) => { errors.push(args.map(String).join(" ")); } };
  return { errors, service };
};
