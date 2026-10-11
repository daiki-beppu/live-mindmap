// ふつうの語の一覧（Issue #641）。wordfreq 3.1.1 の top_n_list('ja', 50000) を同梱し、補正の守りに使う。
// 一覧のファイルは core の外（FileSystem）で読み、core の correctRemark へは Set として渡す。
import { join } from "node:path";
import { Effect, FileSystem } from "effect";

export const COMMON_WORDS_PATH = join(import.meta.dirname, "../data/wordfreq-ja-top50000.txt");

// 1 行 1 語。# で始まる行（出典・ライセンスの表示）と空行は語に入れない
export const loadCommonWords = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    const words = text.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith("#"));
    return new Set(words) as ReadonlySet<string>;
  });
