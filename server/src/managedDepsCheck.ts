import { Effect } from "effect";
import { ManagedDeps, type DepItem } from "./managedDeps.ts";
import type { CheckFor, ModelRoute } from "./managedDepsProtocol.ts";
import { describeDep, StartupDepsMissing } from "./startupDepsMissing.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";

const requiredByRoute = {
  claude: ["claude"],
  "openai-compatible": [],
  chatgpt: [],
  apple: [],
} satisfies Record<typeof ModelRoute.Type, ReadonlyArray<DepItem["name"]>>;
const commonByEntry = {
  start: ["chromium"],
  resume: ["chromium"],
  play: ["chromium"],
} satisfies Record<typeof CheckFor.Type, ReadonlyArray<DepItem["name"]>>;

const reportItem = (item: DepItem, required: ReadonlyArray<string>) => ({
  ...item,
  need: required.includes(item.name) ? "required" as const : "optional" as const,
  size: item.name === "claude" ? 224_000_000 : 211_000_000,
  install: `pnpm cli install ${item.name}`,
});

export const checkManagedDeps = Effect.fnUntraced(function* (entry: typeof CheckFor.Type, route: typeof ModelRoute.Type) {
  const deps = yield* ManagedDeps;
  const items = (yield* deps.check([...commonByEntry[entry], "claude"])).map((item) => reportItem(item, requiredByRoute[route]));
  return { ready: items.every((item) => item.need === "optional" || item.state === "ready"), items };
});

export const requireStartupDeps = Effect.fnUntraced(function* (entry: typeof CheckFor.Type, route: typeof ModelRoute.Type) {
  const report = yield* checkManagedDeps(entry, route);
  if (!report.ready) return yield* new StartupDepsMissing({ items: report.items.filter((item) => item.need === "required" && item.state !== "ready") });
  return report.items.filter((item) => item.need === "optional" && item.state !== "ready")
    .map((item) => `警告: ${describeDep(item)} がありません。入れるには: ${item.install}`);
});

export const startupPreparationFailure = (failure: UpdaterUnavailable): UpdaterUnavailable | StartupDepsMissing =>
  failure.dependency === undefined ? failure : new StartupDepsMissing({
    items: [reportItem({ name: failure.dependency, need: "required", state: "missing" }, [failure.dependency])],
  });
