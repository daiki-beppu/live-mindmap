import { describe, expect, it } from "vitest";
import { correctRemark, type VocabularyWord, type Word } from "../src/core/index.ts";

// Issue #640: 発言の補正の部品（I/O なし）。語彙と、語ごとの読みつきの発言から、直した本文と置き換えの一覧を返す。
// 照合のキー・区間・近さ・守りは #633「照合と置き換え」のとおり。ふつうの語の一覧の守りは別のチケット（#641）なので、ここでは扱わない。
// 語の読み（romaji）は、実際の CFStringTokenizer（ja）が返した値（macOS で確認）を使う。
// 「(合成)」と書いた行だけは、トークナイザの出力ではなく守りを当てるために組んだ読み。

type Token = readonly [surface: string, romaji: string];

// 語の並びから本文と words を組む。location / length は UTF-16 コード単位（連続して並ぶ）
const utterance = (...tokens: Token[]): { text: string; words: Word[] } => {
  let location = 0;
  const words = tokens.map(([surface, romaji]) => {
    const word = { surface, romaji, location, length: surface.length };
    location += surface.length;
    return word;
  });
  return { text: tokens.map(([surface]) => surface).join(""), words };
};

const vocab = (surface: string, romaji: string): VocabularyWord => ({ surface, romaji });

const correct = (vocabulary: VocabularyWord[], ...tokens: Token[]) => {
  const { text, words } = utterance(...tokens);
  return correctRemark(vocabulary, text, words);
};

const PUNCT: Token = ["。", "｡"];

