import { Result, Schema } from "effect";
import { configDiagnostic, schemaDiagnostic } from "./modelSelection.ts";

const JudgeDefinition = Schema.Struct({
  // route と apiKeyEnv は組み込みの時間切れだけを上書きする項目（timeoutMs のみ）では省ける。項目ごとの検証は judgeCandidate で行う。
  route: Schema.optionalKey(Schema.Literal("system-one")),
  apiKeyEnv: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  url: Schema.optionalKey(Schema.NonEmptyString),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
const JudgeConfig = Schema.Struct({
  judge: Schema.optionalKey(Schema.NonEmptyString),
  judges: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, JudgeDefinition)),
  // 差分更新のモデルの設定は modelSelection.ts が検証する。ここでは受け流す。
  default: Schema.optionalKey(Schema.Unknown),
  models: Schema.optionalKey(Schema.Unknown),
});

// start の本文で転送する判定のモデル（解決済みの JudgeModel と同じ形）
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
  readonly accountIdEnv?: string; // Workers AI の宛先に入れるアカウント ID の環境変数名（組み込みの clef 2 つだけ）
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

// 判定のモデルを呼ぶのに要る環境変数の名前（鍵・アカウント ID）
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

export const judgeCandidate = (input: JudgeInput): Refusal | Chosen => {
  const parsed = Schema.decodeUnknownResult(JudgeConfig, { onExcessProperty: "error" })(input.config);
  if (Result.isFailure(parsed)) return schemaDiagnostic(input.configPath, parsed.failure.issue, "judges");
  const definitions = parsed.success.judges ?? {};
  if (Object.hasOwn(definitions, noJudgeName)) return configDiagnostic(input.configPath, "judges.off", noJudgeName, "off は判定なしを表す予約名です");
  const explicit = input.flags.judge ?? input.envJudge ?? parsed.success.judge;
  const name = explicit ?? defaultJudgeName;
  const configured: JudgeModel[] = [];
  const overridden = new Map<string, number>();
  for (const [key, definition] of Object.entries(definitions)) {
    const where = `judges.${key}`;
    if (definition.route === undefined) {
      if (!builtIns.some((candidate) => candidate.name === key)) return configDiagnostic(input.configPath, where, "route", "route が必要です（時間切れだけを書けるのは組み込みの判定のモデルです）");
      for (const field of ["model", "url", "apiKeyEnv"] as const) {
        if (definition[field] !== undefined) return configDiagnostic(input.configPath, where, field, "route を書かない項目で指定できるのは timeoutMs だけです");
      }
      if (definition.timeoutMs === undefined) return configDiagnostic(input.configPath, where, "timeoutMs", "route を書かない項目には timeoutMs が必要です");
      overridden.set(key, definition.timeoutMs);
      continue;
    }
    if (definition.apiKeyEnv === undefined) return configDiagnostic(input.configPath, where, "apiKeyEnv", "apiKeyEnv が必要です");
    configured.push({ ...definition, route: definition.route, apiKeyEnv: definition.apiKeyEnv, name: key, timeoutMs: definition.timeoutMs ?? defaultTimeoutMs });
  }
  if (name === noJudgeName) return { ok: true, judge: undefined };
  const judges: readonly JudgeModel[] = [
    ...builtIns
      .filter((builtIn) => !configured.some((candidate) => candidate.name === builtIn.name))
      .map((builtIn) => ({ ...builtIn, timeoutMs: overridden.get(builtIn.name) ?? builtIn.timeoutMs })),
    ...configured,
  ];
  const judge = judges.find((candidate) => candidate.name === name);
  if (judge === undefined) return { ok: false, lines: [
    oneLine(`判定のモデル ${name} が設定にありません。`),
    oneLine(`選べるのは ${[...judges.map((candidate) => candidate.name), noJudgeName].join("・")} です（${input.configPath}）`),
  ] };
  if (input.local) {
    // 今ある経路（system-one）はすべてクラウド。ローカルモードでは明示されたときだけ断り、既定のときは判定なしで始める。
    if (explicit === undefined) return { ok: true, judge: undefined };
    return { ok: false, lines: [
      oneLine(`ローカルモードでは判定のモデル ${name} を選べません`),
      "ローカルモードで使える判定のモデルはありません。--judge off（または LIVE_MINDMAP_JUDGE・設定の judge に off）を指定するか、判定のモデルを明示しないでください",
    ] };
  }
  return { ok: true, judge };
};

export const selectJudge = (input: JudgeInput & { readonly apiKeys: Readonly<Record<string, string | undefined>> }):
  Refusal | (Chosen & { readonly notice?: string }) => {
  const candidate = judgeCandidate(input);
  if (!candidate.ok || candidate.judge === undefined) return candidate;
  const missing = judgeEnvs(candidate.judge).filter((name) => (input.apiKeys[name] ?? "").trim() === "");
  if (missing.length === 0) return candidate;
  return {
    ok: true, judge: undefined,
    notice: oneLine(`判定のモデル ${candidate.judge.name} の鍵がありません（環境変数 ${missing.join("・")}）。判定なしで始めます`),
  };
};
