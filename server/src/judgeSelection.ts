import { Result, Schema } from "effect";
import { configDiagnostic, schemaDiagnostic } from "./modelSelection.ts";

const JudgeDefinition = Schema.Struct({
  route: Schema.Literal("system-one"),
  apiKeyEnv: Schema.NonEmptyString,
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

const defaultTimeoutMs = 1000;
const defaultJudgeName = "jev";
const noJudgeName = "off";
export type JudgeModel = {
  readonly name: string;
  readonly route: "system-one";
  readonly apiKeyEnv: string;
  readonly model?: string;
  readonly url?: string;
  readonly timeoutMs: number;
};
const builtIn: JudgeModel = { name: defaultJudgeName, route: "system-one", apiKeyEnv: "TYPESAFE_AI_API_KEY", timeoutMs: defaultTimeoutMs };

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
  if (name === noJudgeName) return { ok: true, judge: undefined };
  const judges: readonly JudgeModel[] = [
    ...(Object.hasOwn(definitions, defaultJudgeName) ? [] : [builtIn]),
    ...Object.entries(definitions).map(([key, definition]) => ({ ...definition, name: key, timeoutMs: definition.timeoutMs ?? defaultTimeoutMs })),
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
  if ((input.apiKeys[candidate.judge.apiKeyEnv] ?? "").trim() !== "") return candidate;
  return {
    ok: true, judge: undefined,
    notice: oneLine(`判定のモデル ${candidate.judge.name} の鍵がありません（環境変数 ${candidate.judge.apiKeyEnv}）。判定なしで始めます`),
  };
};
