import { Deferred, Effect, FileSystem, Layer, Sink, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner, type ChildProcess } from "effect/process";
import { AppleIntelligence } from "../../src/appleIntelligence.ts";
import { prepareUpdaterLayer } from "../../src/diffUpdater.ts";
import type { DiffUpdateState, Session } from "../../src/core/index.ts";
import { classification, fakeChatgptHttp, jsonRequestBody } from "./chatgpt.ts";

export const appleModel = { name: "apple", route: "apple", local: true } as const;
type ProcessScript = { holdReady?: boolean; invalidReady?: boolean };

export const fakeAppleLifecycle = Effect.fnUntraced(function* (scripts: readonly ProcessScript[]) {
  const processes: {
    url: string;
    ready: Deferred.Deferred<void>;
    exited: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
    closed: boolean;
  }[] = [];
  const control: { holdResponse?: Deferred.Deferred<void>; status: number } = { status: 200 };
  const http = fakeChatgptHttp((request) => Effect.gen(function* () {
    if (control.holdResponse) yield* Deferred.await(control.holdResponse);
    const body = jsonRequestBody(request) as { response_format: { json_schema: { schema: { properties: { 文: { maxItems: number } } } } } };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(classification(
      Array.from({ length: body.response_format.json_schema.schema.properties.文.maxItems }, () => ({ 種類: "説明", text: "面接官は3人" })),
    )) } }] }), { status: control.status, headers: { "content-type": "application/json" } });
  }));
  const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    const mode = (command as ChildProcess.StandardCommand).args.at(-1);
    const ready = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const script = scripts[processes.length];
    const process = { url: `http://127.0.0.1:${8766 + processes.length}/v1`, ready, exited, closed: false };
    const availability = mode === "availability";
    if (availability || !script?.holdReady) yield* Deferred.succeed(ready, undefined);
    if (availability) yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
    else processes.push(process);
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      process.closed = true;
      yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
    }));
    const text = availability
      ? JSON.stringify({ osVersion: "27.0", availability: { status: "available" } })
      : script?.invalidReady ? "invalid-ready"
      : JSON.stringify({ type: "ready", url: process.url, contextSize: 8192 });
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242 + processes.length - (availability ? 0 : 1)),
      exitCode: Deferred.await(exited),
      isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
      kill: () => Effect.asVoid(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
      stdin: Sink.drain,
      stdout: Stream.fromEffect(Effect.as(Deferred.await(ready), new TextEncoder().encode(text + "\n"))),
      stderr: Stream.empty, all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  })));
  const apple = AppleIntelligence.layer({ command: "fake-apple", args: [] }).pipe(Layer.provide(spawner));
  const deps = Layer.mergeAll(apple, Layer.succeed(HttpClient.HttpClient, http.client),
    Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})));
  return {
    processes, control, requests: http.requests, deps,
    prepare: prepareUpdaterLayer(appleModel).pipe(Effect.provide(deps)),
    crash: (index: number) => Deferred.succeed(processes[index]!.exited, ChildProcessSpawner.ExitCode(1)),
    releaseReady: (index: number) => Deferred.succeed(processes[index]!.ready, undefined),
  };
});

// 条件がそろうまで待つ。そろわなければ黙って戻らず失敗する（CI の負荷では 200 回の yield で状態や配信が届き切らないことがあった）。
// 実ファイルの書き込みや配信を挟む IT もあるので、yield の後は実時間（TestClock に依らない setTimeout）で最大 5 秒待つ
export const waitUntil = Effect.fnUntraced(function* (condition: () => boolean | Effect.Effect<boolean>, label: string) {
  const check = () => { const result = condition(); return typeof result === "boolean" ? Effect.succeed(result) : result; };
  for (let i = 0; i < 200; i++) {
    if (yield* check()) return;
    yield* Effect.yieldNow;
  }
  for (let i = 0; i < 1000; i++) {
    if (yield* check()) return;
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
  return yield* Effect.die(new Error(`待っていた状態になりませんでした: ${label}`));
});

export const waitForDiffState = (session: Session, status: DiffUpdateState["status"]) =>
  waitUntil(() => Effect.map(session.diffUpdate, (state) => state.status === status), `差分更新の状態が ${status}`);
