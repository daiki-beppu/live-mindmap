// PROTOTYPE（issue #197）: Helpers の本物の Layer。node:child_process・node:net・ws を Effect に包む。
// `effect/process`（ChildProcess の killSignal・forceKillAfter）は @stability unstable なので使わず、安定した API だけで包む形。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Cause, Deferred, Effect, Layer, Queue } from "effect";
import { WebSocket } from "ws";
import { Helpers, PortUnavailable, SocketNotOpen, type ExitInfo, type Helper } from "./helperLifecycle.ts";

const freePort = Effect.callback<number, PortUnavailable>((resume) => {
  const probe = createServer();
  probe.once("error", (cause) => resume(Effect.fail(new PortUnavailable({ cause }))));
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (!address || typeof address === "string") return resume(Effect.fail(new PortUnavailable({ cause: address })));
    probe.close(() => resume(Effect.succeed(address.port)));
  });
  return Effect.sync(() => probe.close()); // 待っている間に中断されたとき
});

const spawnHelper = (command: string, prefix: ReadonlyArray<string>) => (args: ReadonlyArray<string>) =>
  Effect.sync((): Helper => {
    const child = spawn(command, [...prefix, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    const exited = Deferred.makeUnsafe<ExitInfo>();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr += chunk.toString();
    });
    // "exit" ではなく "close"（stderr の最後の data を取りこぼさない。今の launchHelper と同じ理由）
    child.once("close", (code, signal) => Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })));
    child.once("error", (e) => {
      stderr += String(e);
      Deferred.doneUnsafe(exited, Effect.succeed({ code: null, signal: null }));
    });
    return { exited, kill: (signal) => Effect.sync(() => void child.kill(signal)), stderr: Effect.sync(() => stderr) };
  });

const connectOnce = (port: number) =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<string, Cause.Done>();
    yield* Effect.acquireRelease(
      Effect.callback<WebSocket, SocketNotOpen>((resume) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("message", (data) => Queue.offerUnsafe(messages, String(data)));
        ws.once("close", () => Queue.endUnsafe(messages));
        ws.once("open", () => resume(Effect.succeed(ws)));
        ws.once("error", () => {
          ws.terminate();
          resume(Effect.fail(new SocketNotOpen()));
        });
        return Effect.sync(() => ws.terminate());
      }),
      (ws) => Effect.sync(() => ws.terminate()),
      { interruptible: true },
    );
    return messages as Queue.Dequeue<string, Cause.Done>;
  });

export const nodeHelpersLayer = (helper: { command: string; args: ReadonlyArray<string> }) =>
  Layer.succeed(Helpers, Helpers.of({ freePort, spawn: spawnHelper(helper.command, helper.args), connectOnce }));
