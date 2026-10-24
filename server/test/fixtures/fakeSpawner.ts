import { Effect, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export type FakeProcess =
  | { readonly code: number; readonly stdout?: string; readonly stderr?: string }
  | { readonly spawnFailure: "NotFound" };

const text = (value: string | undefined) => (value === undefined ? Stream.empty : Stream.succeed(new TextEncoder().encode(value)));

export function fakeSpawner(behavior: FakeProcess) {
  const commands: ChildProcess.StandardCommand[] = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("偽の spawner は単一のコマンドだけを扱う");
      commands.push(command);
      if ("spawnFailure" in behavior) {
        return Effect.fail(PlatformError.systemError({ _tag: behavior.spawnFailure, module: "ChildProcessSpawner", method: "spawn" }));
      }
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4243),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(behavior.code)),
        isRunning: Effect.succeed(false), kill: () => Effect.void,
        stdin: Sink.drain, stdout: text(behavior.stdout),
        stderr: text(behavior.stderr), all: Stream.empty,
        getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
      }));
    }),
  );
  return { layer, commands };
}
