import { Predicate, Result, Schema, SchemaIssue } from "effect";

const options = {
  images: Schema.optionalKey(Schema.Boolean),
  maxTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  extraBody: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
};
const ClaudeDefinition = Schema.Struct({ route: Schema.Literal("claude"), model: Schema.NonEmptyString, ...options });
const CompatibleDefinition = Schema.Struct({
  route: Schema.Literal("openai-compatible"), model: Schema.NonEmptyString, url: Schema.NonEmptyString,
  apiKeyEnv: Schema.optionalKey(Schema.NonEmptyString), ...options,
});
const ChatGPTDefinition = Schema.Struct({ route: Schema.Literal("chatgpt"), model: Schema.NonEmptyString, ...options });
const ModelDefinition = Schema.Union([ClaudeDefinition, CompatibleDefinition, ChatGPTDefinition]);
const ModelConfig = Schema.Struct({
  default: Schema.optionalKey(Schema.NonEmptyString),
  models: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, ModelDefinition)),
});

export type ExecutableModel = ((typeof ClaudeDefinition.Type | typeof CompatibleDefinition.Type | typeof ChatGPTDefinition.Type) & { readonly name: string; readonly local: false })
  | { readonly name: "apple"; readonly route: "apple"; readonly local: true };
export const defaultClaude: Extract<ExecutableModel, { route: "claude" }> = { name: "claude", route: "claude", model: "claude-sonnet-5-5", local: false };
type NamedModel = (typeof ModelDefinition.Type & { readonly name: string }) | { readonly name: "apple"; readonly route: "apple" };
export type ModelFlags = { readonly model?: string; readonly local?: boolean };
type ModelInput = {
  readonly flags: ModelFlags;
  readonly envModel: string | undefined;
  readonly config: unknown;
  readonly configPath: string;
  readonly macState: Readonly<Record<string, unknown>>;
};
type Refusal = { readonly ok: false; readonly lines: readonly string[] };
type Catalog = { readonly ok: true; readonly models: readonly NamedModel[]; readonly defaultName: string };
const oneLine = (text: string) => text.replaceAll(/[\r\n]/g, " ");
export const configDiagnostic = (path: string, where: string, field: string, reason: string): Refusal => ({
  ok: false, lines: [oneLine(`設定ファイルが不正です: ${path}（「${where}」の ${field}: ${reason}）`)],
});

const catalog = (config: unknown, configPath: string): Catalog | Refusal => {
  const parsed = Schema.decodeUnknownResult(ModelConfig, { onExcessProperty: "error" })(config);
  if (Result.isFailure(parsed)) {
    const issue = SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues[0]!;
    const keys = (issue.path ?? []).map((segment) => Predicate.isObject(segment) ? segment.key : segment).map(String);
    const where = keys[0] === "models" && keys.length > 1 ? keys.slice(0, 2).join(".") : "設定";
    const field = keys.at(-1) ?? "JSON";
    return configDiagnostic(configPath, where, field, issue.message);
  }
  const definitions = parsed.success.models ?? {};
  if (Object.hasOwn(definitions, "apple")) return configDiagnostic(configPath, "models.apple", "apple", "組み込みの apple は上書きできません");
  const configured = Object.entries(definitions).map(([name, definition]) => ({ name, ...definition }));
  return {
    ok: true,
    models: [
      ...(Object.hasOwn(definitions, "claude") ? [] : [defaultClaude]),
      { name: "apple", route: "apple" }, ...configured,
    ],
    defaultName: parsed.success.default ?? "claude",
  };
};

