import { Effect, Layer, Stream } from "effect";
import { vi } from "vitest";
import { ManagedDeps, ManagedDepsFailed, type DepItem } from "../../src/managedDeps.ts";

export const evalManagedDeps = (state: "ready" | "missing") => {
  const check = vi.fn((names: ReadonlyArray<string>) => Effect.succeed(names.map((name): DepItem => {
    if (name !== "claude" && name !== "chromium") throw new Error(`対象外の依存: ${name}`);
    return { name, need: "optional" as const, state: name === "claude" ? state : "ready" as const };
  })));
  const load = vi.fn((name: string) => {
    if (name !== "claude") return Effect.die(`評価で対象外の読込: ${name}`);
    if (state === "missing") return Effect.fail(new ManagedDepsFailed({ message: "管理 SDK がありません" }));
    return Effect.succeed({ query: () => { throw new Error("偽 updater は SDK の query を呼びません"); } });
  });
  const install = vi.fn(() => Stream.die("評価は依存を導入しません"));
  const layer = Layer.succeed(ManagedDeps, ManagedDeps.of({
    check, install, update: () => Stream.die("更新は対象外"), load: load as unknown as ManagedDeps["Service"]["load"],
  }));
  return { layer, check, load, install };
};
