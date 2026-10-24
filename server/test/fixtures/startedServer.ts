import { Effect, Exit, Scope } from "effect";
import { startup, type ListenOptions, type ServerLayers } from "../../src/server.ts";
import { unusedViewing } from "./tunnel.ts";

export const startedServer = (options: ListenOptions, layers: Omit<ServerLayers, "viewing"> & Partial<Pick<ServerLayers, "viewing">>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
    const port = yield* Scope.provide(startup(options, { viewing: unusedViewing, ...layers }), scope);
    return { port, close: Scope.close(scope, Exit.void) };
  });
