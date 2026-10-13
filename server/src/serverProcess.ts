// 常駐サーバーの PID の記録と、cli server stop が止める相手を決める規則。
// サーバーは待ち受けたポートごとに PID を書き、Scope を閉じる（きれいに終わる）ときに消す。
// 記録は SIGKILL などで残ることがあり、その PID が別のプロセスに使い回されていることもある。だから記録だけを信じて
// シグナルを送らない。送るのは、そのポートで応答したサーバー自身が名乗った PID だけにする（planServerStop）。
import { dirname, join, resolve } from "node:path";
import { Context, Effect, FileSystem, Predicate, Schema } from "effect";

export const serverPidPath = (sessionsDir: string, port: number): string =>
  join(`${resolve(sessionsDir)}.server`, `${port}.pid`);

// PID の記録を書き、Scope を閉じるときに消す（別の起動が書き換えていたら消さない）。
// 消せなくても終了は失敗にしない（残った記録は cli server stop が古い記録として扱う）
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

// 記録の PID。記録が無ければ undefined。中身が PID でなければ BrokenServerPid
export const readServerPid = Effect.fnUntraced(function* (sessionsDir: string, port: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = serverPidPath(sessionsDir, port);
  const text = yield* fs.readFileString(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
  if (text === undefined) return undefined;
  return yield* Schema.decodeEffect(RecordedPid)(text.trim()).pipe(Effect.mapError(() => new BrokenServerPid({ path })));
});

// 古い記録を消す（もう無ければ何もしない）
export const removeServerPid = Effect.fnUntraced(function* (sessionsDir: string, port: number) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(serverPidPath(sessionsDir, port)).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
});

export type ServerStopPlan =
  // そのポートで応答したサーバーが名乗った PID。これだけにシグナルを送る
  | { readonly action: "terminate"; readonly pid: number }
  // 応答が無く、記録も無いか、記録の PID のプロセスがもう無い（stale はその古い記録の PID）
  | { readonly action: "not-running"; readonly stale: number | undefined }
  // 応答が無いのに、記録の PID のプロセスは生きている。固まったサーバーか、PID を使い回した別のプロセスか見分けられないので送らない
  | { readonly action: "unresponsive"; readonly pid: number };

// reported: ポートで応答したサーバーが名乗った PID（応答が無ければ undefined）。recorded: 記録の PID。recordedAlive: その PID のプロセスがあるか
export const planServerStop = (input: { reported: number | undefined; recorded: number | undefined; recordedAlive: boolean }): ServerStopPlan => {
  if (input.reported !== undefined) return { action: "terminate", pid: input.reported };
  if (input.recorded === undefined) return { action: "not-running", stale: undefined };
  if (!input.recordedAlive) return { action: "not-running", stale: input.recorded };
  return { action: "unresponsive", pid: input.recorded };
};

// プロセスの有無の確認と SIGTERM。既定は本物の process.kill。テストは偽物を渡す
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
    // もう終わっていた（ESRCH）なら何もしない
    terminate: (pid: number): Effect.Effect<void> => Effect.sync(() => {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (!(Predicate.hasProperty(error, "code") && error.code === "ESRCH")) throw error;
      }
    }),
  }),
});