export const appleRefusal = (macState: Readonly<Record<string, unknown>>): readonly string[] | undefined => {
  const version = macState.osVersion;
  if (typeof version === "string" && Number(version.split(".")[0]) < 27) return [
    oneLine(`この Mac ではローカルモードを使えません: macOS 27 以上が必要です（今は ${version}）`),
    "macOS を 27 以上へアップデートしてください",
  ];
  const availability = macState.availability;
  if (Predicate.isObject(availability) && availability.status === "available" && typeof version === "string" && Number(version.split(".")[0]) >= 27) return undefined;
  const reason = Predicate.isObject(availability) && typeof availability.reason === "string" ? availability.reason : "利用可否を確認できません";
  const prefix = "この Mac ではローカルモードを使えません: ";
  switch (reason) {
    case "appleIntelligenceNotEnabled": return [prefix + "Apple Intelligence がオフです", "システム設定 > Apple Intelligence と Siri でオンにしてください"];
    case "deviceNotEligible": return [prefix + "Apple Intelligence に対応していない機種です", "Apple Intelligence に対応した Mac を使ってください"];
    case "modelNotReady": return [prefix + "Apple Intelligence のモデルを準備中です", "しばらく待ってからやり直してください（システム設定 > Apple Intelligence と Siri で進み具合を見られます）"];
    default: return [oneLine(prefix + `Apple Intelligence を使えません（${reason}）`), "システム設定の状態を確認してからやり直してください"];
  }
};
const unavailable = (model: NamedModel, macState: Readonly<Record<string, unknown>>): string | undefined =>
  model.route === "apple" ? appleRefusal(macState)?.[0] : undefined;

export const listModels = (input: Pick<ModelInput, "config" | "configPath" | "macState">) => {
  const result = catalog(input.config, input.configPath);
  if (!result.ok) return result;
  return { ok: true as const, models: result.models.map((model) => ({
    ...model, local: model.route === "apple", reason: unavailable(model, input.macState),
  })) };
};

export const modelCandidate = (input: Omit<ModelInput, "macState">): Refusal | { readonly ok: true; readonly model: ExecutableModel; readonly local: boolean } => {
  const result = catalog(input.config, input.configPath);
  if (!result.ok) return result;
  const name = input.flags.model ?? (input.flags.local ? "apple" : input.envModel ?? result.defaultName);
  const chosenName = name === "local" && input.flags.model === undefined && input.envModel === undefined ? "apple" : name;
  if (input.flags.local && chosenName !== "apple") return {
    ok: false, lines: [oneLine(`ローカルモードでは ${chosenName} を選べません`),
      "ローカルモードで選べるのは live-mindmap が起動するモデル（apple）だけです。Ollama などは localhost で動いていても対象外です"],
  };
  const model = result.models.find((candidate) => candidate.name === chosenName);
  if (model === undefined) return { ok: false, lines: [oneLine(`モデル ${chosenName} が設定にありません。`), oneLine(`選べるのは ${result.models.map((m) => m.name).join("・")} です（${input.configPath}）`)] };
  if (model.route === "apple") {
    return { ok: true, model: { name: "apple", route: "apple", local: true }, local: true };
  }
  return { ok: true, model: { ...model, local: false }, local: false };
};

export const selectModel = (input: ModelInput): ReturnType<typeof modelCandidate> => {
  const candidate = modelCandidate(input);
  if (!candidate.ok || candidate.model.route !== "apple") return candidate;
  const lines = appleRefusal(input.macState);
  return lines === undefined ? candidate : { ok: false, lines };
};

// HTTP は CLI から解決済みの値を受ける。設定を読み直さず、転送された構造と実行条件だけを検証する。
export const TransferredModel = Schema.Union([
  Schema.Struct({ name: Schema.NonEmptyString, ...ClaudeDefinition.fields, local: Schema.Boolean }),
  Schema.Struct({ name: Schema.NonEmptyString, ...CompatibleDefinition.fields, local: Schema.Boolean }),
  Schema.Struct({ name: Schema.NonEmptyString, ...ChatGPTDefinition.fields, local: Schema.Boolean }),
  Schema.Struct({ name: Schema.Literal("apple"), route: Schema.Literal("apple"), local: Schema.Boolean }),
]);
export const acceptTransferredModel = (model: typeof TransferredModel.Type): Refusal | { readonly ok: true; readonly model: ExecutableModel } => {
  if (model.route === "apple") return { ok: true, model: { name: "apple", route: "apple", local: true } };
  if (model.local && model.name !== "apple") return { ok: false, lines: [oneLine(`ローカルモードでは ${model.name} を選べません`), "--model claude を --local なしで指定してください"] };
  if (model.name === "apple") return { ok: false, lines: [oneLine(`${model.name} はまだ使えません`), "--model claude を指定してください"] };
  return { ok: true, model: { ...model, local: false } };
};
