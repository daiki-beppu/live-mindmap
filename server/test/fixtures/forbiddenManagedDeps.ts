import { Effect, Layer, Stream } from "effect";
import { ManagedDeps } from "../../src/managedDeps.ts";

export const forbiddenManagedDeps = Layer.succeed(ManagedDeps, ManagedDeps.of({
  check: () => Effect.die("管理依存の確認は対象外"),
  install: () => Stream.die("管理依存の導入は対象外"),
}));
