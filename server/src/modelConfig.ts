import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { judgeCandidate, judgeEnvs, selectJudge, type JudgeFlags } from "./judgeSelection.ts";
import { configDiagnostic, listModels, modelCandidate, selectModel, type ModelFlags } from "./modelSelection.ts";
import { fileReason } from "./truthFile.ts";
import { AppleIntelligence } from "./appleIntelligence.ts";

export class ModelRefused extends Schema.TaggedError<ModelRefused>()("ModelRefused", { message: Schema.String }) {}
const reject = (lines: readonly string[]) => new ModelRefused({ message: lines.join("\n") });
const loadModelConfig = Effect.fn("loadModelConfig")(function* () {
  const override = yield* Config.option(Config.String("LIVE_MINDMAP_CONFIG"));
  const home = yield* Config.String("HOME").pipe(Config.withDefault(homedir()));
  const configPath = Option.getOrElse(override, () => join(home, ".live-mindmap", "config.json"));
  const envModel = Option.getOrUndefined(yield* Config.option(Config.String("LIVE_MINDMAP_MODEL")));
  const envJudge = Option.getOrUndefined(yield* Config.option(Config.String("LIVE_MINDMAP_JUDGE")));
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(configPath).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.void),
    Effect.mapError((error) => reject(configDiagnostic(configPath, "設定", "ファイル", fileReason(error)).lines)),
  );
  const config: unknown = text === undefined ? {} : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => reject(configDiagnostic(configPath, "設定", "JSON", "JSON として読めません").lines)),
  );
  return { config, configPath, envModel, envJudge, macState: {} };
});
const resolveCandidate = Effect.fn("resolveCandidate")(function* (flags: ModelFlags) {
  const input = { ...yield* loadModelConfig(), flags };
  const candidate = modelCandidate(input);
  if (!candidate.ok) return yield* reject(candidate.lines);
  return { input, candidate };
});
export const resolveModelCandidate = Effect.fn("resolveModelCandidate")(function* (flags: ModelFlags) {
  return (yield* resolveCandidate(flags)).candidate.model;
});
export const resolveModel = Effect.fn("resolveModel")(function* (flags: ModelFlags) {
  const { input, candidate } = yield* resolveCandidate(flags);
  if (candidate.model.route !== "apple") return candidate.model;
  const macState = yield* (yield* AppleIntelligence).availability.pipe(Effect.mapError((error) => new ModelRefused({ message: error.message })));
  const result = selectModel({ ...input, macState });
  return result.ok ? result.model : yield* reject(result.lines);
});
// 差分更新のモデルを利用者が名指ししたか（--model・LIVE_MINDMAP_MODEL・設定の default）。名指ししたときは判定で振り分けない
export const modelChosenByUser = Effect.fn("modelChosenByUser")(function* (flags: ModelFlags) {
  const { config, envModel } = yield* loadModelConfig();
  const configured = typeof config === "object" && config !== null && "default" in config && config.default !== undefined;
  return flags.model !== undefined || envModel !== undefined || configured;
});
export const configuredModels = Effect.fn("configuredModels")(function* () {
  const input = yield* loadModelConfig();
  const definitions = listModels(input);
  if (!definitions.ok) return yield* reject(definitions.lines);
  const macState = yield* (yield* AppleIntelligence).availability.pipe(Effect.mapError((error) => new ModelRefused({ message: error.message })));
  const result = listModels({ ...input, macState });
  return result.ok ? result.models : yield* reject(result.lines);
});

// 判定のモデルは差分更新のモデルとは独立に、開始時に一度だけ決める。local は差分更新のモデルの選択結果から渡す。
export const resolveJudge = Effect.fn("resolveJudge")(function* (flags: JudgeFlags, local: boolean) {
  const { config, configPath, envJudge } = yield* loadModelConfig();
  const input = { flags, envJudge, config, configPath, local };
  const candidate = judgeCandidate(input);
  if (!candidate.ok) return yield* reject(candidate.lines);
  const apiKeys: Record<string, string | undefined> = {};
  for (const name of candidate.judge === undefined ? [] : judgeEnvs(candidate.judge)) {
    apiKeys[name] = Option.getOrUndefined(yield* Config.option(Config.String(name)));
  }
  const result = selectJudge({ ...input, apiKeys });
  return result.ok ? result : yield* reject(result.lines);
});
