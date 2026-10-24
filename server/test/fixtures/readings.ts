import { Deferred, Effect, Layer } from "effect";
import { Readings, ReadingsFailed } from "../../src/readings.ts";

export type FakeReadings = {
  layer: Layer.Layer<Readings>;
  calls: string[][];
  table: Record<string, string>;
  failure: { reason: string | null };
  gate: { current: Deferred.Deferred<void> | null };
};

export function fakeReadings(table: Record<string, string> = {}): FakeReadings {
  const calls: FakeReadings["calls"] = [];
  const failure: FakeReadings["failure"] = { reason: null };
  const gate: FakeReadings["gate"] = { current: null };
  return {
    layer: Layer.succeed(Readings, Readings.of({
      readings: (words) => Effect.gen(function* () {
        calls.push([...words]);
        if (gate.current !== null) yield* Deferred.await(gate.current);
        if (failure.reason !== null) return yield* new ReadingsFailed({ message: failure.reason });
        return words.flatMap((surface) => {
          const romaji = table[surface];
          return romaji === undefined ? [] : [{ surface, romaji }];
        });
      }),
    })),
    calls,
    table,
    failure,
    gate,
  };
}
