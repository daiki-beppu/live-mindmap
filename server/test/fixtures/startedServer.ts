import { Effect, Exit, Scope } from "effect";
import { startup, type ListenOptions, type ServerLayers } from "../../src/server.ts";
import { unusedViewing } from "./tunnel.ts";

// startup（Scope に結んだ Effect）を、テストの Scope の中で呼ぶ。待ち受けているポートと、
// 途中で閉じるための close（Scope を閉じる。テストの終了でも閉じるが、二重に閉じても何もしない）を返す。
// viewing（Tunnel と閲覧の口の画面のビルド）を渡さないテストには、使われたら die する Layer を補う（本物の cloudflared は起動しない）
export const startedServer = (options: ListenOptions, layers: Omit<ServerLayers, "viewing"> & Partial<Pick<ServerLayers, "viewing">>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
    const port = yield* Scope.provide(startup(options, { viewing: unusedViewing, ...layers }), scope);
    return { port, close: Scope.close(scope, Exit.void) };
  });
