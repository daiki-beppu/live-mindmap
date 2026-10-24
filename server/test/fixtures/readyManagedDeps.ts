import { Effect, Layer, Stream } from "effect";
import { ManagedDeps } from "../../src/managedDeps.ts";

export const readyManagedDeps = Layer.succeed(ManagedDeps, ManagedDeps.of({
  executable: () => Effect.die("実行ファイル取得は対象外"),
  check: (names) => Effect.succeed(names.map((name) => {
    if (name !== "claude" && name !== "chromium") throw new Error(`対象外の依存: ${name}`);
    return { name, need: "optional" as const, state: "ready" as const };
  })),
  load: () => Effect.die("管理依存の読み込みは対象外"),
  update: () => Stream.die("更新は対象外"), install: () => Stream.die("管理依存の導入は対象外"),
}));

export const withFakeClaude = (managed: Layer.Layer<ManagedDeps>) => Layer.effect(ManagedDeps, Effect.gen(function* () {
  const real = yield* ManagedDeps;
  return ManagedDeps.of({
    ...real,
    check: (names) => real.check(names).pipe(Effect.map((items) => items.map((item) =>
      item.name === "claude" ? { ...item, state: "ready" as const } : item))),
  });
})).pipe(Layer.provide(managed));
