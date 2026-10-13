import { describe, expect, it } from "vitest";
import { requestScreenWords, screenCandidates } from "../src/core/index.ts";

// 共有画面の文字（OCR の行）から、語彙の候補を取る規則（Issue #643、仕様 #633「共有画面から候補を取る規則」）。I/O を持たない純粋な関数。
// 入力は、これまでの画面で短い行が出た画面の数（seen）と、この画面の行。出力は、候補（この画面で取れた語）と、更新した数。
// 規則: カタカナ 3 字以上 / 漢字 3〜12 字（々を含む）/ 大文字を含む英字の語 / 3 画面以上に出た 2〜4 字の漢字・かなだけの行。
// 小文字と数字だけの英字の語（1on1）とひらがなだけの行は取らない。

const sorted = (xs: readonly string[]) => [...xs].sort();

// 画面ごとの行を順に流し、各画面で取れた候補を返す（数は画面をまたいで引き継ぐ）
function run(screens: ReadonlyArray<ReadonlyArray<string>>): string[][] {
  let seen: ReadonlyMap<string, number> = new Map();
  return screens.map((lines) => {
    const out = screenCandidates(seen, lines);
    seen = out.seen;
    return out.candidates.slice();
  });
}
const first = (lines: ReadonlyArray<string>) => sorted(run([lines])[0]!);

describe("screenCandidates（共有画面の行 → 語彙の候補）", () => {
  it.each([
    ["漢字 3 字（港南店）", ["港南店"], ["港南店"]],
    ["々を含む漢字（野々村）", ["野々村"], ["野々村"]],
    ["英字の語（Zendesk）", ["Zendesk"], ["Zendesk"]],
    ["カタカナ 3 字（ズーム。長音を字数に含める）", ["ズーム"], ["ズーム"]],
    ["カタカナ 3 字（ノーション）", ["ノーション"], ["ノーション"]],
    ["漢字 12 字（上限）", ["一二三四五六七八九十百千"], ["一二三四五六七八九十百千"]],
    ["先頭だけ大文字の英字（Notion）", ["Notion"], ["Notion"]],
    ["途中に大文字を含む英字（iPhone）", ["iPhone"], ["iPhone"]],
    ["全部大文字の略語（NASA）", ["NASA"], ["NASA"]],
    ["1 文字の大文字（R）", ["R"], ["R"]],
  ])("取る: %s", (_name, lines, expected) => {
    expect(first(lines)).toEqual(sorted(expected));
  });

  it.each([
    ["小文字と数字だけの英字の語（1on1）", ["1on1"]],
    ["小文字だけの英字の語（meeting）", ["meeting"]],
    ["数字だけ", ["2026"]],
    ["ひらがなだけの行", ["ありがとうございます"]],
    ["ひらがなだけの短い行", ["さくら"]],
    ["カタカナ 2 字", ["ズー"]],
    ["漢字 2 字（1 画面では短い行として数えるだけ）", ["会議"]],
    ["漢字 13 字（長すぎる連なりは切り詰めずに取らない）", ["一二三四五六七八九十百千万"]],
    ["空の行と空白だけの行", ["", "   "]],
  ])("取らない: %s", (_name, lines) => {
    expect(first(lines)).toEqual([]);
  });

  it("1 行に複数の語が混ざっても、それぞれ取る。ひらがなや記号は区切りで、取った語に含めない", () => {
    expect(first(["港南店でZendeskを使う", "ノーション、1on1"])).toEqual(sorted(["港南店", "Zendesk", "ノーション"]));
  });

  it("同じ語が 1 画面の中で何度出ても、候補は 1 つ", () => {
    expect(run([["港南店", "港南店で会議", "Zendesk", "Zendesk"]])[0]!.filter((c) => c === "港南店")).toHaveLength(1);
    expect(run([["港南店", "港南店で会議", "Zendesk", "Zendesk"]])[0]!.filter((c) => c === "Zendesk")).toHaveLength(1);
  });

  describe("繰り返す短い行（参加者の小窓の名前）", () => {
    it("2〜4 字の漢字・かなだけの行が 3 画面目に出たとき取る。2 画面までは取らない", () => {
      const out = run([["葛西"], ["葛西", "資料"], ["葛西"]]);
      expect(out[0]).toEqual([]);
      expect(out[1]).toEqual([]);
      expect(out[2]).toEqual(["葛西"]);
    });

    it("途中の画面に出なくても、出た画面の数で数える（1・2・4 画面目）", () => {
      const out = run([["三輪"], ["別の話題"], ["三輪"], ["三輪"]]);
      expect(out.slice(0, 3).flat()).toEqual([]);
      expect(out[3]).toContain("三輪");
    });

    it("同じ画面に 2 回出ても 1 画面と数える", () => {
      const out = run([["葛西", "葛西"], ["葛西", "葛西"]]);
      expect(out.flat()).toEqual([]);
      expect(run([["葛西", "葛西"], ["葛西", "葛西"], ["葛西"]])[2]).toEqual(["葛西"]);
    });

    it("前後の空白を除いた行で数える", () => {
      const out = run([["葛西"], [" 葛西 "], ["葛西\n"]]);
      expect(out[2]).toEqual(["葛西"]);
    });

    it("漢字とかなが混ざる短い行（田中さん）も、3 画面で取る。カタカナだけの短い行（ミワ）も取る", () => {
      const out = run([["田中さん", "ミワ"], ["田中さん", "ミワ"], ["田中さん", "ミワ"]]);
      expect(sorted(out[2]!)).toEqual(sorted(["田中さん", "ミワ"]));
    });

    it("ひらがなだけの短い行は、何画面出ても取らない", () => {
      const out = run([["さくら"], ["さくら"], ["さくら"], ["さくら"]]);
      expect(out.flat()).toEqual([]);
    });

    it("5 字以上の行、英字を含む行、記号を含む行は、何画面出ても短い行としては取らない", () => {
      const screens = Array.from({ length: 3 }, () => ["あいうえお会議", "田中 a", "会・議"]);
      expect(run(screens).flat()).toEqual([]);
    });

    it("数は渡した seen から続き、渡した seen は書き換えない（純粋）", () => {
      const seen0: ReadonlyMap<string, number> = new Map();
      const a = screenCandidates(seen0, ["葛西"]);
      expect(seen0.size).toBe(0);
      const b = screenCandidates(a.seen, ["葛西"]);
      expect(b.candidates).toEqual([]);
      expect(screenCandidates(b.seen, ["葛西"]).candidates).toEqual(["葛西"]);
      // 同じ a.seen から別の続きを作っても、b の結果に影響されない
      expect(screenCandidates(a.seen, ["葛西"]).candidates).toEqual([]);
    });
  });
});

