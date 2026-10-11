import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, Queue, Stream, type Cause } from "effect";
import { Helpers, type HelperExitInfo } from "../../src/helpers.ts";
import { SessionSinks } from "../../src/sessionSinks.ts";
import type { SpeakingFrame } from "../../src/core/index.ts";
import { appleModel, fakeAppleLifecycle } from "./appleLifecycle.ts";
import { fakeExportServices } from "./exportServices.ts";
import { forbiddenManagedDeps } from "./forbiddenManagedDeps.ts";
import { startedServer } from "./startedServer.ts";

export const appleLiveServer = Effect.fnUntraced(function* () {
  const dir = yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-apple-live-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })));
  const fake = yield* fakeAppleLifecycle([{}, { holdReady: true }]);
  const events = yield* Queue.make<string, Cause.Done>();
  const helpers = Layer.succeed(Helpers, Helpers.of({ apps: Effect.succeed([]), launch: () => Effect.gen(function* () {
    const ended = yield* Deferred.make<HelperExitInfo>();
    const stop = Effect.asVoid(Effect.andThen(Queue.end(events), Deferred.succeed(ended, { code: null, signal: "SIGTERM" })));
    yield* Effect.addFinalizer(() => stop);
    return { events: Stream.fromQueue(events) as Stream.Stream<string>, stop, exit: Deferred.await(ended), stderrTail: Effect.succeed([]) };
  }) }));
  const speaking = yield* Deferred.make<(frame: SpeakingFrame) => Effect.Effect<void>>();
  const realSinks = SessionSinks.layer<never>({ prepareUpdater: () => fake.prepare }).pipe(Layer.provide(fakeExportServices()));
  const sinks = Layer.effect(SessionSinks)(Effect.gen(function* () {
    const service = yield* SessionSinks;
    return SessionSinks.of({ ...service, open: (args) => service.open(args).pipe(
      Effect.tap(() => Deferred.succeed(speaking, args.speak)),
    ) });
  })).pipe(Layer.provide(realSinks));
  const server = yield* startedServer({ port: 0, sessionsDir: dir }, { helpers, sessionSinks: sinks, managedDeps: forbiddenManagedDeps });
  const post = (path: string, body: unknown) => Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { ...server, fake,
    start: post("/session/start", { app: "us.zoom.xos", audio: false, screen: false, model: appleModel }),
    stop: post("/session/stop", {}),
    emit: (event: object) => Queue.offer(events, JSON.stringify(event)),
    speak: (frame: SpeakingFrame) => Effect.flatMap(Deferred.await(speaking), (send) => send(frame)),
  };
});
