// 英字の語（Notion・Figma など）を、モデルにカタカナの読みで聞くための部品（Issue #642）。I/O を持たない純粋な関数。
// STT は英字の製品名・サービス名をカタカナ（ノーション・フィグマ）で書く。読みのサブコマンドは英字を読めないので、
// 略語でない英字の語は、先にモデルにカタカナの読みを聞き、返ったカタカナを読みのサブコマンドでローマ字にする。

// モデルが返した、語 1 つ分のカタカナの読み
export type KatakanaAnswer = { readonly surface: string; readonly katakana: string };

const ABBREVIATION = /^[A-Z]{1,5}$/;
const LATIN = /^[A-Za-z0-9]+$/;
const HAS_LETTER = /[A-Za-z]/;
const KATAKANA_READING = /^[ァ-ヺー・]+$/;

// 略語: NFKC で正規化した後、大文字（A–Z）だけで 5 字以下の語（OJT・KPI）。略語は読みのサブコマンドが字ごとに読む
export const isAbbreviation = (surface: string): boolean => ABBREVIATION.test(surface.normalize("NFKC"));

const isLatinWord = (surface: string): boolean => {
  const normalized = surface.normalize("NFKC");
  return LATIN.test(normalized) && HAS_LETTER.test(normalized);
};

// モデルに聞く語: 英字（A–Z・a–z）と数字だけからなり、英字を 1 字以上含む、略語でない語。入力の順で返す
export const wordsForKatakana = (surfaces: ReadonlyArray<string>): string[] =>
  surfaces.filter((surface) => isLatinWord(surface) && !isAbbreviation(surface));

// モデルの返り値を、語 → カタカナの読みの表にする。聞いた語だけを残し、1 語につき最初の答え 1 つだけを採る
// （最初の答えが不正なら、その語は読みなし。2 つ目以降で補わない）。カタカナ・長音・中黒だけの空でない値だけを受け付ける
export const katakanaTable = (asked: ReadonlyArray<string>, answered: ReadonlyArray<KatakanaAnswer>): ReadonlyMap<string, string> => {
  const askedSet = new Set(asked);
  const first = new Map<string, string>();
  for (const answer of answered) {
    if (askedSet.has(answer.surface) && !first.has(answer.surface)) first.set(answer.surface, answer.katakana);
  }
  return new Map([...first].filter(([, katakana]) => KATAKANA_READING.test(katakana)));
};
