import { Effect } from "effect";
import type { LogEvent, Session } from "./core/index.ts";
import { makeSessionVocabulary, type ReadingSource } from "./sessionVocabulary.ts";

type VocabLine = Extract<LogEvent, { type: "vocab" }>;

export const logReadings = (vocab: ReadonlyArray<VocabLine>): ReadingSource => {
  const readingOf = new Map<string, string>();
  for (const line of vocab) {
    for (const word of line.words) {
      if (word.romaji !== null && !readingOf.has(word.surface)) readingOf.set(word.surface, word.romaji);
    }
  }
  return (surfaces) => Effect.sync(() => new Map(surfaces.flatMap((surface) => {
    const romaji = readingOf.get(surface);
    return romaji === undefined ? [] : [[surface, romaji] as const];
  })));
};

export const withReplayCorrection = Effect.fnUntraced(function* (
  session: Session,
  options: {
    readonly vocab: ReadonlyArray<VocabLine>;
    readonly commonWords: ReadonlySet<string>;
    readonly appendLog: (event: LogEvent) => Effect.Effect<void>;
  },
) {
  const { vocab, commonWords, appendLog } = options;
  const read = logReadings(vocab);
  const words = vocab.flatMap((line) => line.words);
  const carriedSurfaces = [...new Set(words.filter((word) => word.source === "carried").map((word) => word.surface))];
  const carriedReadings = yield* read(carriedSurfaces);
  const vocabulary = yield* makeSessionVocabulary({
    read, commonWords, log: appendLog,
    carried: carriedSurfaces.map((surface) => ({ surface, romaji: carriedReadings.get(surface) ?? null })),
  });
  yield* vocabulary.addUser(words.filter((word) => word.source === "user").map((word) => word.surface));
  yield* vocabulary.settled;

  return {
    ...session,
    push: (remark, original) =>
      Effect.gen(function* () {
        if (original === undefined) return yield* session.push(remark);
        const { rest } = yield* vocabulary.correct({ ...remark, text: original.raw, words: original.words });
        yield* session.push({ ...remark, text: rest.text }, original);
      }),
    pushScreen: (change, lines) =>
      Effect.gen(function* () {
        yield* session.pushScreen(change, lines);
        yield* vocabulary.addScreen(lines);
        yield* vocabulary.settled;
      }),
  } satisfies Session;
});

