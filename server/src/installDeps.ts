import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Helpers, HelperCheckFailure, HelperInstallFailure } from "./helpers.ts";
import { ManagedDeps, ManagedDepsFailed } from "./managedDeps.ts";
import { speechJaItem } from "./managedDepsCheck.ts";
import type { DepNames, InstallEvent, Item } from "./managedDepsProtocol.ts";

class InstallationFailed extends Schema.TaggedError<InstallationFailed>()("InstallationFailed", { message: Schema.String }) {}

export class InstallDeps extends Context.Service<InstallDeps, {
  install: (names: typeof DepNames.Type) => Stream.Stream<typeof InstallEvent.Type, ManagedDepsFailed | HelperInstallFailure | HelperCheckFailure | InstallationFailed>;
}>()("live-mindmap/server/InstallDeps") {
  static readonly layer = Layer.effect(InstallDeps)(Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    const helpers = yield* Helpers;
    let speechInstalling = false;
    const install = (names: typeof DepNames.Type) => Stream.unwrap(Effect.gen(function* () {
      const speech = names.includes("speech-ja");
      if (speech) {
        yield* Effect.acquireRelease(Effect.gen(function* () {
          if (speechInstalling) return yield* new InstallationFailed({ message: "導入中です" });
          speechInstalling = true;
        }), () => Effect.sync(() => { speechInstalling = false; }));
      }
      const items: Array<typeof Item.Type> = [];
      const managed = names.filter((name) => name !== "speech-ja");
      const managedEvents = managed.length === 0 ? Stream.empty : deps.install(managed).pipe(Stream.filter((event) => {
        if (event.type === "progress") return true;
        items.push(...event.items);
        return false;
      }));
      const speechEvents = speech ? Stream.concat(
        helpers.installSpeechJa.pipe(Stream.map((message) => ({ type: "progress" as const, message }))),
        Stream.drain(Stream.fromEffect(Effect.gen(function* () {
          const status = yield* helpers.check({ screen: false });
          const item = speechJaItem(status.speechJa);
          if (item.state !== "ready") return yield* new InstallationFailed({ message: "日本語の音声認識モデルを導入できませんでした" });
          items.push(item);
        }))),
      ) : Stream.empty;
      return Stream.concat(Stream.concat(managedEvents, speechEvents), Stream.fromEffect(Effect.sync(() => ({ type: "result" as const, items }))));
    }));
    return InstallDeps.of({ install });
  }));
}
