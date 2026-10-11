import { Context, Effect, Layer } from "effect";
import { DiffUpdater, type DiffInput, type DiffResult, type DiffUpdateError } from "../../src/core/index.ts";

// ../src/claude.ts の偽物（vi.mock の factory が返すモジュール）。diffUpdater.ts が動的に import して読む layerClaude と AgentSdk の形だけを持つ。
// open は updater を 1 つ開く（開いた回数を数える・update や close の中身を差し替える入口）。layer の build で 1 回呼び、Scope を閉じると close を呼ぶ。
// 偽物の updater は SDK を使わないが、準備は AgentSdk の Service を取得する。
export type FakeOpenedUpdater = { update: (input: DiffInput) => Effect.Effect<DiffResult, DiffUpdateError>; close: () => void };

class AgentSdk extends Context.Service<AgentSdk, {
  readonly query: typeof import("@anthropic-ai/claude-agent-sdk")["query"];
}>()("live-mindmap/server/AgentSdk") {
  static readonly layer = Layer.succeed(AgentSdk, AgentSdk.of({ query: () => { throw new Error("偽の updater は query を呼びません"); } }));
}

export const fakeClaudeModule = (open: () => FakeOpenedUpdater) => ({
  layerClaude: (_model: string) => Layer.effect(
    DiffUpdater,
    Effect.gen(function* () {
      const opened = yield* Effect.acquireRelease(
        Effect.sync(open),
        (updater) => Effect.sync(() => updater.close()),
      );
      return DiffUpdater.of({
        update: (input) => opened.update(input),
      });
    }),
  ),
  AgentSdk,
});
