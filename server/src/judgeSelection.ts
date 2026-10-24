import { Result, Schema } from "effect";
import { configDiagnostic, schemaDiagnostic } from "./modelSelection.ts";

const JudgeDefinition = Schema.Struct({
  route: Schema.optionalKey(Schema.Literal("system-one")),
  apiKeyEnv: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  url: Schema.optionalKey(Schema.NonEmptyString),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
const JudgeConfig = Schema.Struct({
  judge: Schema.optionalKey(Schema.NonEmptyString),
  judges: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, JudgeDefinition)),
  default: Schema.optionalKey(Schema.Unknown),
  models: Schema.optionalKey(Schema.Unknown),
});

export const TransferredJudge = Schema.Struct({
  name: Schema.NonEmptyString,
  route: Schema.Literal("system-one"),
  apiKeyEnv: Schema.NonEmptyString,
  accountIdEnv: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  url: Schema.optionalKey(Schema.NonEmptyString),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});

const defaultTimeoutMs = 1000;
const defaultJudgeName = "jev";
const noJudgeName = "off";
export type JudgeModel = {
  readonly name: string;
  readonly route: "system-one";
  readonly apiKeyEnv: string;
  readonly accountIdEnv?: string;
  readonly model?: string;
  readonly url?: string;
  readonly timeoutMs: number;
};
const cloudflare = { route: "system-one", apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", timeoutMs: 2000 } as const;
const builtIns: readonly JudgeModel[] = [
  { name: defaultJudgeName, route: "system-one", apiKeyEnv: "TYPESAFE_AI_API_KEY", timeoutMs: defaultTimeoutMs },
  { name: "clef-flash", ...cloudflare, model: "clef-flash" },
  { name: "clef", ...cloudflare, model: "clef" },
];

export const judgeEnvs = (judge: Pick<JudgeModel, "apiKeyEnv" | "accountIdEnv">): readonly string[] =>
  judge.accountIdEnv === undefined ? [judge.apiKeyEnv] : [judge.apiKeyEnv, judge.accountIdEnv];

export type JudgeFlags = { readonly judge?: string };
type JudgeInput = {
  readonly flags: JudgeFlags;
  readonly envJudge: string | undefined;
  readonly config: unknown;
  readonly configPath: string;
  readonly local: boolean;
};
type Refusal = { readonly ok: false; readonly lines: readonly string[] };
type Chosen = { readonly ok: true; readonly judge: JudgeModel | undefined };
const oneLine = (text: string) => text.replaceAll(/[\r\n]/g, " ");

type Definition = typeof JudgeDefinition.Type;
type Definitions = { readonly ok: true; readonly configured: readonly JudgeModel[]; readonly overridden: ReadonlyMap<string, number> };

const timeoutOverride = (configPath: string, key: string, definition: Definition): Refusal | number => {
  const where = `judges.${key}`;
  if (!builtIns.some((candidate) => candidate.name === key)) return configDiagnostic(configPath, where, "route", "route が必要です（時間切れだけを書けるのは組み込みの判定のモデルです）");
  for (const field of ["model", "url", "apiKeyEnv"] as const) {
    if (definition[field] !== undefined) return configDiagnostic(configPath, where, field, "route を書かない項目で指定できるのは timeoutMs だけです");
  }
  if (definition.timeoutMs === undefined) return configDiagnostic(configPath, where, "timeoutMs", "route を書かない項目には timeoutMs が必要です");
  return definition.timeoutMs;
};

const readDefinitions = (configPath: string, definitions: Readonly<Record<string, Definition>>): Refusal | Definitions => {
  const configured: JudgeModel[] = [];
  const overridden = new Map<string, number>();
  for (const [key, definition] of Object.entries(definitions)) {
    if (definition.route === undefined) {
      const timeoutMs = timeoutOverride(configPath, key, definition);
      if (typeof timeoutMs !== "number") return timeoutMs;
      overridden.set(key, timeoutMs);
      continue;
    }
    if (definition.apiKeyEnv === undefined) return configDiagnostic(configPath, `judges.${key}`, "apiKeyEnv", "apiKeyEnv が必要です");
    configured.push({ ...definition, route: definition.route, apiKeyEnv: definition.apiKeyEnv, name: key, timeoutMs: definition.timeoutMs ?? defaultTimeoutMs });
  }
  return { ok: true, configured, overridden };
};

const availableJudges = ({ configured, overridden }: Definitions): readonly JudgeModel[] => [
  ...builtIns
    .filter((builtIn) => !configured.some((candidate) => candidate.name === builtIn.name))
    .map((builtIn) => ({ ...builtIn, timeoutMs: overridden.get(builtIn.name) ?? builtIn.timeoutMs })),
  ...configured,
];

const localChoice = (judge: JudgeModel, explicit: string | undefined): Refusal | Chosen => {
  if (explicit === undefined) return { ok: true, judge: undefined };
  return { ok: false, lines: [
    oneLine(`ローカルモードでは判定のモデル ${judge.name} を選べません`),
    "ローカルモードで使える判定のモデルはありません。--judge off（または LIVE_MINDMAP_JUDGE・設定の judge に off）を指定するか、判定のモデルを明示しないでください",
  ] };
};

export const judgeCandidate = (input: JudgeInput): Refusal | Chosen => {
  const parsed = Schema.decodeUnknownResult(JudgeConfig, { onExcessProperty: "error" })(input.config);
  if (Result.isFailure(parsed)) return schemaDiagnostic(input.configPath, parsed.failure.issue, "judges");
  const definitions = parsed.success.judges ?? {};
  if (Object.hasOwn(definitions, noJudgeName)) return configDiagnostic(input.configPath, "judges.off", noJudgeName, "off は判定なしを表す予約名です");
  const explicit = input.flags.judge ?? input.envJudge ?? parsed.success.judge;
  const name = explicit ?? defaultJudgeName;
  const read = readDefinitions(input.configPath, definitions);
  if (!read.ok) return read;
  if (name === noJudgeName) return { ok: true, judge: undefined };
  const judges = availableJudges(read);
  const judge = judges.find((candidate) => candidate.name === name);
  if (judge === undefined) return { ok: false, lines: [
    oneLine(`判定のモデル ${name} が設定にありません。`),
    oneLine(`選べるのは ${[...judges.map((candidate) => candidate.name), noJudgeName].join("・")} です（${input.configPath}）`),
  ] };
  return input.local ? localChoice(judge, explicit) : { ok: true, judge };
};

export const missingKeyNotice = (judge: Pick<JudgeModel, "name">, missing: readonly string[]): string =>
  oneLine(`判定のモデル ${judge.name} の鍵がありません（環境変数 ${missing.join("・")}）。判定なしで始めます`);

export const selectJudge = (input: JudgeInput & { readonly apiKeys: Readonly<Record<string, string | undefined>> }):
  Refusal | (Chosen & { readonly notice?: string }) => {
  const candidate = judgeCandidate(input);
  if (!candidate.ok || candidate.judge === undefined) return candidate;
  const missing = judgeEnvs(candidate.judge).filter((name) => (input.apiKeys[name] ?? "").trim() === "");
  if (missing.length === 0) return candidate;
  return {
    ok: true, judge: undefined,
    notice: missingKeyNotice(candidate.judge, missing),
  };
};
