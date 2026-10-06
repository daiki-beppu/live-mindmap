// ツールチェーンの確認用（#194）。`node src/effectProbe.ts` で strip-types のまま動くか
import { spawn, type ChildProcess } from "node:child_process";
import { Data, Duration, Effect, Exit, Fiber, Scope } from "effect";
import { Clock2, stamp } from "./core/effectProbe.ts";

class SpawnFailed extends Data.TaggedError("SpawnFailed")<{ readonly cause: unknown }> {}

/** 子プロセスを Scope に結びつける。Scope が閉じたら SIGTERM、graceMs で終わらなければ SIGKILL */
export const spawnScoped = (cmd: string, args: ReadonlyArray<string>, graceMs = 5_000) =>
  Effect.acquireRelease(
    Effect.callback<ChildProcess, SpawnFailed>((resume) => {
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.once("spawn", () => resume(Effect.succeed(child)));
      child.once("error", (cause) => resume(Effect.fail(new SpawnFailed({ cause }))));
    }),
    (child) => terminate(child, graceMs),
  );

export const waitExit = (child: ChildProcess) =>
  Effect.callback<number | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) return resume(Effect.succeed(child.exitCode));
    child.once("exit", (code) => resume(Effect.succeed(code)));
  });

export const terminate = (child: ChildProcess, graceMs: number) =>
  Effect.gen(function* () {
    if (child.exitCode !== null || child.signalCode !== null) return "already" as const;
    child.kill("SIGTERM");
    const exited = yield* waitExit(child).pipe(Effect.timeoutOption(Duration.millis(graceMs)));
    if (exited._tag === "Some") return "SIGTERM" as const;
    child.kill("SIGKILL");
    yield* waitExit(child);
    return "SIGKILL" as const;
  });

const main = Effect.gen(function* () {
  const stamped = yield* stamp({ speaker: "self", text: "hello" }).pipe(Effect.provide(Clock2.fixed(1)));
  console.log("stamp:", JSON.stringify(stamped));

  // SIGTERM を無視する子を、猶予 300ms で閉じる
  const scope = yield* Scope.make();
  const child = yield* spawnScoped(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], 300).pipe(
    Scope.provide(scope),
  );
  yield* Effect.sleep("200 millis"); // 子が SIGTERM のハンドラを付けるのを待つ
  const fiber = yield* Effect.forkDetach(waitExit(child));
  yield* Scope.close(scope, Exit.void);
  console.log("killed by:", child.signalCode, "exit fiber:", yield* Fiber.join(fiber));
});

if (import.meta.main) Effect.runPromise(main).then(
  () => console.log("ok", process.version),
  (e) => {
    console.error("failed", e);
    process.exit(1);
  },
);
