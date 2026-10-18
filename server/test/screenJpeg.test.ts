import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";
import { fitSize, ScreenJpeg, ScreenJpegFailed } from "../src/screenJpeg.ts";
import { fakeSpawner } from "./fixtures/fakeSpawner.ts";

// fitSize が、縦横の比を保ったまま 1280×720 に収まる大きさを返すこと（拡大はしない）。
// 本物の ScreenJpeg の Layer は、sips が失敗したら ScreenJpegFailed で失敗すること（偽の ChildProcessSpawner。sips は起動しない）
describe("fitSize", () => {
  it.each([
    ["16:9 で大きい", 2560, 1440, 1280, 720],
    ["4:3 は高さで縮める（幅だけで縮めない）", 2000, 1500, 960, 720],
    ["縦長は高さで縮める", 1000, 1800, 400, 720],
    ["小さければそのまま（拡大しない）", 640, 360, 640, 360],
  ])("%s: %i×%i → %i×%i", (_name, width, height, fitWidth, fitHeight) => {
    expect(fitSize(width, height)).toEqual({ width: fitWidth, height: fitHeight });
  });
});

describe("ScreenJpeg.layer（偽の ChildProcessSpawner）", () => {
  const toJpeg = (spawner: ReturnType<typeof fakeSpawner>) =>
    Effect.gen(function* () {
      return yield* (yield* ScreenJpeg).toJpeg("/画像/無い.png");
    }).pipe(Effect.provide(ScreenJpeg.layer.pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})))),
    )));

  it.effect("sips が 0 以外で終わったら ScreenJpegFailed（defect ではない）で失敗し、message に標準エラーが入る", () =>
    Effect.gen(function* () {
      const spawner = fakeSpawner({ code: 1, stderr: "Error: 画像を開けません\n" });
      const result = yield* Effect.result(toJpeg(spawner));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBeInstanceOf(ScreenJpegFailed);
      expect(result.failure.message).toContain("画像を開けません");
      expect(spawner.commands.map(({ command }) => command)).toEqual(["sips"]);
    }));
});
