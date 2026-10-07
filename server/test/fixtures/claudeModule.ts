import { Effect, Layer } from "effect";
import { DiffUpdater, type DiffInput, type DiffOutput } from "../../src/core/index.ts";

// ../src/claude.ts の偽物（vi.mock の factory が返すモジュール）。diffUpdater.ts が動的に import して読む ClaudeDiffUpdater と AgentSdk の形だけを持つ。
// open は updater を 1 つ開く（開いた回数を数える・update や close の中身を差し替える入口）。layer の build で 1 回呼び、Scope を閉じると close を呼ぶ。
// 偽物は Agent SDK を使わないので、AgentSdk.layer は空の Layer
export type FakeOpenedUpdater = { update: (input: DiffInput) => Promise<DiffOutput>; close: () => void };

export const fakeClaudeModule = (open: () => FakeOpenedUpdater) => ({
  ClaudeDiffUpdater: {
    layer: Layer.effect(
      DiffUpdater,
      Effect.gen(function* () {
        const opened = yield* Effect.acquireRelease(
          Effect.sync(open),
          (updater) => Effect.sync(() => updater.close()),
        );
        return DiffUpdater.of({
          update: (input) =>
            Effect.tryPromise({
              try: () => opened.update(input),
              catch: (e) => ({ _tag: "FakeUpdateFailed", message: e instanceof Error ? e.message : String(e) }),
            }),
        });
      }),
    ),
  },
  AgentSdk: { layer: Layer.empty },
});