describe("requestScreenWords（候補のうち、読みをまだ頼んでいない語だけを選び、頼んだ語に加える）", () => {
  const state = (seen: [string, number][], requested: string[]) => ({ seen: new Map(seen), requested: new Set(requested) });

  it("頼んでいない語だけを出た順に返し、頼んだ語の集合に加える", () => {
    const [fresh, next] = requestScreenWords(state([], ["港南店"]), ["港南店", "Zendesk", "野々村"]);

    expect(fresh).toEqual(["Zendesk", "野々村"]);
    expect([...next.requested].sort()).toEqual(["Zendesk", "港南店", "野々村"].sort());
  });

  it("同じ語を続けて渡しても、2 回目は何も頼まない", () => {
    const [first, afterFirst] = requestScreenWords(state([], []), ["Zendesk"]);
    const [second, afterSecond] = requestScreenWords(afterFirst, ["Zendesk"]);

    expect(first).toEqual(["Zendesk"]);
    expect(second).toEqual([]);
    expect([...afterSecond.requested]).toEqual(["Zendesk"]);
  });

  it("短い行の画面数を引き継ぎ、3 画面目で初めて候補になる。渡された状態は書き換えない", () => {
    const initial = state([], []);
    const [a, s1] = requestScreenWords(initial, ["葛西"]);
    const [b, s2] = requestScreenWords(s1, ["葛西"]);
    const [c, s3] = requestScreenWords(s2, ["葛西"]);

    expect([a, b, c]).toEqual([[], [], ["葛西"]]);
    expect(s3.seen.get("葛西")).toBe(3);
    expect(initial.seen.size).toBe(0);
    expect(initial.requested.size).toBe(0);
    expect(s1.seen.get("葛西")).toBe(1);
  });
});
