import { readFileSync } from "node:fs";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { COMMON_WORDS_PATH, loadCommonWords } from "../src/commonWords.ts";

// Issue #641: 同梱の wordfreq 日本語上位 5 万語の一覧を読んで、補正に渡す一覧（Set）にする。
// 読み込みは core の外（Effect の FileSystem）で行う。本物のモデル・音声認識は使わない。
describe("同梱のふつうの語の一覧（wordfreq 日本語上位 5 万語）", () => {
  const load = loadCommonWords(COMMON_WORDS_PATH).pipe(Effect.provide(NodeFileSystem.layer));

  it.effect("1 行 1 語の Set になり、5 万語が入る。出典・ライセンスの行は語として入らない", () => Effect.gen(function* () {
    const words = yield* load;
    expect(words.size).toBe(50000);
    for (const word of ["開発", "相談", "時間", "ズーム"]) expect(words.has(word), word).toBe(true);
    for (const word of words) {
      expect(word.startsWith("#"), word).toBe(false);
      expect(word.trim(), word).toBe(word);
      expect(word, "空行が語として入っている").not.toBe("");
    }
    expect([...words].some((w) => w.includes("wordfreq") || w.includes("CC BY-SA"))).toBe(false);
  }));

  it("同梱ファイルに、出典（wordfreq 3.1.1・top_n_list('ja', 50000)・URL）と CC BY-SA 4.0 の表示がある", () => {
    const text = readFileSync(COMMON_WORDS_PATH, "utf8");
    for (const required of ["wordfreq", "3.1.1", "top_n_list('ja', 50000)", "https://github.com/rspeer/wordfreq", "CC BY-SA 4.0"]) {
      expect(text, required).toContain(required);
    }
  });
});
