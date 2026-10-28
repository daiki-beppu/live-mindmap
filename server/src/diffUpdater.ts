import { Context, Effect, Layer, Schema } from "effect";
import { AppleIntelligence } from "./appleIntelligence.ts";
import { prepareAppleUpdater } from "./appleDiffUpdater.ts";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import { DiffUpdater } from "./core/index.ts";
import { type ExecutableModel } from "./modelSelection.ts";
import { type JudgeModel } from "./judgeSelection.ts";
import { HAIKU, routedUpdater, SONNET } from "./routedDiffUpdater.ts";
import { makeSystemOne } from "./systemOne.ts";
import { localUpdaterLayer } from "./localDiffUpdater.ts";
import { prepareChatgpt } from "./chatgptResponses.ts";
import { prepareCompatible } from "./openaiCompatible.ts";
import { appleRefusal } from "./modelSelection.ts";

type ClaudeModel = Extract<ExecutableModel, { route: "claude" }>;

const loadClaude = Effect.fnUntraced(function* () {
  const { layerClaude, AgentSdk } = yield* Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e), dependency: "claude" }),
  });
  const sdk = yield* AgentSdk.pipe(Effect.provide(AgentSdk.layer));
  return (model: string) => layerClaude(model).pipe(Layer.provide(Layer.succeed(AgentSdk, sdk)));
}, Effect.mapError((error) => new UpdaterUnavailable({ message: error.message, dependency: "claude" })));

const prepareClaude = Effect.fnUntraced(function* (model: ClaudeModel) {
  return (yield* loadClaude())(model.model);
});

export const prepareRoutedLayer = Effect.fnUntraced(function* (judge: JudgeModel, keys: readonly string[]) {
  const ask = yield* makeSystemOne(judge, { apiKey: keys[0]!, ...(judge.accountIdEnv === undefined ? {} : { accountId: keys[1]! }) });
  const claude = yield* loadClaude();
  return Layer.effect(DiffUpdater, Effect.gen(function* () {
    const sonnet = Context.get(yield* Layer.build(claude(SONNET)), DiffUpdater);
    const haiku = Context.get(yield* Layer.build(claude(HAIKU)), DiffUpdater);
    return yield* routedUpdater({ ask, sonnet, haiku });
  }));
});

export const claudeUpdaterLayer = (model: Extract<ExecutableModel, { route: "claude" }>) => Layer.unwrap(prepareClaude(model));

export const prepareUpdaterLayer = Effect.fnUntraced(function* (model: ExecutableModel) {
  if (model.route === "claude") return yield* prepareClaude(model);
  if (model.route === "apple") {
    const state = yield* (yield* AppleIntelligence).availability;
    const refusal = appleRefusal(state);
    if (refusal !== undefined) return yield* new UpdaterUnavailable({ message: refusal.join("\n") });
    return yield* prepareAppleUpdater(model);
  }
  const remote = yield* (model.route === "chatgpt" ? prepareChatgpt(model) : prepareCompatible(model));
  return Layer.effect(DiffUpdater, Effect.gen(function* () {
    const legacy = Context.get(yield* Layer.build(localUpdaterLayer(remote)), DiffUpdater);
    return DiffUpdater.of({ ...legacy, update: (input) => input.criteria?.length ? remote.update(input) : legacy.update(input) });
  }));
}, Effect.mapError((failure) => Schema.is(UpdaterUnavailable)(failure) ? failure : new UpdaterUnavailable({ message: failure.message })));
