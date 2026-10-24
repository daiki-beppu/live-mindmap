import { Schema } from "effect";
import type { KatakanaAnswer } from "./core/index.ts";

export const KATAKANA_SYSTEM = `あなたは日本語の会議の音声認識を補正する係です。
英字で書かれた製品名・サービス名・固有名詞を、日本語の会議で話すときの自然なカタカナの読みに直します。
- 語ごとに、読みを 1 つだけ返す。カタカナ（長音「ー」・中黒「・」を含む）だけで書き、英字・ひらがな・漢字・空白は混ぜない
- 読みが分からない語は、その語を返さない
- 渡された語だけに答える。語を足さない`;

// strict な json_schema は根がオブジェクトである必要があるので、出力は { readings: [...] } にする。
export const KatakanaOutput = Schema.Struct({
  readings: Schema.Array(Schema.Struct({ word: Schema.String, katakana: Schema.String })),
});
export const KATAKANA_JSON_SCHEMA = Schema.toJsonSchemaDocument(KatakanaOutput, { onExcessProperty: "error" }).schema;

export const katakanaPrompt = (words: ReadonlyArray<string>): string =>
  ["## 読みを答える語", ...words.map((word) => `- ${word}`)].join("\n");

export const toAnswers = (output: typeof KatakanaOutput["Type"]): KatakanaAnswer[] =>
  output.readings.map((r) => ({ surface: r.word, katakana: r.katakana }));
