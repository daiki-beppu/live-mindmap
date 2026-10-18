import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { configDiagnostic, listModels, modelCandidate, selectModel, type ModelFlags } from "./modelSelection.ts";
import { fileReason } from "./truthFile.ts";
import { AppleIntelligence } from "./appleIntelligence.ts";

export class ModelRefused extends Schema.TaggedError<ModelRefused>()("ModelRefused", { message: Schema.String }) {}
export const reject = (lines: readonly string[]) => new ModelRefused({ message: lines.join("\n") });
export const loadModelConfig = Effect.fn("loadModelConfig")(function* () {
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
type LoadedModelConfig = Effect.Success<ReturnType<typeof loadModelConfig>>;
export const resolveModelCandidate = Effect.fn("resolveModelCandidate")(function* (flags: ModelFlags) {
  const candidate = modelCandidate({ ...(yield* loadModelConfig()), flags });
  return candidate.ok ? candidate.model : yield* reject(candidate.lines);
});
// 読み込み済みの設定から差分更新のモデルを選ぶ。apple を選んだときだけ Mac の利用可否を問い合わせる
export const resolveModelFrom = Effect.fn("resolveModelFrom")(function* (loaded: LoadedModelConfig, flags: ModelFlags) {
  const input = { ...loaded, flags };
  const candidate = modelCandidate(input);
  if (!candidate.ok) return yield* reject(candidate.lines);
  if (candidate.model.route !== "apple") return candidate.model;
  const macState = yield* (yield* AppleIntelligence).availability.pipe(Effect.mapError((error) => new ModelRefused({ message: error.message })));
  const result = selectModel({ ...input, macState });
  return result.ok ? result.model : yield* reject(result.lines);
});
export const resolveModel = Effect.fn("resolveModel")(function* (flags: ModelFlags) {
  return yield* resolveModelFrom(yield* loadModelConfig(), flags);
});
export const configuredModels = Effect.fn("configuredModels")(function* () {
  const input = yield* loadModelConfig();
  const definitions = listModels(input);
  if (!definitions.ok) return yield* reject(definitions.lines);
  const macState = yield* (yield* AppleIntelligence).availability.pipe(Effect.mapError((error) => new ModelRefused({ message: error.message })));
  const result = listModels({ ...input, macState });
  return result.ok ? result.models : yield* reject(result.lines);
});
