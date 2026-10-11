import { Context, Effect } from "effect";
import { ManagedDeps } from "./managedDeps.ts";

export const ClaudeRequired = Context.Reference("live-mindmap/server/ClaudeRequired", { defaultValue: () => true });

export const checkManagedDeps = Effect.gen(function* () {
  const deps = yield* ManagedDeps;
  const claudeRequired = yield* ClaudeRequired;
  const items = (yield* deps.check(["chromium", "claude"])).map((item) => ({
    ...item,
    need: item.name === "claude" ? (claudeRequired ? "required" as const : "optional" as const) : item.need,
    // JSON の size は導入容量の目安（バイト数）。
    size: item.name === "claude" ? 224_000_000 : 211_000_000,
    install: `pnpm cli install ${item.name}`,
  }));
  return {
    ready: items.every((item) => item.need === "optional" || item.state === "ready"),
    items,
  };
});
