import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { vi } from "vitest";
import { AgentSdk, layerClaude } from "../src/claude.ts";
import { DiffUpdater, emptyMap } from "../src/core/index.ts";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";

// 実装前の通常依存経路でも、本物の Claude を呼ばない。
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: () => { throw new Error("通常依存の SDK を呼びました"); } }));

describe("管理 SDK を使う AgentSdk", () => {
  it.effect("load claude から受け取った query で差分更新する", () => Effect.gen(function* () {
    const query = vi.fn(() => Object.assign((async function* () {
      yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "管理 SDK の応答" }] } };
    })(), { close: () => {} })) as unknown as AgentSdk["Service"]["query"];
    const load = vi.fn((name: string) => {
      expect(name).toBe("claude");
      return Effect.succeed({ query });
    });
    const deps = Layer.succeed(ManagedDeps, ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      check: () => Effect.die("状態確認は対象外"), update: () => Stream.die("更新は対象外"), install: () => Stream.die("導入は対象外"),
      load: load as unknown as ManagedDeps["Service"]["load"],
    }));
    yield* Effect.gen(function* () {
      const updater = yield* DiffUpdater;
      const result = yield* updater.update({ map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "合成の発言" }] });
      expect(result.ops).toEqual([{ op: "noop", reason: "管理 SDK の応答" }]);
      expect(load).toHaveBeenCalledExactlyOnceWith("claude");
    }).pipe(Effect.provide(layerClaude("synthetic-model").pipe(Layer.provide(AgentSdk.layer.pipe(Layer.provide(deps))))));
  }).pipe(Effect.scoped));

  it.effect("管理 SDK の読込失敗を成功した AgentSdk に置き換えない", () => Effect.gen(function* () {
    const failure = new ManagedDepsFailed({ message: "管理 SDK がありません" });
    const deps = Layer.succeed(ManagedDeps, ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      check: () => Effect.die("状態確認は対象外"), update: () => Stream.die("更新は対象外"), install: () => Stream.die("導入は対象外"),
      load: () => Effect.fail(failure),
    }));
    const result = yield* Effect.result(AgentSdk.pipe(Effect.provide(AgentSdk.layer.pipe(Layer.provide(deps)))));
    expect(result).toMatchObject({ _tag: "Failure", failure: { message: failure.message } });
  }));
});
