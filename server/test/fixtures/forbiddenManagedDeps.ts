import { Effect, Layer, Stream } from "effect";
import { ManagedDeps } from "../../src/managedDeps.ts";

export const forbiddenManagedDeps = Layer.succeed(ManagedDeps, ManagedDeps.of({
  executable: () => Effect.die("実行ファイル取得は対象外"),
  load: () => Effect.die("管理依存の読み込みは対象外"),
  check: () => Effect.die("管理依存の確認は対象外"),
  update: () => Stream.die("更新は対象外"), install: () => Stream.die("管理依存の導入は対象外"),
}));
