import { Config, Effect, Option } from "effect";
import { prepareRoutedLayer, prepareUpdaterLayer } from "./diffUpdater.ts";
import { judgeCandidate, judgeEnvs, missingKeyNotice, type JudgeFlags, type JudgeModel } from "./judgeSelection.ts";
import { loadModelConfig, reject, resolveModelFrom } from "./modelConfig.ts";
import { acceptTransferredModel, defaultClaude, type ExecutableModel, type ModelFlags, type TransferredModel } from "./modelSelection.ts";

export type UpdatePlan =
  | { readonly kind: "single"; readonly model: ExecutableModel }
  | { readonly kind: "routed"; readonly judge: JudgeModel };

const single = (model: ExecutableModel): UpdatePlan => ({ kind: "single", model });
const routed = (judge: JudgeModel): UpdatePlan => ({ kind: "routed", judge });

export const planModel = (plan: UpdatePlan): ExecutableModel => plan.kind === "single" ? plan.model : defaultClaude;

export const planBody = (plan: UpdatePlan): { readonly model: ExecutableModel; readonly judge?: JudgeModel } =>
  plan.kind === "single" ? { model: plan.model } : { model: defaultClaude, judge: plan.judge };

const isBuiltInClaude = (model: ExecutableModel): boolean =>
  model.route === "claude" && model.name === defaultClaude.name && model.model === defaultClaude.model
  && model.images === undefined && model.maxTokens === undefined && model.extraBody === undefined;

const namedByUser = (flags: ModelFlags, envModel: string | undefined, config: unknown): boolean =>
  flags.model !== undefined || envModel !== undefined
  || (typeof config === "object" && config !== null && "default" in config && config.default !== undefined);

export const resolvePlan = Effect.fn("resolvePlan")(function* (flags: ModelFlags & JudgeFlags) {
  const loaded = yield* loadModelConfig();
  const model = yield* resolveModelFrom(loaded, flags);
  const candidate = judgeCandidate({ flags, envJudge: loaded.envJudge, config: loaded.config, configPath: loaded.configPath, local: model.local });
  if (!candidate.ok) return yield* reject(candidate.lines);
  if (candidate.judge === undefined || namedByUser(flags, loaded.envModel, loaded.config) || !isBuiltInClaude(model)) {
    return single(model);
  }
  return routed(candidate.judge);
});

type PlanBody = { readonly model?: typeof TransferredModel["Type"]; readonly judge?: JudgeModel };
type AcceptedPlan = { readonly ok: true; readonly plan: UpdatePlan } | { readonly ok: false; readonly lines: readonly string[] };

export const acceptPlan = (body: PlanBody): AcceptedPlan => {
  const accepted = acceptTransferredModel(body.model ?? defaultClaude);
  if (!accepted.ok) return accepted;
  if (body.judge === undefined) return { ok: true, plan: single(accepted.model) };
  if (accepted.model.local) return { ok: false, lines: ["ローカルモードでは判定による振り分けを使えません", "--judge off を指定するか、判定を明示しないでください"] };
  if (!isBuiltInClaude(accepted.model)) return { ok: false, lines: ["判定による振り分けは組み込みの claude にだけ使えます", "--model を名指ししたときは判定を指定しないでください"] };
  return { ok: true, plan: routed(body.judge) };
};

export const needsTransferToken = (plan: UpdatePlan): boolean =>
  plan.kind === "routed" || plan.model.route === "openai-compatible" || plan.model.route === "chatgpt";

export const planLayer = Effect.fnUntraced(function* (plan: UpdatePlan) {
  if (plan.kind === "single") return { layer: yield* prepareUpdaterLayer(plan.model) };
  const names = judgeEnvs(plan.judge);
  const values: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const value = Option.getOrUndefined(yield* Config.option(Config.String(name)).pipe(Effect.orElseSucceed(() => Option.none<string>())));
    if (value === undefined || value.trim() === "") missing.push(name);
    else values.push(value);
  }
  if (missing.length > 0) return { layer: yield* prepareUpdaterLayer(defaultClaude), notice: missingKeyNotice(plan.judge, missing) };
  return { layer: yield* prepareRoutedLayer(plan.judge, values) };
});