describe("correctRemark: 正しく直す", () => {
  const cases: Array<{
    name: string;
    vocabulary: VocabularyWord[];
    tokens: Token[];
    text: string;
    replacement: { location: number; length: number; span: string; surface: string; score: number };
  }> = [
    {
      name: "ノーション→Notion（長音記号を外した読みで完全一致）",
      vocabulary: [vocab("Notion", "nōshon")],
      tokens: [["ノー", "nō"], ["ション", "shon"], ["で", "de"], ["管理", "kanri"], ["し", "shi"], ["ます", "masu"], PUNCT],
      text: "Notionで管理します。",
      replacement: { location: 0, length: 5, span: "ノーション", surface: "Notion", score: 1 },
    },
    {
      name: "全デスク→Zendesk（2 語の区間。前後のひらがなの語は含めない）",
      vocabulary: [vocab("Zendesk", "zendesuku")],
      tokens: [["今日", "kyou"], ["は", "ha"], ["全", "zen"], ["デスク", "desuku"], ["で", "de"], ["確認", "kakunin"], ["し", "shi"], ["ます", "masu"], PUNCT],
      text: "今日はZendeskで確認します。",
      replacement: { location: 3, length: 4, span: "全デスク", surface: "Zendesk", score: 1 },
    },
    {
      name: "江南店→港南店（読みが同じ別の表記）",
      vocabulary: [vocab("港南店", "kounanten")],
      tokens: [["江南", "kounan"], ["店", "ten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]],
      text: "港南店に行きます",
      replacement: { location: 0, length: 3, span: "江南店", surface: "港南店", score: 1 },
    },
    {
      name: "野野村→野々村（2 語に割れた区間を 1 語に直す）",
      vocabulary: [vocab("野々村", "nonomura")],
      tokens: [["野", "no"], ["野村", "nomura"], ["さん", "san"], ["です", "desu"]],
      text: "野々村さんです",
      replacement: { location: 0, length: 3, span: "野野村", surface: "野々村", score: 1 },
    },
    {
      name: "スワッガー→Swagger（小さいカナ。トークナイザの suwa~tsu を落として suwaga にそろえる）",
      vocabulary: [vocab("Swagger", "suwagā")],
      tokens: [["スワッ", "suwa~tsu"], ["ガー", "gā"], ["を", "wo"], ["作る", "tsukuru"]],
      text: "Swaggerを作る",
      replacement: { location: 0, length: 5, span: "スワッガー", surface: "Swagger", score: 1 },
    },
    {
      name: "トゥイッチ→Twitch（小さいカナの ~ を外した読みで完全一致）",
      vocabulary: [vocab("Twitch", "to~uitchi")],
      tokens: [["トゥイッチ", "to~uitchi"], ["を", "wo"], ["見る", "miru"]],
      text: "Twitchを見る",
      replacement: { location: 0, length: 5, span: "トゥイッチ", surface: "Twitch", score: 1 },
    },
    {
      name: "ou は o に寄せて比べる（長音の書き分けを同じ読みとして扱う）",
      vocabulary: [vocab("港南店", "kōnanten")],
      tokens: [["江南", "kounan"], ["店", "ten"]],
      text: "港南店",
      replacement: { location: 0, length: 3, span: "江南店", surface: "港南店", score: 1 },
    },
  ];

  it.each(cases)("$name", ({ vocabulary, tokens, text, replacement }) => {
    const result = correct(vocabulary, ...tokens);
    expect(result.text).toBe(text);
    expect(result.replacements).toEqual([replacement]);
  });

  it("5 語の区間まで直せる", () => {
    const result = correct([vocab("Quick", "kakikukeko")], ["カ", "ka"], ["キ", "ki"], ["ク", "ku"], ["ケ", "ke"], ["コ", "ko"]);
    expect(result.text).toBe("Quick");
    expect(result.replacements).toEqual([{ location: 0, length: 5, span: "カキクケコ", surface: "Quick", score: 1 }]);
  });

  it("補助平面の文字（UTF-16 で 2 コード単位）が前にあっても、置き換えの位置は UTF-16 で本文に合う", () => {
    const result = correct([vocab("港南店", "kounanten")], ["𠮷", ""], ["野家", "noe"], ["で", "de"], ["江南", "kounan"], ["店", "ten"]);
    expect(result.text).toBe("𠮷野家で港南店");
    expect(result.replacements).toEqual([{ location: 5, length: 3, span: "江南店", surface: "港南店", score: 1 }]);
  });

  it("離れた 2 か所は、それぞれ別の置き換えとして、元の本文の位置で返る", () => {
    const result = correct(
      [vocab("Zendesk", "zendesuku"), vocab("港南店", "kounanten")],
      ["全", "zen"], ["デスク", "desuku"], ["と", "to"], ["江南", "kounan"], ["店", "ten"],
    );
    expect(result.text).toBe("Zendeskと港南店");
    expect([...result.replacements].sort((a, b) => a.location - b.location)).toEqual([
      { location: 0, length: 4, span: "全デスク", surface: "Zendesk", score: 1 },
      { location: 5, length: 3, span: "江南店", surface: "港南店", score: 1 },
    ]);
  });
});

describe("correctRemark: 近さ（1 − 距離 ÷ 長い方の長さ）", () => {
  // (合成) キーの長さ 10 で、読みが 2 字違う → 近さ 0.8 ちょうどで置き換える
  it("近さが 0.8 ちょうどなら置き換える。置き換えの一覧に近さが入る", () => {
    const result = correct([vocab("山田工房", "yamadakoubou")], ["ヤメダコブ", "yamedakobu"]);
    expect(result.text).toBe("山田工房");
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]!.score).toBeCloseTo(0.8, 10);
  });

  // (合成) 3 字違い → 近さ 0.7
  it("近さが 0.8 に届かなければ直さない", () => {
    const result = correct([vocab("山田工房", "yamadakoubou")], ["イエメダコブ", "yemedakobu"]);
    expect(result.text).toBe("イエメダコブ");
    expect(result.replacements).toEqual([]);
  });

  // (合成) キー suwaga（6 字）に対して suwagu（1 字違い）→ 近さ 5/6
  it("キーが 6 字以上なら、1 字違いの近似でも置き換える", () => {
    const result = correct([vocab("Swagger", "suwagā")], ["スワグー", "suwagū"]);
    expect(result.text).toBe("Swagger");
    expect(result.replacements[0]!.score).toBeCloseTo(5 / 6, 10);
  });

  it("キーが 3 字未満の区間は候補にしない", () => {
    const result = correct([vocab("ノ", "no")], ["ノ", "no"], ["ー", "-"]);
    expect(result.replacements).toEqual([]);
  });
});

