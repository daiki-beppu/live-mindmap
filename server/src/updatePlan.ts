// 差分更新の計画（単一モデルか、判定で振り分けるか）。CLI が resolvePlan で 1 回だけ決め、server は acceptPlan で検めるだけにする。
// 振り分けの規則・転送用トークンの要否・判定の鍵の確認は、ここだけが持つ。
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

// routed が使う差分更新のモデル（Sonnet 5.5 と Haiku 5.5 は routed の中で決まる）。ログ・経路・本文の model に使う
export const planModel = (plan: UpdatePlan): ExecutableModel => plan.kind === "single" ? plan.model : defaultClaude;

// HTTP の本文の形（model と、あれば judge）。本文の形は計画の導入前から変えない
export const planBody = (plan: UpdatePlan): { readonly model: ExecutableModel; readonly judge?: JudgeModel } =>
  plan.kind === "single" ? { model: plan.model } : { model: defaultClaude, judge: plan.judge };

// 振り分けが効くのは、組み込みの claude（設定で中身を変えていない）のときだけ
const isBuiltInClaude = (model: ExecutableModel): boolean =>
  model.route === "claude" && model.name === defaultClaude.name && model.model === defaultClaude.model
  && model.images === undefined && model.maxTokens === undefined && model.extraBody === undefined;

// 差分更新のモデルを利用者が名指ししたか（--model・LIVE_MINDMAP_MODEL・設定の default）。名指ししたときは振り分けない
const namedByUser = (flags: ModelFlags, envModel: string | undefined, config: unknown): boolean =>
  flags.model !== undefined || envModel !== undefined
  || (typeof config === "object" && config !== null && "default" in config && config.default !== undefined);

// 設定を 1 回だけ読み、差分更新のモデル・判定のモデル・振り分けるかを決める。判定の鍵はここでは見ない（planLayer が確かめる）
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

// server が本文から計画を検める。設定も環境変数も読まない。知らせずに別の計画へ読み替えず、受けられない組み合わせは断る
export const acceptPlan = (body: PlanBody): AcceptedPlan => {
  const accepted = acceptTransferredModel(body.model ?? defaultClaude);
  if (!accepted.ok) return accepted;
  if (body.judge === undefined) return { ok: true, plan: single(accepted.model) };
  if (accepted.model.local) return { ok: false, lines: ["ローカルモードでは判定による振り分けを使えません", "--judge off を指定するか、判定を明示しないでください"] };
  if (!isBuiltInClaude(accepted.model)) return { ok: false, lines: ["判定による振り分けは組み込みの claude にだけ使えます", "--model を名指ししたときは判定を指定しないでください"] };
  return { ok: true, plan: routed(body.judge) };
};

// 判定は環境変数の鍵を本文で指定できる宛先へ送るので、互換モデル・chatgpt と同じく転送用トークンを求める
export const needsTransferToken = (plan: UpdatePlan): boolean =>
  plan.kind === "routed" || plan.model.route === "openai-compatible" || plan.model.route === "chatgpt";

// 計画から差分更新の layer を作る。routed の判定の鍵はここで 1 回だけ確かめ、足りなければ判定なしの Sonnet 5.5 で始めて知らせを返す
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
