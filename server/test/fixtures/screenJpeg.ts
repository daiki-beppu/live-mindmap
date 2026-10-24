import { readFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { ScreenJpeg, ScreenJpegFailed } from "../../src/screenJpeg.ts";

export const FAKE_JPEG_PREFIX = "jpeg:";
export const fakeJpegBytes = (pngContent: string): Uint8Array => new TextEncoder().encode(FAKE_JPEG_PREFIX + pngContent);

export type FakeScreenJpeg = {
  layer: Layer.Layer<ScreenJpeg>;
  calls: string[];
};

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
