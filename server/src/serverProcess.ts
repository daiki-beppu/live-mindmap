import { dirname, join, resolve } from "node:path";
import { Context, Effect, FileSystem, Predicate, Schema } from "effect";

export const serverPidPath = (sessionsDir: string, port: number): string =>
  join(`${resolve(sessionsDir)}.server`, `${port}.pid`);

export const publishServerPid = Effect.fnUntraced(function* (sessionsDir: string, port: number, pid: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = serverPidPath(sessionsDir, port);
  yield* fs.makeDirectory(dirname(path), { recursive: true });
  yield* Effect.acquireRelease(
    fs.writeFileString(path, `${pid}\n`),
    () => Effect.gen(function* () {
      const current = yield* fs.readFileString(path);
      if (current.trim() === String(pid)) yield* fs.remove(path);
    }).pipe(Effect.ignore),
  );
});

export class BrokenServerPid extends Schema.TaggedError<BrokenServerPid>()("BrokenServerPid", { path: Schema.String }) {
  override get message(): string {
    return `サーバーの PID の記録が読めません: ${this.path}（サーバーが動いていなければ消してよい）`;
  }
}

const RecordedPid = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

export const readServerPid = Effect.fnUntraced(function* (sessionsDir: string, port: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = serverPidPath(sessionsDir, port);
  const text = yield* fs.readFileString(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
  if (text === undefined) return undefined;
  return yield* Schema.decodeEffect(RecordedPid)(text.trim()).pipe(Effect.mapError(() => new BrokenServerPid({ path })));
});

export const removeServerPid = Effect.fnUntraced(function* (sessionsDir: string, port: number) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(serverPidPath(sessionsDir, port)).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
});

export type ServerStopPlan =
  | { readonly action: "terminate"; readonly pid: number }
  | { readonly action: "not-running"; readonly stale: number | undefined }
  | { readonly action: "unresponsive"; readonly pid: number };

export const planServerStop = (input: { reported: number | undefined; recorded: number | undefined; recordedAlive: boolean }): ServerStopPlan => {
  if (input.reported !== undefined) return { action: "terminate", pid: input.reported };
  if (input.recorded === undefined) return { action: "not-running", stale: undefined };
  if (!input.recordedAlive) return { action: "not-running", stale: input.recorded };
  return { action: "unresponsive", pid: input.recorded };
};

export const ServerProcess = Context.Reference("live-mindmap/ServerProcess", {
  defaultValue: () => ({
    // シグナル 0 は届くかだけを確かめる。EPERM は「あるが自分のものではない」なので、あるとみなす
    alive: (pid: number): Effect.Effect<boolean> => Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return Predicate.hasProperty(error, "code") && error.code === "EPERM";
      }
    }),
    terminate: (pid: number): Effect.Effect<void> => Effect.sync(() => {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (!(Predicate.hasProperty(error, "code") && error.code === "ESRCH")) throw error;
      }
    }),
  }),
});
