import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runHelperCommand, stderrReason } from "./helpers.ts";
import type { HelperCommand } from "./helpers.ts";

export class ReadingsFailed extends Schema.TaggedError<ReadingsFailed>()("ReadingsFailed", { message: Schema.String }) {}

export const Reading = Schema.Struct({ surface: Schema.String, romaji: Schema.String });
export type Reading = typeof Reading["Type"];

const decodeReadings = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Reading)));

export class Readings extends Context.Service<Readings, {
  readonly readings: (words: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Reading>, ReadingsFailed>;
}>()("live-mindmap/server/Readings") {
  static readonly layer = (helper: HelperCommand): Layer.Layer<Readings, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(Readings)(make(helper));
}

const make = Effect.fnUntraced(function* (helper: HelperCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readings = (words: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Reading>, ReadingsFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdout, stderr, code } = yield* runHelperCommand(spawner, helper, ["readings", ...words]);
        if (code !== 0) return yield* new ReadingsFailed({ message: stderrReason(stderr, code) });
        return yield* decodeReadings(stdout).pipe(
          Effect.catchTag("SchemaError", () => Effect.fail(new ReadingsFailed({ message: `readings の出力が読めません: ${stdout.trim()}` }))),
        );
      }),
    ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new ReadingsFailed({ message: error.message }))));

  return Readings.of({ readings });
});
