import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Stream } from "effect";
import { depsDirConfig } from "../src/config.ts";
import { ManagedDeps } from "../src/managedDeps.ts";
import { exitNaturally } from "../src/exitNaturally.ts";

Effect.gen(function* () {
  const root = yield* depsDirConfig;
  yield* Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    yield* Stream.runForEach(deps.install(process.argv.slice(2)), (event) =>
      event.type === "progress" ? Console.error(event.message) : Console.log(JSON.stringify(event.items)));
  }).pipe(Effect.provide(ManagedDeps.layer({ root })));
}).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ teardown: exitNaturally }),
);
