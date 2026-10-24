import { Context, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { STDERR_TAIL_LINES, tailLines } from "./core/index.ts";

export const SCREEN_MAX_WIDTH = 1280;
export const SCREEN_MAX_HEIGHT = 720;

const make = Effect.fnUntraced(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;

  const readText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));

  const sips = (args: readonly string[]): Effect.Effect<string, ScreenJpegFailed | PlatformError.PlatformError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make("sips", [...args], { stdin: "ignore" }));
        const [stdout, stderr, code] = yield* Effect.all([readText(handle.stdout), readText(handle.stderr), handle.exitCode], { concurrency: "unbounded" });
        if (code === 0) return stdout;
        const reason = tailLines(`${stderr}\n${stdout}`, STDERR_TAIL_LINES).join("\n").trim();
        return yield* new ScreenJpegFailed({ message: reason || `sips が終了コード ${code} で終わりました` });
      }),
    );

  const sizeOf = Effect.fnUntraced(function* (path: string) {
    const out = yield* sips(["-g", "pixelWidth", "-g", "pixelHeight", path]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
    if (!(width > 0 && height > 0)) return yield* new ScreenJpegFailed({ message: `画像の大きさを読めません: ${path}` });
    return { width, height };
  });

  const toJpeg = (path: string): Effect.Effect<Uint8Array, ScreenJpegFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const size = yield* sizeOf(path);
        const fit = fitSize(size.width, size.height);
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "live-mindmap-jpeg-" });
        const out = `${dir}/screen.jpg`;
        const resize = fit.width === size.width && fit.height === size.height ? [] : ["-z", String(fit.height), String(fit.width)];
        yield* sips(["-s", "format", "jpeg", ...resize, "--out", out, path]);
        return yield* fs.readFile(out);
      }),
    ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new ScreenJpegFailed({ message: error.message }))));

  return ScreenJpeg.of({ toJpeg });
});

export class ScreenJpegFailed extends Schema.TaggedError<ScreenJpegFailed>()("ScreenJpegFailed", { message: Schema.String }) {}

export class ScreenJpeg extends Context.Service<ScreenJpeg, {
  readonly toJpeg: (path: string) => Effect.Effect<Uint8Array, ScreenJpegFailed>;
}>()("live-mindmap/server/ScreenJpeg") {
  static readonly layer: Layer.Layer<ScreenJpeg, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> = Layer.effect(ScreenJpeg)(make());
}

export function fitSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, SCREEN_MAX_WIDTH / width, SCREEN_MAX_HEIGHT / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
