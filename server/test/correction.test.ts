import { describe, expect, it } from "vitest";
import { correctRemark, placeCorrectionForCaptions, type VocabularyWord, type Word } from "../src/core/index.ts";

// Issue #640: 発言の補正の部品（I/O なし）。語彙と、語ごとの読みつきの発言から、直した本文と置き換えの一覧を返す。
// 照合のキー・区間・近さ・守りは #633「照合と置き換え」のとおり。ふつうの語の一覧の守りは Issue #641（末尾の describe）。一覧は小さな Set で渡し、同梱の 5 万語のファイルは読まない。
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

// ふつうの語の一覧が空のとき（#641 より前の挙動）
const correct = (vocabulary: VocabularyWord[], ...tokens: Token[]) => correctWith([], vocabulary, ...tokens);

const correctWith = (commonWords: readonly string[], vocabulary: VocabularyWord[], ...tokens: Token[]) => {
  const { text, words } = utterance(...tokens);
  return correctRemark(vocabulary, text, words, new Set(commonWords));
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
    expect(correctRemark([vocab("港南店", "kounanten")], "江南 店", words, new Set())).toEqual({ text: "江南 店", replacements: [] });
  });

  it("読みが空の語（読みが無い語）を含む区間は作らない", () => {
    const result = correct([vocab("港南店", "kounanten")], ["江南", "kounan"], ["？", ""], ["店", "ten"]);
    expect(result.replacements).toEqual([]);
  });

  it("words が空なら、本文をそのまま返す", () => {
    expect(correctRemark([vocab("港南店", "kounanten")], "江南店", [], new Set())).toEqual({ text: "江南店", replacements: [] });
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

// Issue #641: 区間の表記がふつうの語の一覧に載っていれば、語彙に読みの近い語があっても直さない。
// ただし英字の語（NFKC で英字だけ）への書き換えは通す。一覧に載らない区間は今までどおり直す。語彙の側は絞らない。
// 読みは実際のトークナイザの出力の形。「(合成)」は守りを当てるために組んだ読み。
describe("correctRemark: ふつうの語の一覧の守り（Issue #641）", () => {
  const cases: Array<{ name: string; vocabulary: VocabularyWord[]; tokens: Token[]; kept: string }> = [
    { name: "開発（kaihatsu）を 改札（kaisatsu）にしない", vocabulary: [vocab("改札", "kaisatsu")], tokens: [["開発", "kaihatsu"]], kept: "開発" },
    { name: "相談（soudan）を 商談（shoudan）にしない", vocabulary: [vocab("商談", "shoudan")], tokens: [["相談", "soudan"]], kept: "相談" },
    { name: "時間（jikan）を 実感（jikkan）にしない", vocabulary: [vocab("実感", "jikkan")], tokens: [["時間", "jikan"]], kept: "時間" },
  ];

  it.each(cases)("一覧に載る区間は直さない: $name", ({ vocabulary, tokens, kept }) => {
    expect(correctWith(["開発", "相談", "時間"], vocabulary, ...tokens)).toEqual({ text: kept, replacements: [] });
  });

  it.each(cases)("同じ入力で一覧が空なら直る（守りが一覧で効いている）: $name", ({ vocabulary, tokens, kept }) => {
    const result = correctWith([], vocabulary, ...tokens);
    expect(result.text).not.toBe(kept);
    expect(result.replacements).toHaveLength(1);
  });

  it("一覧に載る区間でも、英字の語への書き換えは通す（ズーム→Zoom、エクセル→Excel）", () => {
    const common = ["ズーム", "エクセル"];
    const zoom = correctWith(common, [vocab("Zoom", "zūmu")], ["ズーム", "zūmu"]);
    expect(zoom.text).toBe("Zoom");
    expect(zoom.replacements).toEqual([{ location: 0, length: 3, span: "ズーム", surface: "Zoom", score: 1 }]);
    const excel = correctWith(common, [vocab("Excel", "ekuseru")], ["エクセル", "ekuseru"]);
    expect(excel.text).toBe("Excel");
    expect(excel.replacements).toEqual([{ location: 0, length: 4, span: "エクセル", surface: "Excel", score: 1 }]);
  });

  // (合成) 英字でない語（先に並べる）と英字の語が同じ近さ。英字でない語は一覧の守りで候補から外れ、英字の語に直る
  it("一覧に載る区間で英字の語と英字でない語がどちらも近いときは、英字の語に直る", () => {
    const result = correctWith(["ズーム"], [vocab("図務", "zūmu"), vocab("Zoom", "zūmu")], ["ズーム", "zūmu"]);
    expect(result.text).toBe("Zoom");
  });

  it("全角の英字だけの語（ＺＯＯＭ）も英字の語として通す（NFKC）", () => {
    expect(correctWith(["ズーム"], [vocab("ＺＯＯＭ", "zūmu")], ["ズーム", "zūmu"]).text).toBe("ＺＯＯＭ");
  });

  it("英字と数字が混じる語（Web3）は英字の語ではないので、一覧に載る区間は直さない", () => {
    const result = correctWith(["ウェブ"], [vocab("Web3", "uebu")], ["ウェブ", "uebu"]);
    expect(result).toEqual({ text: "ウェブ", replacements: [] });
  });

  it("一覧に載らない区間は、一覧に別の語があっても今までどおり直る（江南店→港南店）", () => {
    const result = correctWith(["江南", "開発"], [vocab("港南店", "kounanten")], ["江南", "kounan"], ["店", "ten"]);
    expect(result.text).toBe("港南店");
    expect(result.replacements).toEqual([{ location: 0, length: 3, span: "江南店", surface: "港南店", score: 1 }]);
  });

  it("一覧は区間の表記と丸ごと同じものだけに効く。区間を含むだけの語・区間の一部だけの語は守りにならない", () => {
    // 一覧の 江南店舗 は区間 江南店 を含むだけ、江南 は区間の一部だけ
    const result = correctWith(["江南店舗", "江南"], [vocab("港南店", "kounanten")], ["江南", "kounan"], ["店", "ten"]);
    expect(result.text).toBe("港南店");
  });
});

// 字幕用の補正: 直す前の本文と語の時刻（wordTimes）から、直した後の本文と位置を作る（字幕が直した本文を語ごとに分けるため）
describe("placeCorrectionForCaptions", () => {
  // 吹き出しの id を run の位置から返す。all は run ごとに別の吹き出し
  const all = (w: { location: number }) => String(w.location);
  const time = (location: number, length: number, start: number, end: number) => ({ location, length, start, end });
  const replacement = (location: number, length: number, surface: string) => ({ location, length, span: "", surface, score: 1 });
  // 各 run の文字（本文を run の位置で切る）
  const pieces = (result: { text: string; wordTimes: readonly { location: number; length: number }[] }) => result.wordTimes.map((w) => result.text.slice(w.location, w.location + w.length));

  it("置き換えが無ければ、本文も位置もそのまま", () => {
    const wordTimes = [time(0, 3, 10, 12), time(3, 4, 12, 14)];

    expect(placeCorrectionForCaptions("あいうえおかき", wordTimes, [], all)).toEqual({ text: "あいうえおかき", wordTimes });
  });

  it("置き換えの先頭から始まる語の位置は保ち、後ろの語は長さの差だけずらす", () => {
    const wordTimes = [time(0, 3, 10, 12), time(3, 2, 12, 14), time(5, 2, 14, 15)];
    const result = placeCorrectionForCaptions("あいうえおかき", wordTimes, [replacement(3, 2, "Zendesk")], all);

    expect(result.text).toBe("あいうZendeskかき");
    expect(result.wordTimes.map((w) => w.location)).toEqual([0, 3, 10]);
    expect(pieces(result)).toEqual(["あいう", "Zendesk", "かき"]);
  });

  it("置き換えの内側から始まる語にも、直した表記の文字を 1 文字以上割り当てる（空にしない）", () => {
    const wordTimes = [time(0, 1, 10, 11), time(1, 3, 11, 12), time(4, 1, 12, 13)];
    const result = placeCorrectionForCaptions("あいうえお", wordTimes, [replacement(0, 4, "Zendesk")], all);

    expect(result.text).toBe("Zendeskお");
    expect(result.wordTimes.map((w) => w.location)).toEqual([0, 2, 7]);
    expect(pieces(result)).toEqual(["Ze", "ndesk", "お"]);
  });

  it("境目をまたぐ置き換え（野|野村 → 野々村）は、2 つの run に文字を分ける", () => {
    const result = placeCorrectionForCaptions("野野村", [time(0, 1, 10, 11), time(1, 2, 11, 12)], [replacement(0, 3, "野々村")], all);

    expect(pieces(result)).toEqual(["野", "々村"]);
  });

  it("1 文字が必要な区間の数が表記の文字数を超える置き換えは適用しない（イ|ワシ → 鰯）", () => {
    const wordTimes = [time(0, 1, 10, 11), time(1, 2, 11, 12)];

    expect(placeCorrectionForCaptions("イワシ", wordTimes, [replacement(0, 3, "鰯")], all)).toEqual({ text: "イワシ", wordTimes });
  });

  it("1 文字が必要な区間の数が表記の文字数ちょうどなら適用する", () => {
    const result = placeCorrectionForCaptions("イワシ", [time(0, 1, 10, 11), time(1, 2, 11, 12)], [replacement(0, 3, "いわし")], all);

    expect(pieces(result)).toEqual(["い", "わし"]);
  });

  it("適用できない置き換えが混ざっても、後ろの語は適用した置き換えの差だけずらす", () => {
    // 0〜3 は適用できない（鰯）、4〜6 は適用できる（Zendesk、内側なし）、その後ろに「を」
    const wordTimes = [time(0, 1, 10, 11), time(1, 2, 11, 12), time(3, 1, 12, 13), time(4, 2, 13, 14), time(6, 1, 14, 15)];
    const result = placeCorrectionForCaptions("イワシのあいを", wordTimes, [replacement(0, 3, "鰯"), replacement(4, 2, "Zendesk")], all);

    expect(result.text).toBe("イワシのZendeskを");
    expect(result.wordTimes.map((w) => w.location)).toEqual([0, 1, 3, 4, 11]);
    expect(pieces(result)).toEqual(["イ", "ワシ", "の", "Zendesk", "を"]);
  });

  it("サロゲートペアを含む表記は、ペアを割らない", () => {
    const result = placeCorrectionForCaptions("よしのや", [time(0, 1, 10, 11), time(1, 1, 11, 12), time(2, 2, 12, 13)], [replacement(0, 4, "𠮷野家")], all);

    expect(result.text).toBe("𠮷野家");
    expect(result.wordTimes.map((w) => w.location)).toEqual([0, 2, 3]);
    expect(pieces(result)).toEqual(["𠮷", "野", "家"]);
  });

  it("表示済みの吹き出しに属する run が無い（bubbleOf が常に undefined）なら、除いた run の文字と終わりの時刻を直前の run が引き継ぐ", () => {
    const result = placeCorrectionForCaptions("イワシ", [time(0, 1, 10, 11), time(1, 2, 11, 12)], [replacement(0, 3, "鰯")], () => undefined);

    expect(result.text).toBe("鰯");
    expect(result.wordTimes).toEqual([time(0, 1, 10, 12)]);
  });

  it("一部の run だけ残すと、残す run の位置で分け、除いた run の文字は直前の run に入る", () => {
    const wordTimes = [time(0, 1, 10, 11), time(1, 1, 11, 12), time(2, 2, 12, 13)];
    const result = placeCorrectionForCaptions("よしのや", wordTimes, [replacement(0, 4, "𠮷野家")], (w) => (w.location === 2 ? "B" : "A"));

    expect(result.wordTimes.map((w) => w.location)).toEqual([0, 3]);
    expect(pieces(result)).toEqual(["𠮷野", "家"]);
    expect(result.wordTimes[0]!.end).toBe(12);
  });

  it("1 文字が必要な区間の数が表記の文字数を超える置き換えは、残す run だけを数えて適用しない", () => {
    const wordTimes = [time(0, 1, 10, 11), time(1, 2, 11, 12)];

    expect(placeCorrectionForCaptions("イワシ", wordTimes, [replacement(0, 3, "鰯")], (w) => (w.location === 1 ? "B" : "A"))).toEqual({ text: "イワシ", wordTimes });
  });

  // bubbleOf を表で与える（キー: run の位置）
  const bubbles = (table: Record<number, string>) => (w: { location: number }) => table[w.location];

  it("後ろの吹き出しが置き換えの外の文字を持つなら適用する（意|和志す → 鰯す）", () => {
    const result = placeCorrectionForCaptions("意和志す", [time(0, 1, 10, 11), time(1, 3, 11, 12)], [replacement(0, 3, "鰯")], bubbles({ 0: "A", 1: "B" }));

    expect(result.text).toBe("鰯す");
    expect(pieces(result)).toEqual(["鰯", "す"]);
  });

  it("前の吹き出しが置き換えより前の文字を持つなら適用する（あ意|和志 → あ鰯）", () => {
    const result = placeCorrectionForCaptions("あ意和志", [time(0, 2, 10, 11), time(2, 2, 11, 12)], [replacement(1, 3, "鰯")], bubbles({ 0: "A", 2: "B" }));

    expect(result.text).toBe("あ鰯");
    expect(pieces(result)).toEqual(["あ", "鰯"]);
  });

  it("残す run の次の run が同じ吹き出しなら、その run の外の文字も吹き出しのものとして数える", () => {
    const result = placeCorrectionForCaptions("意和志す", [time(0, 1, 10, 11), time(1, 2, 11, 12), time(3, 1, 12, 13)], [replacement(0, 3, "鰯")], bubbles({ 0: "A", 1: "B", 3: "B" }));

    expect(result.text).toBe("鰯す");
    expect(pieces(result)).toEqual(["鰯", "", "す"]);
  });

  it("同じ吹き出しの続きの run は残さず、必要な文字数が表記の文字数ちょうどなら適用する", () => {
    const wordTimes = [time(0, 1, 10, 11), time(1, 1, 11, 12), time(2, 2, 12, 13)];

    expect(placeCorrectionForCaptions("よしのや", wordTimes, [replacement(0, 4, "𠮷野")], bubbles({ 0: "A", 1: "B", 2: "B" })).text).toBe("𠮷野");
    expect(placeCorrectionForCaptions("よしのや", wordTimes, [replacement(0, 4, "𠮷野")], bubbles({ 0: "A", 1: "B", 2: "C" }))).toEqual({ text: "よしのや", wordTimes });
  });

  it("別の置き換えの区間は外の文字に数えず、互いに適用しない。外の文字があるなら適用する", () => {
    const wordTimes = [time(0, 1, 10, 11), time(1, 3, 11, 12), time(4, 2, 12, 13)];
    const both = placeCorrectionForCaptions("意和志イワシ", wordTimes, [replacement(0, 3, "鰯"), replacement(3, 3, "鰯")], bubbles({ 0: "A", 1: "B", 4: "C" }));

    expect(both.text).toBe("意和志イワシ");
    expect(pieces(both).every((piece) => piece !== "")).toBe(true);
    const first = placeCorrectionForCaptions("意和志イワシ", wordTimes, [replacement(0, 3, "鰯")], bubbles({ 0: "A", 1: "B", 4: "C" }));
    expect(pieces(first)).toEqual(["鰯", "イ", "ワシ"]);
  });

  it("後ろの吹き出しの外の文字が空白だけなら適用しない（意|和志␠ → 鰯）", () => {
    const wordTimes = [time(0, 1, 10, 11), time(1, 3, 11, 12)];

    expect(placeCorrectionForCaptions("意和志 ", wordTimes, [replacement(0, 3, "鰯")], bubbles({ 0: "A", 1: "B" }))).toEqual({ text: "意和志 ", wordTimes });
  });

  it("前の吹き出しの外の文字が空白だけなら適用しない（␠意|和志 → 鰯）", () => {
    const wordTimes = [time(0, 2, 10, 11), time(2, 2, 11, 12)];

    expect(placeCorrectionForCaptions(" 意和志", wordTimes, [replacement(1, 3, "鰯")], bubbles({ 0: "A", 2: "B" }))).toEqual({ text: " 意和志", wordTimes });
  });

  it("外の文字が空白と空白以外の両方なら適用する（意|和志␠す → 鰯␠す）", () => {
    const result = placeCorrectionForCaptions("意和志 す", [time(0, 1, 10, 11), time(1, 4, 11, 12)], [replacement(0, 3, "鰯")], bubbles({ 0: "A", 1: "B" }));

    expect(result.text).toBe("鰯 す");
    expect(pieces(result)).toEqual(["鰯", " す"]);
    expect(pieces(result)[1]!.trim()).toBe("す");
  });

  it("表示されていない先頭の run は 1 文字を求めない", () => {
    const result = placeCorrectionForCaptions("意和志", [time(0, 1, 10, 11), time(1, 2, 11, 12)], [replacement(0, 3, "鰯")], bubbles({ 1: "B" }));

    expect(pieces(result)).toEqual(["", "鰯"]);
  });
});
