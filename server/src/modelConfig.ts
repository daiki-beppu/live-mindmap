import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, FileSystem, Option, Schema } from "effect";
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
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(configPath).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.void),
    Effect.mapError((error) => reject(configDiagnostic(configPath, "設定", "ファイル", fileReason(error)).lines)),
  );
  const config: unknown = text === undefined ? {} : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => reject(configDiagnostic(configPath, "設定", "JSON", "JSON として読めません").lines)),
  );
  return { config, configPath, envModel, macState: {} };
});
export const resolveModel = Effect.fn("resolveModel")(function* (flags: ModelFlags) {
  const input = { ...yield* loadModelConfig(), flags };
  const candidate = modelCandidate(input);
  if (!candidate.ok) return yield* reject(candidate.lines);
  if (candidate.model.route !== "apple") return candidate.model;
  const macState = yield* (yield* AppleIntelligence).availability.pipe(Effect.mapError((error) => new ModelRefused({ message: error.message })));
  const result = selectModel({ ...input, macState });
  return result.ok ? result.model : yield* reject(result.lines);
});
export const configuredModels = Effect.fn("configuredModels")(function* () {
  const input = yield* loadModelConfig();
  const definitions = listModels(input);
  if (!definitions.ok) return yield* reject(definitions.lines);
  const macState = yield* (yield* AppleIntelligence).availability.pipe(Effect.mapError((error) => new ModelRefused({ message: error.message })));
  const result = listModels({ ...input, macState });
  return result.ok ? result.models : yield* reject(result.lines);
});
