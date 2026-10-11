import { Deferred, Effect, Layer } from "effect";
import { Readings, ReadingsFailed } from "../../src/readings.ts";

export type FakeReadings = {
  layer: Layer.Layer<Readings>;
  // readings が呼ばれた回ごとの、渡された語の並び
  calls: string[][];
  // 語 → ローマ字の読み。ここに無い語は「読みが返らない語」として結果に含めない
  table: Record<string, string>;
  // 設定すると、次からの readings はこの理由で ReadingsFailed になる
  failure: { reason: string | null };
  // 設定すると、readings はこの Deferred が完了するまで結果を返さない（読みができる前後を作り分ける）
  gate: { current: Deferred.Deferred<void> | null };
};

// 読みのサブコマンド（Readings）の偽物。語ごとに table の読みを返し、呼び出しの引数を記録する
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
