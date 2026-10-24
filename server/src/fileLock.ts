import { dirname } from "node:path";
import { Effect, FileSystem, type PlatformError } from "effect";

export const withFileLock = <A, E, R>(path: string, action: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const acquire: Effect.Effect<void, PlatformError.PlatformError> = Effect.suspend(() =>
    fs.makeDirectory(lock, { mode: 0o700 }).pipe(
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.andThen(Effect.sleep(10), acquire)),
    ));
  yield* Effect.acquireRelease(
    acquire.pipe(Effect.timeout("30 seconds")),
    () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
  );
  return yield* action;
}).pipe(Effect.scoped);
