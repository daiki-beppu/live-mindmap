import { readFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { ScreenJpeg, ScreenJpegFailed } from "../../src/screenJpeg.ts";

// 偽の変換が返すバイト列は、PNG（テストが書いた小さなファイル）の中身の前に印を付けたもの。
// 本物の JPEG ではないが、どの画像ファイルから変換したかをバイト列から読み戻せる
export const FAKE_JPEG_PREFIX = "jpeg:";
export const fakeJpegBytes = (pngContent: string): Uint8Array => new TextEncoder().encode(FAKE_JPEG_PREFIX + pngContent);

export type FakeScreenJpeg = {
  layer: Layer.Layer<ScreenJpeg>;
  // 変換を頼まれた画像のパス（呼ばれた順）
  calls: string[];
};

// 変換の Service の偽物。画像ファイルが読めなければ ScreenJpegFailed、読めれば fakeJpegBytes の形で返す
export function fakeScreenJpeg(): FakeScreenJpeg {
  const calls: string[] = [];
  const layer = Layer.succeed(ScreenJpeg, ScreenJpeg.of({
    toJpeg: (path) => {
      calls.push(path);
      return Effect.tryPromise({
        try: async () => fakeJpegBytes(await readFile(path, "utf8")),
        catch: (e) => new ScreenJpegFailed({ message: e instanceof Error ? e.message : String(e) }),
      });
    },
  }));
  return { layer, calls };
}
