import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { Effect, FileSystem } from "effect";

export const MODEL_TRANSFER_HEADER = "x-live-mindmap-model-token";
export const modelTransferTokenPath = (sessionsDir: string, port: number): string =>
  join(`${resolve(sessionsDir)}.model-transfer`, `${port}.token`);

export const makeModelTransferToken = (): string => randomBytes(32).toString("hex");

export const matchesModelTransferToken = (expected: string, received: string | undefined): boolean => {
  if (!received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const publishModelTransferToken = Effect.fnUntraced(function* (sessionsDir: string, port: number, token: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = modelTransferTokenPath(sessionsDir, port);
  const directory = dirname(path);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  // rename まで読取側に見せず、古い起動のファイルが残っていても完全な値だけを公開する。
  const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: "publish-" });
  const pending = join(temporary, "token");
  yield* fs.writeFileString(pending, token, { mode: 0o600, flag: "wx" });
  yield* Effect.acquireRelease(
    fs.rename(pending, path),
    () => Effect.gen(function* () {
      const current = yield* fs.readFileString(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
      if (current === token) yield* fs.remove(path);
    }).pipe(Effect.orDie),
  );
});

export const readModelTransferToken = Effect.fnUntraced(function* (sessionsDir: string, port: number) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(modelTransferTokenPath(sessionsDir, port));
});
