import { Context, Effect, Layer } from "effect";
import { DiffUpdater, SessionLog, type DiffInput, type DiffResult, type LogEvent } from "../../src/core/index.ts";

export type UpdateFailure = { readonly _tag: string; readonly message: string; readonly judge?: { readonly model: string; readonly ms: number; readonly confidence?: number; readonly failure?: string } };

export const updaterLayer = (update: (input: DiffInput) => Effect.Effect<DiffResult, UpdateFailure>) =>
  Layer.succeed(DiffUpdater, DiffUpdater.of({ update }));

export const logLayer = (
  write: (event: LogEvent) => Effect.Effect<void>,
  writeScreen: (file: string, bytes: Uint8Array) => Effect.Effect<void> = () => Effect.void,
  readScreen: (file: string) => Effect.Effect<Uint8Array> = (file) => Effect.die(`readScreen は使わない: ${file}`),
) => Layer.succeed(SessionLog, SessionLog.of({ write, writeScreen, readScreen }));

export const collectLog = (events: LogEvent[], screens?: { file: string; bytes: Uint8Array }[], reads?: string[]) => {
  const files = new Map<string, Uint8Array>();
  return logLayer(
    (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    (file, bytes) =>
      Effect.sync(() => {
        files.set(file, bytes);
        screens?.push({ file, bytes });
      }),
    (file) =>
      Effect.suspend(() => {
        reads?.push(file);
        const bytes = files.get(file);
        return bytes ? Effect.succeed(bytes) : Effect.die(`書いていない画像を読んだ: ${file}`);
      }),
  );
};

export const silentLog = logLayer(() => Effect.void);

export const forbiddenUpdater = updaterLayer(() => Effect.die("差分更新は呼べません"));

export const settleUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !condition(); i++) yield* Effect.yieldNow;
  });

export class TestUpdaterLayer extends Context.Service<TestUpdaterLayer, Layer.Layer<DiffUpdater>>()("live-mindmap/test/TestUpdaterLayer") {}
