import { Context, Effect, Layer, Result, Scope } from "effect";
import { DiffUpdater } from "./core/index.ts";
import { Helpers, type HelperCheck, type HelperCheckFailure } from "./helpers.ts";
import { HELPER_BUILD_COMMAND } from "./helperPath.ts";
import { ManagedDeps, type ManagedDepsFailed } from "./managedDeps.ts";
import type { CheckReport, Item, ModelRoute } from "./managedDepsProtocol.ts";
import { StartupDepsMissing } from "./startupDepsMissing.ts";
import { depWarnings, missingItems, reportItem, speechJaItem, startupPreparationFailure } from "./startupItems.ts";
import type { UpdatePlan } from "./updatePlan.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";

type Play = { readonly entry: "play"; readonly route: typeof ModelRoute.Type; readonly screen?: never; readonly noMap?: never };
type Live<Entry extends "start" | "resume"> = { readonly entry: Entry; readonly route: typeof ModelRoute.Type; readonly screen: boolean; readonly noMap?: never };
type RecordedMap = { readonly entry: "recorded"; readonly route: typeof ModelRoute.Type; readonly noMap: false; readonly screen?: never };
type RecordedTranscript = { readonly entry: "recorded"; readonly noMap: true; readonly screen?: never; readonly route?: never };
type Input = Play | Live<"start"> | Live<"resume"> | RecordedMap | RecordedTranscript;
type PrepareMap = (Play | Live<"start"> | RecordedMap) & { readonly plan: UpdatePlan };
type PrepareOnly = (Live<"resume"> | RecordedTranscript) & { readonly plan?: never };
type PrepareInput = PrepareMap | PrepareOnly;
type Warnings = { readonly warnings: ReadonlyArray<string> };
type Prepared = Warnings & { readonly updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable> };
type Failure = ManagedDepsFailed | StartupDepsMissing | UpdaterUnavailable;

export type StartupChecksDeps<R = never> = {
  readonly prepareUpdater: (plan: UpdatePlan) => Effect.Effect<{ readonly layer: Layer.Layer<DiffUpdater, UpdaterUnavailable>; readonly notice?: string }, UpdaterUnavailable, R | Scope.Scope>;
};

type Report = {
  (input: Play): Effect.Effect<typeof CheckReport.Type, ManagedDepsFailed>;
  (input: Input): Effect.Effect<typeof CheckReport.Type, ManagedDepsFailed, Helpers>;
};
type Prepare = {
  (input: Play & { readonly plan: UpdatePlan }): Effect.Effect<Prepared, Failure, Scope.Scope>;
  (input: PrepareMap): Effect.Effect<Prepared, Failure, Helpers | Scope.Scope>;
  (input: PrepareOnly): Effect.Effect<Warnings, Failure, Helpers>;
  (input: PrepareInput): Effect.Effect<Prepared | Warnings, Failure, Helpers | Scope.Scope>;
};

const helperResult = (result: Result.Result<HelperCheck, HelperCheckFailure>, input: Exclude<Input, Play>) => {
  const helper = { name: "helper", need: "required", state: Result.isSuccess(result) ? "ready" : "missing", install: HELPER_BUILD_COMMAND } satisfies typeof Item.Type;
  if (Result.isFailure(result)) return { items: [helper], warnings: [] };
  const status = result.success;
  if (input.entry === "recorded") return { items: [helper, speechJaItem(status.speechJa)], warnings: [] };
  const items: Array<typeof Item.Type> = [helper, { name: "microphone", need: "optional", state: status.microphone === "authorized" ? "ready" : "absent" },
    ...(input.screen ? [{ name: "screen-capture", need: "optional", state: status.screenCapture ? "ready" : "absent" } satisfies typeof Item.Type] : []), speechJaItem(status.speechJa)];
  return { items, warnings: [
    ...(status.microphone === "denied" ? ["マイクの許可がありません。自分の声が入りません"] : []),
    ...(status.microphone === "notDetermined" ? ["マイクの許可が未決定です。開始時に許可のダイアログが出ます"] : []),
    ...(input.screen && !status.screenCapture ? ["画面収録の許可がありません。共有画面は読まず、音声だけで始めます"] : []),
  ] };
};

export class StartupChecks extends Context.Service<StartupChecks, { readonly report: Report; readonly prepare: Prepare }>()("live-mindmap/server/StartupChecks") {
  static readonly layer = <R>({ prepareUpdater }: StartupChecksDeps<R>) => Layer.effect(StartupChecks)(Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    const preparationServices = yield* Effect.context<R>();
    const check = Effect.fnUntraced(function* (input: Input) {
      const noMap = input.entry === "recorded" && input.noMap;
      const common = noMap ? [] : (yield* deps.check(["chromium", "claude"])).map((item) => reportItem(item, input.route === "claude" ? ["claude"] : []));
      const live = input.entry === "play" ? { items: [], warnings: [] } : helperResult(yield* Effect.result(
        (yield* Helpers).check({ screen: (input.entry === "start" || input.entry === "resume") && input.screen }),
      ), input);
      const items = [...common, ...live.items];
      const missing = missingItems(items);
      return { report: { ready: missing.length === 0, items }, missing,
        warnings: [...depWarnings(common.filter((item) => item.name !== "claude" || input.route === "claude")), ...live.warnings] };
    });
    function report(input: Play): Effect.Effect<typeof CheckReport.Type, ManagedDepsFailed>;
    function report(input: Input): Effect.Effect<typeof CheckReport.Type, ManagedDepsFailed, Helpers>;
    function report(input: Input): Effect.Effect<typeof CheckReport.Type, ManagedDepsFailed> | Effect.Effect<typeof CheckReport.Type, ManagedDepsFailed, Helpers> { return Effect.map(check(input), (checked) => checked.report); }
    function prepare(input: Play & { readonly plan: UpdatePlan }): Effect.Effect<Prepared, Failure, Scope.Scope>;
    function prepare(input: PrepareMap): Effect.Effect<Prepared, Failure, Helpers | Scope.Scope>;
    function prepare(input: PrepareOnly): Effect.Effect<Warnings, Failure, Helpers>;
    function prepare(input: PrepareInput): Effect.Effect<Prepared | Warnings, Failure, Helpers | Scope.Scope>;
    function prepare(input: PrepareInput): Effect.Effect<Prepared, Failure, Scope.Scope> | Effect.Effect<Warnings, Failure, Helpers> | Effect.Effect<Prepared | Warnings, Failure, Helpers | Scope.Scope> {
      return Effect.gen(function* () {
        const { missing, warnings } = yield* check(input);
        if (missing.length > 0) return yield* new StartupDepsMissing({ items: missing });
        if (input.entry === "resume" || (input.entry === "recorded" && input.noMap)) return { warnings };
        const scope = yield* Effect.scope;
        const prepared = yield* prepareUpdater(input.plan).pipe(
          Effect.provideContext(Context.add(preparationServices, Scope.Scope, scope)), Effect.mapError(startupPreparationFailure),
        );
        const notices = prepared.notice === undefined ? [] : [prepared.notice];
        const supplement = (input.entry === "start" || input.entry === "play") && input.route !== "claude" ? ["補足なしで始めます"] : [];
        return { updaterLayer: prepared.layer, warnings: [...warnings, ...notices, ...supplement] };
      });
    }
    return StartupChecks.of({ report, prepare });
  }));
}
