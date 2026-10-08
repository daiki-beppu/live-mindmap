import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { ScreenJpeg, ScreenJpegFailed } from "../src/screenJpeg.ts";

// 本物の ScreenJpeg（macOS の sips）が、PNG を 1280×720 に収まる JPEG にすること。
// sips は macOS にしか無く、CI は ubuntu なので、macOS のときだけ走らせる（それ以外は skip）。
// CI で走るテストは偽の ScreenJpeg を使う（fixtures/screenJpeg.ts）。

const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

// 単色の RGB の PNG を作る
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8bit・RGB・標準の圧縮・フィルタ・インターレースなし
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// JPEG の SOF マーカーから寸法を読む
function jpegSize(data: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(data);
  expect([view[0], view[1]]).toEqual([0xff, 0xd8]);
  let i = 2;
  while (i + 9 < view.length) {
    if (view[i] !== 0xff) throw new Error("JPEG のマーカーが壊れている");
    const marker = view[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.readUInt16BE(i + 5), width: view.readUInt16BE(i + 7) };
    }
    i += 2 + view.readUInt16BE(i + 2);
  }
  throw new Error("JPEG の SOF が見つからない");
}

const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-jpeg-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

const toJpeg = (path: string) =>
  Effect.gen(function* () {
    const converter = yield* ScreenJpeg;
    return yield* converter.toJpeg(path);
  }).pipe(Effect.provide(ScreenJpeg.layer.pipe(Layer.provide(NodeServices.layer))));

describe.skipIf(process.platform !== "darwin")("ScreenJpeg の実物の Layer（sips）", () => {
  const cases: [name: string, width: number, height: number][] = [
    ["16:9 で大きい PNG は 1280×720 に縮む", 2560, 1440],
    ["4:3 の PNG も高さが 720 を超えない（幅だけで縮めない）", 2000, 1500],
    ["縦長の PNG も 1280×720 に収まる", 1000, 1800],
    ["小さい PNG はそのまま収まる", 640, 360],
  ];
  for (const [name, width, height] of cases) {
    it.live(name, () =>
      Effect.gen(function* () {
        const dir = yield* directory;
        const path = join(dir, "s.png");
        writeFileSync(path, png(width, height));
        const bytes = yield* toJpeg(path);
        const size = jpegSize(bytes);
        expect(size.width).toBeLessThanOrEqual(1280);
        expect(size.height).toBeLessThanOrEqual(720);
        // 縦横の比は保つ（丸めの 1 ピクセル分は許す）
        expect(Math.abs(size.width / size.height - width / height)).toBeLessThan(0.02);
      }).pipe(Effect.scoped));
  }

  it.live("画像が読めなければ ScreenJpegFailed で失敗する（defect ではない）", () =>
    Effect.gen(function* () {
      const dir = yield* directory;
      const result = yield* Effect.result(toJpeg(join(dir, "無い.png")));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBeInstanceOf(ScreenJpegFailed);
      expect(result.failure.message).not.toBe("");
    }).pipe(Effect.scoped));
});