describe("correctRemark: 直さない（守り）", () => {
  it("語彙が空なら、本文をそのまま返す", () => {
    const result = correct([], ["江南", "kounan"], ["店", "ten"]);
    expect(result).toEqual({ text: "江南店", replacements: [] });
  });

  it("1 文字の区間は、読みが一致しても直さない", () => {
    // 龍 → 竜 は読みが ryuu で完全一致するが、1 文字の区間
    const result = correct([vocab("竜", "ryuu")], ["龍", "ryuu"], ["が", "ga"], ["来", "ki"], ["た", "ta"]);
    expect(result).toEqual({ text: "龍が来た", replacements: [] });
  });

  it("端の語がひらがなだけの区間は候補にしない", () => {
    const result = correct([vocab("港南店", "kounanten")], ["こうなん", "kounan"], ["店", "ten"], ["に", "ni"], ["行く", "iku"]);
    expect(result.text).toBe("こうなん店に行く");
    expect(result.replacements).toEqual([]);
  });

  // (合成) 語の表記はひらがなだけではないが、区間の最初の文字がひらがな
  it("区間の最初の文字がひらがななら、語がひらがなだけでなくても候補にしない", () => {
    const result = correct([vocab("野々村", "nonomura")], ["お野村", "nonomura"]);
    expect(result).toEqual({ text: "お野村", replacements: [] });
  });

  // (合成) 語の表記はひらがなだけではないが、区間の最後の文字がひらがな
  it("区間の最後の文字がひらがななら、語がひらがなだけでなくても候補にしない", () => {
    const result = correct([vocab("野々村", "nonomura")], ["野野村ん", "nonomura"]);
    expect(result).toEqual({ text: "野野村ん", replacements: [] });
  });

  it("すでに正しい表記の区間は直さない（置き換えの一覧にも出ない）", () => {
    const result = correct([vocab("野々村", "nonomura")], ["野々村", "nonomura"], ["さん", "san"]);
    expect(result).toEqual({ text: "野々村さん", replacements: [] });
  });

  // (合成) 表記は NFKC・小文字でそろえて比べる。全角の ＮＯＴＩＯＮ は Notion と同じ表記
  it("すでに正しい表記かどうかは、NFKC と小文字でそろえて比べる", () => {
    const result = correct([vocab("Notion", "notion")], ["ＮＯＴＩＯＮ", "notion"], ["で", "de"]);
    expect(result).toEqual({ text: "ＮＯＴＩＯＮで", replacements: [] });
  });

  // (合成) 語彙 港南店舗 は、5 字以下の完全一致の条件で候補から外れる。それでも港南の表記を含む区間は直さない
  it("正しい表記を含む区間は、5 字以下の完全一致の条件で別の語が外れても直さない（港南店 を 港南店舗 にしない）", () => {
    const result = correct([vocab("港南", "kounan"), vocab("港南店舗", "kounantenpo")], ["港南", "kounan"], ["店", "ten"]);
    expect(result).toEqual({ text: "港南店", replacements: [] });
  });

  // (合成) 語彙 湖南支店 は、長さの比で候補から外れる。それでも港南の表記を含む区間は直さない
  it("正しい表記を含む区間は、長さの比で別の語が外れても直さない（港南視点 を 湖南支店 にしない）", () => {
    const result = correct([vocab("港南", "kounan"), vocab("湖南支店", "kounanshiten")], ["港南", "kounan"], ["視点", "shiten"]);
    expect(result).toEqual({ text: "港南視点", replacements: [] });
  });

  // 近さ 0.857 で、端は漢字。置き換え先に「の」が無いので直さない
  it("区間の中のひらがなを落とす置き換え（出店の候補→出店候補）は直さない", () => {
    const result = correct([vocab("出店候補", "shuttenkouho")], ["出店", "shutten"], ["の", "no"], ["候補", "kouho"]);
    expect(result).toEqual({ text: "出店の候補", replacements: [] });
  });

  // (合成) 公報→候補 の読み違い。キーは同じで、置き換え先に「の」が残る
  it("置き換え先がそのひらがなを含むなら、ひらがなを含む区間も直せる", () => {
    const result = correct([vocab("出店の候補", "shuttennokouho")], ["出店", "shutten"], ["の", "no"], ["公報", "kouhou"]);
    expect(result.text).toBe("出店の候補");
    expect(result.replacements).toEqual([{ location: 0, length: 5, span: "出店の公報", surface: "出店の候補", score: 1 }]);
  });

  // キー noson（5 字）は完全一致だけ。1 字違いの nosan は近さ 0.8 でも置き換えない
  it("読みのキーが 5 字以下の語は、キーの完全一致だけで置き換える（短い読みの近似は直さない）", () => {
    const near = correct([vocab("Notion", "nōshon")], ["ノー", "nō"], ["サン", "san"]);
    expect(near).toEqual({ text: "ノーサン", replacements: [] });
    const exact = correct([vocab("Notion", "nōshon")], ["ノー", "nō"], ["ション", "shon"]);
    expect(exact.text).toBe("Notion");
  });

  it("句読点をまたぐ区間は作らない", () => {
    const result = correct([vocab("港南店", "kounanten")], ["江南", "kounan"], ["、", "､"], ["店", "ten"]);
    expect(result).toEqual({ text: "江南、店", replacements: [] });
  });

  it("空白をまたぐ区間は作らない（空白の語がある場合も、語の間に本文が挟まる場合も）", () => {
    const withToken = correct([vocab("港南店", "kounanten")], ["江南", "kounan"], [" ", ""], ["店", "ten"]);
    expect(withToken).toEqual({ text: "江南 店", replacements: [] });
    // 語と語の間に、どの語にも入っていない本文（空白）がある
    const words: Word[] = [
      { surface: "江南", romaji: "kounan", location: 0, length: 2 },
      { surface: "店", romaji: "ten", location: 3, length: 1 },
    ];
    expect(correctRemark([vocab("港南店", "kounanten")], "江南 店", words)).toEqual({ text: "江南 店", replacements: [] });
  });

  it("読みが空の語（読みが無い語）を含む区間は作らない", () => {
    const result = correct([vocab("港南店", "kounanten")], ["江南", "kounan"], ["？", ""], ["店", "ten"]);
    expect(result.replacements).toEqual([]);
  });

  it("words が空なら、本文をそのまま返す", () => {
    expect(correctRemark([vocab("港南店", "kounanten")], "江南店", [])).toEqual({ text: "江南店", replacements: [] });
  });
});

