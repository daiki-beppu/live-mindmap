import { Effect } from "effect";
import { ManagedDeps } from "./managedDeps.ts";

export const checkManagedDeps = Effect.gen(function* () {
  const deps = yield* ManagedDeps;
  const items = (yield* deps.check(["chromium"])).map((item) => ({
    ...item,
    // 容量の目安は約211MB。JSON の size はバイト数。
    size: 211_000_000,
    install: "pnpm cli install chromium",
  }));
  return {
    ready: items.every((item) => item.need === "optional" || item.state === "ready"),
    items,
  };
});
