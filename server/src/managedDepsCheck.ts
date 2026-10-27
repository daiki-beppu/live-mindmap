import { Effect } from "effect";
import { ManagedDeps } from "./managedDeps.ts";
import type { ModelRoute } from "./managedDepsProtocol.ts";
import { StartupDepsMissing } from "./startupDepsMissing.ts";
import { depWarnings, missingItems, reportItem } from "./startupItems.ts";
export { startupPreparationFailure } from "./startupItems.ts";

export const requireStartupDeps = Effect.fnUntraced(function* (_entry: "play", route: typeof ModelRoute.Type) {
  const deps = yield* ManagedDeps;
  const items = (yield* deps.check(["chromium", "claude"])).map((item) => reportItem(item, route === "claude" ? ["claude"] : []));
  const missing = missingItems(items);
  if (missing.length > 0) return yield* new StartupDepsMissing({ items: missing });
  return depWarnings(items);
});