describe("correctRemark: 重なる区間の選び方", () => {
  const tokens: Token[] = [["カメラ", "kamera"], ["マン", "man"], ["ホース", "hosu"]];

  // (合成) 長い区間 カメラマンホース の近さは 12/13、短い区間 マンホース は 1.0
  it("重なる区間は、近さの高い方を採る（短くても）", () => {
    const result = correct([vocab("CameraManHose", "kameramanhoso"), vocab("ManHose", "manhosu")], ...tokens);
    expect(result.text).toBe("カメラManHose");
    expect(result.replacements).toEqual([{ location: 3, length: 5, span: "マンホース", surface: "ManHose", score: 1 }]);
  });

  // (合成) どちらも近さ 1.0。長い方を採る
  it("近さが同じなら、長い区間を採る", () => {
    const result = correct([vocab("ManHose", "manhosu"), vocab("CameraManHose", "kameramanhosu")], ...tokens);
    expect(result.text).toBe("CameraManHose");
    expect(result.replacements).toEqual([{ location: 0, length: 8, span: "カメラマンホース", surface: "CameraManHose", score: 1 }]);
  });

  // 港南炭（konantan）も近さ 0.875 で候補だが、港南店（完全一致）の方が近い。語彙の並びの順には依らない
  it("同じ区間に複数の語が近いときは、一番近い語に置き換える", () => {
    const result = correct([vocab("港南炭", "kounantan"), vocab("港南店", "kounanten")], ["江南", "kounan"], ["店", "ten"]);
    expect(result.text).toBe("港南店");
  });
});
