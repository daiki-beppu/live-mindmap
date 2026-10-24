import { join } from "node:path";
import { Effect, FileSystem } from "effect";

export const COMMON_WORDS_PATH = join(import.meta.dirname, "../data/wordfreq-ja-top50000.txt");

export const loadCommonWords = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    const words = text.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith("#"));
    return new Set(words) as ReadonlySet<string>;
  });
