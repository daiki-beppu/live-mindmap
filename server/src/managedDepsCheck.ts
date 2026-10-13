import { Effect, Result } from "effect";
import type { HelperCheck, HelperCheckFailure } from "./helpers.ts";
import { HELPER_BUILD_COMMAND } from "./helperPath.ts";
import { ManagedDeps, type DepItem } from "./managedDeps.ts";
import type { Item, ModelRoute } from "./managedDepsProtocol.ts";
import { describeDep, StartupDepsMissing } from "./startupDepsMissing.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import chromiumManifest from "../managed-deps/chromium/package.json" with { type: "json" };
import claudeManifest from "../managed-deps/claude/package.json" with { type: "json" };

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
} satisfies Record<"start" | "resume" | "play", ReadonlyArray<DepItem["name"]>>;

const reportItem = (item: DepItem, required: ReadonlyArray<string>) => ({
  ...item,
  need: required.includes(item.name) ? "required" as const : "optional" as const,
  size: item.name === "claude" ? 224_000_000 : 211_000_000,
  install: `pnpm cli install ${item.name}`,
});

type LiveCheck = { screen: boolean; check: Effect.Effect<HelperCheck, HelperCheckFailure> };
type CheckArgs = [entry: "play", route: typeof ModelRoute.Type] | [entry: "start" | "resume", route: typeof ModelRoute.Type, live: LiveCheck];

export const speechJaItem = (status: HelperCheck["speechJa"]): typeof Item.Type => ({
  name: "speech-ja", need: "required", state: status.status === "installed" ? "ready" : "missing", install: "pnpm cli install speech-ja",
});

const pinnedVersion = (item: typeof Item.Type) =>
  item.name === "claude" ? claudeManifest.dependencies["@anthropic-ai/claude-agent-sdk"] : chromiumManifest.dependencies["playwright-core"];

const depWarnings = (items: ReadonlyArray<typeof Item.Type>): string[] =>
  items.filter((item) => item.state === "outdated" || (item.need === "optional" && item.state !== "ready"))
    .map((item) => item.state === "outdated"
      ? `警告: ${describeDep(item)} が版違いです（入っている版 ${item.version}、固定版 ${pinnedVersion(item)}）。そろえるには: pnpm cli update ${item.name}`
      : `警告: ${describeDep(item)} がありません。入れるには: ${item.install}`);

const microphoneWarnings = (microphone: HelperCheck["microphone"]): string[] => [
  ...(microphone === "denied" ? ["マイクの許可がありません。自分の声が入りません"] : []),
  ...(microphone === "notDetermined" ? ["マイクの許可が未決定です。開始時に許可のダイアログが出ます"] : []),
];

// 画面収録は、共有画面を読む入口（screen）のときだけ報告に載せる
const screenCaptureReport = (status: HelperCheck, screen: boolean): { items: Array<typeof Item.Type>; warnings: string[] } => screen
  ? {
      items: [{ name: "screen-capture", need: "optional", state: status.screenCapture ? "ready" : "absent" }],
      warnings: status.screenCapture ? [] : ["画面収録の許可がありません。共有画面は読まず、音声だけで始めます"],
    }
  : { items: [], warnings: [] };

const liveItems = (result: Result.Result<HelperCheck, HelperCheckFailure>, screen: boolean): { items: Array<typeof Item.Type>; warnings: string[] } => {
  const helper = { name: "helper", need: "required", state: Result.isSuccess(result) ? "ready" : "missing", install: HELPER_BUILD_COMMAND } satisfies typeof Item.Type;
  if (Result.isFailure(result)) return { items: [helper], warnings: [] };
  const status = result.success;
  const screenCapture = screenCaptureReport(status, screen);
  return {
    items: [
      helper,
      { name: "microphone", need: "optional", state: status.microphone === "authorized" ? "ready" : "absent" },
      ...screenCapture.items,
      speechJaItem(status.speechJa),
    ],
    warnings: [...microphoneWarnings(status.microphone), ...screenCapture.warnings],
  };
};

const checkDependencies = Effect.fnUntraced(function* (...[entry, route, live]: CheckArgs) {
  const deps = yield* ManagedDeps;
  const common: Array<typeof Item.Type> = (yield* deps.check([...commonByEntry[entry], "claude"])).map((item) => reportItem(item, requiredByRoute[route]));
  const liveResult = entry === "play" ? { items: [], warnings: [] } : liveItems(yield* Effect.result(live.check), live.screen);
  const items = [...common, ...liveResult.items];
  return { report: { ready: items.every((item) => item.need === "optional" || item.state === "ready"), items }, warnings: [...depWarnings(common), ...liveResult.warnings] };
});

export const checkManagedDeps = Effect.fnUntraced(function* (...args: CheckArgs) {
  return (yield* checkDependencies(...args)).report;
});

export const requireStartupDeps = Effect.fnUntraced(function* (...args: CheckArgs) {
  const { report, warnings } = yield* checkDependencies(...args);
  const missing = report.items.filter((item) => item.need === "required" && item.state !== "ready" && item.state !== "outdated");
  if (missing.length > 0) return yield* new StartupDepsMissing({ items: missing });
  return warnings;
});

export const startupPreparationFailure = (failure: UpdaterUnavailable): UpdaterUnavailable | StartupDepsMissing =>
  failure.dependency === undefined ? failure : new StartupDepsMissing({
    items: [reportItem({ name: failure.dependency, need: "required", state: "missing" }, [failure.dependency])],
  });
