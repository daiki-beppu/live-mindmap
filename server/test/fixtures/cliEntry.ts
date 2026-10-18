import { Effect, Layer } from "effect";
import { reportFailure, runCli, teardown } from "../../src/cli.ts";
import { consoleCapture } from "../benchRun.ts";

export const runCliEntry = Effect.fnUntraced(function* <R, E, RIn>(argv: string[], layer: Layer.Layer<R, E, RIn>) {
  const captured = consoleCapture();
  const exit = yield* runCli(argv).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(Layer.mergeAll(layer, captured.layer)),
    Effect.exit,
  );
  // teardown は同期処理なので、他の呼び出しが終了コードを使う前に復元できる。
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    teardown(exit, () => { throw new Error("自然終了する必要があります"); });
    return { code: Number(process.exitCode ?? 0), stdout: captured.stdout.join(""), stderr: captured.stderr.join("") };
  } finally {
    process.exitCode = saved;
  }
});
