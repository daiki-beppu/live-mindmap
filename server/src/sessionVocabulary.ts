import { Context, Effect, Fiber, FiberSet, Ref, type Scope } from "effect";
import {
  correctRemark, katakanaTable, requestScreenWords, wordsForKatakana,
  type DiffUpdater, type LogEvent, type PoolWord, type Replacement,
  type ScreenVocabularyState, type SettledRemark, type VocabularyWord,
} from "./core/index.ts";
import type { Readings } from "./readings.ts";

export type ReadingSource = (surfaces: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, string>>;
export type VocabLogLine = Extract<LogEvent, { type: "vocab" }>;

export type CorrectedRemark = {
  rest: Omit<SettledRemark, "words" | "wordTimes">;
  original: { raw: string; words: NonNullable<SettledRemark["words"]> } | undefined;
  wordTimes: SettledRemark["wordTimes"];
  replacements: readonly Replacement[];
};

export const RemarkCorrection = Context.Reference("live-mindmap/RemarkCorrection", {
  defaultValue: (): typeof correctRemark => correctRemark,
});

export const modelReadings = (katakana: DiffUpdater["Service"]["katakana"], readings: Readings["Service"]): ReadingSource =>
  Effect.fnUntraced(function* (surfaces) {
    const asked = wordsForKatakana(surfaces);
    const askedSet = new Set(asked);
    // モデルが失敗した英字は直接読まず、読みなしとして記録する。
    const answered = asked.length > 0 && katakana !== undefined
      ? yield* katakana(asked).pipe(Effect.catch(() => Effect.succeed([])))
      : [];
    const table = katakanaTable(asked, answered);
    const toRead = [...new Set([...surfaces.filter((surface) => !askedSet.has(surface)), ...table.values()])];
    const read = toRead.length === 0
      ? []
      : yield* readings.readings(toRead).pipe(Effect.catchTag("ReadingsFailed", () => Effect.succeed([])));
    const romajiOf = new Map(read.map((r) => [r.surface, r.romaji] as const));
    return new Map(surfaces.flatMap((surface) => {
      const key = askedSet.has(surface) ? table.get(surface) : surface;
      const romaji = key === undefined ? undefined : romajiOf.get(key);
      return romaji ? [[surface, romaji] as const] : [];
    }));
  });

export type SessionVocabulary = {
  correct: (settled: SettledRemark) => Effect.Effect<CorrectedRemark>;
  addUser: (words: ReadonlyArray<string>) => Effect.Effect<Effect.Effect<void>>;
  addScreen: (lines: ReadonlyArray<string> | undefined, from?: number) => Effect.Effect<Effect.Effect<void>>;
  settled: Effect.Effect<void>;
};

export const makeSessionVocabulary = Effect.fnUntraced(function* (options: {
  read: ReadingSource;
  commonWords: ReadonlySet<string>;
  log: (line: VocabLogLine) => Effect.Effect<void>;
  carried: ReadonlyArray<Pick<PoolWord, "surface" | "romaji">>;
}): Effect.fn.Return<SessionVocabulary, never, Scope.Scope> {
  const { read, commonWords, log, carried } = options;
  const vocabulary = yield* Ref.make<ReadonlyArray<VocabularyWord & { readonly from?: number }>>([]);
  const screenState = yield* Ref.make<ScreenVocabularyState>({
    seen: new Map(), requested: new Set(carried.map((w) => w.surface)),
  });
  const adds = yield* FiberSet.make();
  if (carried.length > 0) {
    yield* Effect.uninterruptible(Effect.gen(function* () {
      yield* log({ type: "vocab", words: carried.map((w) => ({ surface: w.surface, romaji: w.romaji, source: "carried" })) });
      yield* Ref.set(vocabulary, carried.flatMap((w) => w.romaji === null ? [] : [{ surface: w.surface, romaji: w.romaji }]));
    }));
  }

  const add = (surfaces: ReadonlyArray<string>, source: "user" | "screen", from?: number) =>
    Effect.uninterruptible(Effect.gen(function* () {
      // Scope 閉鎖で中断するのは読み待ちだけ。記録と有効化は分断しない。
      const found = yield* Effect.interruptible(read(surfaces)).pipe(
        Effect.onInterrupt(() => log({ type: "vocab", words: surfaces.map((surface) => ({ surface, romaji: null, source })) })),
      );
      const words = surfaces.map((surface) => ({ surface, romaji: found.get(surface) || null, source }));
      yield* log({ type: "vocab", words });
      const usable = words.flatMap((w) => w.romaji === null ? [] : [{ surface: w.surface, romaji: w.romaji, ...(from === undefined ? {} : { from }) }]);
      yield* Ref.update(vocabulary, (current) => [...current, ...usable]);
    }));

  const correct = Effect.fnUntraced(function* (settled: SettledRemark) {
    const { words, wordTimes, ...rest } = settled;
    if (words === undefined) return { rest, original: undefined, wordTimes, replacements: [] } satisfies CorrectedRemark;
    const effective = (yield* Ref.get(vocabulary)).filter((w) => w.from === undefined || w.from < rest.end);
    const correction = yield* RemarkCorrection;
    const { text, replacements } = correction(effective, rest.text, words, commonWords);
    return { rest: { ...rest, text }, original: { raw: rest.text, words }, wordTimes, replacements } satisfies CorrectedRemark;
  });

  return {
    correct,
    // 要求の確保と FiberSet への登録の間で中断すると、語の記録を失う。
    addUser: (words) => Effect.uninterruptible(Effect.gen(function* () {
      const fresh = yield* Ref.modify(screenState, (state) => {
        const surfaces = [...new Set(words.filter((w) => w !== "" && !state.requested.has(w)))];
        return [surfaces, { ...state, requested: new Set([...state.requested, ...surfaces]) }] as const;
      });
      if (fresh.length === 0) return Effect.void;
      return Fiber.join(yield* FiberSet.run(adds, add(fresh, "user"), { startImmediately: true }));
    })),
    addScreen: (lines, from) => Effect.uninterruptible(Effect.gen(function* () {
      if (lines === undefined || lines.length === 0) return Effect.void;
      const fresh = yield* Ref.modify(screenState, (state) => requestScreenWords(state, lines));
      if (fresh.length === 0) return Effect.void;
      return Fiber.join(yield* FiberSet.run(adds, add(fresh, "screen", from), { startImmediately: true }));
    })),
    settled: FiberSet.awaitEmpty(adds),
  };
});
