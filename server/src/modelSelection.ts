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

export type ExecutableModel = (typeof ClaudeDefinition.Type | typeof CompatibleDefinition.Type | typeof ChatGPTDefinition.Type) & { readonly name: string; readonly local: false };
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

const unavailable = (model: NamedModel): string | undefined => model.route !== "apple" ? undefined : oneLine(`${model.name} はまだ使えません`);

export const listModels = (input: Pick<ModelInput, "config" | "configPath" | "macState">) => {
  const result = catalog(input.config, input.configPath);
  if (!result.ok) return result;
  return { ok: true as const, models: result.models.map((model) => ({
    ...model, local: model.route === "apple", reason: unavailable(model),
  })) };
};

export const selectModel = (input: ModelInput): Refusal | { readonly ok: true; readonly model: ExecutableModel; readonly local: false } => {
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
  const reason = unavailable(model);
  if (model.route === "apple") return { ok: false, lines: [reason!, "--model claude または設定した Claude 経路の名前を選んでください"] };
  return { ok: true, model: { ...model, local: false }, local: false };
};

// HTTP は CLI から解決済みの値を受ける。設定を読み直さず、転送された構造と実行条件だけを検証する。
export const TransferredModel = Schema.Union([
  Schema.Struct({ name: Schema.NonEmptyString, ...ClaudeDefinition.fields, local: Schema.Boolean }),
  Schema.Struct({ name: Schema.NonEmptyString, ...CompatibleDefinition.fields, local: Schema.Boolean }),
  Schema.Struct({ name: Schema.NonEmptyString, ...ChatGPTDefinition.fields, local: Schema.Boolean }),
  Schema.Struct({ name: Schema.Literal("apple"), route: Schema.Literal("apple"), local: Schema.Boolean }),
]);
export const acceptTransferredModel = (model: typeof TransferredModel.Type): Refusal | { readonly ok: true; readonly model: ExecutableModel } => {
  if (model.local && model.name !== "apple") return { ok: false, lines: [oneLine(`ローカルモードでは ${model.name} を選べません`), "--model claude を --local なしで指定してください"] };
  if (model.name === "apple" || model.route === "apple") return { ok: false, lines: [oneLine(`${model.name} はまだ使えません`), "--model claude を指定してください"] };
  return { ok: true, model: { ...model, local: false } };
};
