import { Effect, Exit, Scope } from "effect";
import { startup, type ListenOptions, type ServerLayers } from "../../src/server.ts";

// startup（Scope に結んだ Effect）を、テストの Scope の中で呼ぶ。待ち受けているポートと、
// 途中で閉じるための close（Scope を閉じる。テストの終了でも閉じるが、二重に閉じても何もしない）を返す
export const startedServer = (options: ListenOptions, layers: ServerLayers) =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
    const port = yield* Scope.provide(startup(options, layers), scope);
    return { port, close: Scope.close(scope, Exit.void) };
  });
