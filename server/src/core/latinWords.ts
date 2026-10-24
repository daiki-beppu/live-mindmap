// STT は英字の製品名・サービス名をカタカナ（ノーション・フィグマ）で書く。読みのサブコマンドは英字を読めないので、
// 略語でない英字の語は、先にモデルにカタカナの読みを聞き、返ったカタカナを読みのサブコマンドでローマ字にする。

export type KatakanaAnswer = { readonly surface: string; readonly katakana: string };

const ABBREVIATION = /^[A-Z]{1,5}$/;
const LATIN = /^[A-Za-z0-9]+$/;
const HAS_LETTER = /[A-Za-z]/;
const KATAKANA_READING = /^[ァ-ヺー・]+$/;

export const isAbbreviation = (surface: string): boolean => ABBREVIATION.test(surface.normalize("NFKC"));

const isLatinWord = (surface: string): boolean => {
  const normalized = surface.normalize("NFKC");
  return LATIN.test(normalized) && HAS_LETTER.test(normalized);
};

export const wordsForKatakana = (surfaces: ReadonlyArray<string>): string[] =>
  surfaces.filter((surface) => isLatinWord(surface) && !isAbbreviation(surface));

export const katakanaTable = (asked: ReadonlyArray<string>, answered: ReadonlyArray<KatakanaAnswer>): ReadonlyMap<string, string> => {
  const askedSet = new Set(asked);
  const first = new Map<string, string>();
  for (const answer of answered) {
    if (askedSet.has(answer.surface) && !first.has(answer.surface)) first.set(answer.surface, answer.katakana);
  }
  return new Map([...first].filter(([, katakana]) => KATAKANA_READING.test(katakana)));
};
