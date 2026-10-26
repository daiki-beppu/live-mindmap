import type { HelperCheck } from "./helpers.ts";
import type { DepItem } from "./managedDeps.ts";
import type { Item } from "./managedDepsProtocol.ts";
import { describeDep, StartupDepsMissing } from "./startupDepsMissing.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import chromiumManifest from "../managed-deps/chromium/package.json" with { type: "json" };
import claudeManifest from "../managed-deps/claude/package.json" with { type: "json" };

export const reportItem = (item: DepItem, required: ReadonlyArray<string>) => ({
  ...item,
  need: required.includes(item.name) ? "required" as const : "optional" as const,
  size: item.name === "claude" ? 224_000_000 : 211_000_000,
  install: `pnpm cli install ${item.name}`,
});

export const speechJaItem = (status: HelperCheck["speechJa"]): typeof Item.Type => ({
  name: "speech-ja", need: "required", state: status.status === "installed" ? "ready" : "missing", install: "pnpm cli install speech-ja",
});

const pinnedVersion = (item: typeof Item.Type) =>
  item.name === "claude" ? claudeManifest.dependencies["@anthropic-ai/claude-agent-sdk"] : chromiumManifest.dependencies["playwright-core"];

export const depWarnings = (items: ReadonlyArray<typeof Item.Type>): string[] =>
  items.filter((item) => item.state === "outdated" || (item.need === "optional" && item.state !== "ready"))
    .map((item) => item.state === "outdated"
      ? `警告: ${describeDep(item)} が版違いです（入っている版 ${item.version}、固定版 ${pinnedVersion(item)}）。そろえるには: pnpm cli update ${item.name}`
      : `警告: ${describeDep(item)} がありません。入れるには: ${item.install}`);

export const startupPreparationFailure = (failure: UpdaterUnavailable): UpdaterUnavailable | StartupDepsMissing =>
  failure.dependency === undefined ? failure : new StartupDepsMissing({
    items: [reportItem({ name: failure.dependency, need: "required", state: "missing" }, [failure.dependency])],
  });

export const missingItems = (items: ReadonlyArray<typeof Item.Type>) => items.filter((item) => item.need === "required" && item.state !== "ready" && item.state !== "outdated");
