import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { bindingsOf, KeyId, keyListRows, POINTER_ROWS, type Screen } from "../src/app/keys/table.ts";

// キーの表（Issue #822）。Subscription（bindingsOf）とキーの一覧（keyListRows）は、同じ表を画面で絞って作る。
// 一覧の文言と順の正解は、React 版（KeyList.tsx の KEY_LIST・REVIEW_KEY_LIST・AUDIO_KEY_LIST。Issue #829 で React と一緒に消した）から、文言をそのまま写して下に持つ（行の追加・変更は、利用者に見える文言の変更になるので、このテストを意図して直す）。「マウス・トラックパッド」の行は、キーの行と同じ形の静的な表（POINTER_ROWS）から作る

// ---- 一覧の文言と順の正解（React 版の KeyList.tsx から写したもの） ----
const KEY_LIST = [
  { group: "キー", keys: "Esc", action: "今の議題へ戻る（一覧が開いているときは閉じるだけ）" },
  { group: "キー", keys: "F", action: "全体を見る・もう一度で変わったところへ寄る" },
  { group: "キー", keys: "= / -", action: "拡大・縮小（JIS 配列では ^ でも拡大）" },
  { group: "キー", keys: "0", action: "倍率 1.0 にする" },
  { group: "キー", keys: "← → ↑ ↓", action: "ノードを選ぶ（← 親・→ 縦に近い子・↑↓ 同じ深さの上下。Esc で外す）" },
  { group: "キー", keys: "Enter", action: "選んだ議題・論点を開く・畳む（今の議題とその祖先には効かない。Esc で元に戻る）" },
  { group: "キー", keys: "Z", action: "選んだノードと子孫が収まるまで寄る（選んでいないときは何もしない）" },
  { group: "キー", keys: "Shift + 矢印", action: "画面の 1/3 ずつ移動する" },
  { group: "キー", keys: "E", action: "右の列（変わったこと・根拠）を出す・隠す" },
  { group: "キー", keys: "C", action: "字幕を出す・隠す" },
  { group: "キー", keys: "?", action: "このキー一覧を開閉する" },
  // Issue #1069: 会議中だけの行（見返しの M＝ミュートとは別の行）
  { group: "キー", keys: "M", action: "自分を休止・再開" },
  { group: "マウス・トラックパッド", keys: "スクロール", action: "縦横に移動する" },
  { group: "マウス・トラックパッド", keys: "何もないところをドラッグ", action: "移動する" },
  { group: "マウス・トラックパッド", keys: "⌘/Ctrl + スクロール・ピンチ", action: "拡大・縮小" },
  { group: "マウス・トラックパッド", keys: "⌘/Ctrl + Shift + スクロール", action: "縦か横の一方だけに移動する" },
  { group: "マウス・トラックパッド", keys: "⌘/Ctrl + クリック / + Option", action: "押したところを中心に拡大 / 縮小する" },
  { group: "マウス・トラックパッド", keys: "ノードのクリック", action: "根拠を出す" },
  { group: "マウス・トラックパッド", keys: "隠れた数の丸・開いたノードの小さな丸", action: "押すと開く・畳む（小さな丸は、人が開いたノードにホバーしたときだけ出る）" },
  { group: "マウス・トラックパッド", keys: "縁の点", action: "そのノードへ寄る" },
] as const;

// 見返しの一覧にだけ載せる行（C は KEY_LIST の行を使う）
const REVIEW_KEY_LIST = [
  { group: "キー", keys: "Space・K", action: "進める・止める" },
  { group: "キー", keys: "J / L", action: "10 秒戻る・進む" },
  { group: "キー", keys: ", / .", action: "反映 1 つ戻る・進む" },
  { group: "キー", keys: "< / >", action: "速さを 1 段下げる・上げる" },
  { group: "キー", keys: "Home / End", action: "最初・最後の時点へ" },
] as const;

// 音声つきの見返しの一覧にだけ載せる行
const AUDIO_KEY_LIST = [{ group: "キー", keys: "M", action: "ミュート・戻す" }] as const;


const SCREENS: readonly Screen[] = ["live", "review", "reviewAudio"];
const keyRows = KEY_LIST.filter((row) => row.group === "キー");
// 見返しの一覧には、会議中だけの M の行（自分の休止）を載せない
const liveOnlyRows = keyRows.filter((row) => row.keys === "M");
const sharedKeyRows = keyRows.filter((row) => row.keys !== "M");
const mouseRows = KEY_LIST.filter((row) => row.group !== "キー");
const pair = (rows: ReadonlyArray<{ keys: string; action: string }>) => rows.map(({ keys, action }) => ({ keys, action }));

describe("キーの一覧: React 版から写した文言・同じ順", () => {
  it("会議中: キーの行 → マウス・トラックパッドの行（KEY_LIST と同じ）", () => {
    expect(pair(keyListRows("live"))).toEqual(pair(KEY_LIST));
  });

  it("見返し（音声なし）: キーの行 → 見返しの行 → マウスの行。M の行は出ない", () => {
    expect(pair(keyListRows("review"))).toEqual(pair([...sharedKeyRows, ...REVIEW_KEY_LIST, ...mouseRows]));
    expect(keyListRows("review").some((row) => row.keys === "M")).toBe(false);
  });

  it("見返し（音声つき）: キーの行 → 見返しの行 → M の行 → マウスの行", () => {
    expect(pair(keyListRows("reviewAudio"))).toEqual(pair([...sharedKeyRows, ...REVIEW_KEY_LIST, ...AUDIO_KEY_LIST, ...mouseRows]));
    // 音声つきの見返しの M は「ミュート・戻す」だけ。会議中の M の行（自分を休止・再開）は載らない
    expect(keyListRows("reviewAudio").filter((row) => row.keys === "M").map((row) => row.action)).toEqual(["ミュート・戻す"]);
  });

  it("会議中の一覧に見返しのキー（Space・K など）と見返しの M（ミュート）は出ない。M は自分の休止の行だけ", () => {
    const labels = keyListRows("live").map((row) => row.keys);
    for (const row of REVIEW_KEY_LIST) expect(labels).not.toContain(row.keys);
    expect(keyListRows("live").filter((row) => row.keys === "M").map((row) => row.action)).toEqual(liveOnlyRows.map((row) => row.action));
    expect(keyListRows("live").some((row) => row.action === "ミュート・戻す")).toBe(false);
  });
});

describe("マウス・トラックパッドの行: キーの行と同じ形の静的な表", () => {
  it("POINTER_ROWS は KEY_LIST のマウスの行と同じ文言・同じ順で、受けるバインディングを持たない", () => {
    expect(pair(POINTER_ROWS)).toEqual(pair(mouseRows));
    for (const row of POINTER_ROWS) expect(row.bindings).toEqual([]);
  });

  it("どの画面の一覧でも、末尾に POINTER_ROWS がそのまま並ぶ", () => {
    for (const screen of SCREENS) {
      const rows = keyListRows(screen);
      expect(rows.slice(rows.length - POINTER_ROWS.length)).toEqual([...POINTER_ROWS]);
    }
  });
});

describe("キーの表: 一覧の 1 行が受けるバインディング", () => {
  // 一覧の行の見出し → 受けるバインディング。JIS の ^ と US の + は表の行として持つ。? < > は Shift 付きでも受ける（Shift は厳密に照合されるため、行が無いと発火しない）
  const EXPECTED: ReadonlyArray<readonly [label: string, keys: readonly string[]]> = [
    ["Esc", ["Escape"]],
    ["F", ["F"]],
    ["= / -", ["=", "Shift+=", "^", "Shift+Plus", "-"]],
    ["0", ["0"]],
    ["← → ↑ ↓", ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]],
    ["Enter", ["Enter"]],
    ["Z", ["Z"]],
    ["Shift + 矢印", ["Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"]],
    ["E", ["E"]],
    ["C", ["C"]],
    ["?", ["?", "Shift+?"]],
    ["Space・K", ["Space", "K"]],
    ["J / L", ["J", "L"]],
    [", / .", [",", "."]],
    ["< / >", ["<", "Shift+<", ">", "Shift+>"]],
    ["Home / End", ["Home", "End"]],
    ["M", ["M"]],
  ];

  it("行ごとに、上の表のバインディングを（順不同で）持つ", () => {
    const rows = keyListRows("reviewAudio");
    for (const [label, keys] of EXPECTED) {
      const row = rows.find((r) => r.keys === label);
      expect(row, label).toBeDefined();
      expect(row!.bindings.map((b) => b.keys).sort(), label).toEqual([...keys].sort());
    }
  });

  it("キーの行は必ずバインディングを持ち、全てのバインディングの key は KeyId に入る", () => {
    for (const screen of SCREENS) {
      const rows = keyListRows(screen).filter((row) => !POINTER_ROWS.includes(row));
      for (const row of rows) {
        expect(row.bindings.length, row.keys).toBeGreaterThan(0);
        for (const binding of row.bindings) expect(Schema.is(KeyId)(binding.key), binding.keys).toBe(true);
      }
    }
  });

  it("bindingsOf(画面) は、その画面の一覧の行のバインディングを平らにしたものと同じ（登録と一覧が同じ表から出る）", () => {
    for (const screen of SCREENS) {
      expect(bindingsOf(screen)).toEqual(keyListRows(screen).flatMap((row) => row.bindings));
    }
  });

  it("画面で絞る: 会議中は見返しのキーを受けず（M だけは自分の休止として受ける）、音声なしの見返しは M を受けない", () => {
    const keysOf = (screen: Screen) => bindingsOf(screen).map((b) => b.keys);
    expect(keysOf("live")).not.toContain("Space");
    expect(keysOf("live")).not.toContain("J");
    expect(keysOf("live")).toContain("M");
    expect(keysOf("review")).toContain("Space");
    expect(keysOf("review")).not.toContain("M");
    expect(keysOf("reviewAudio")).toContain("M");
  });

  it("1 つの画面の中で、同じキーのバインディングは重ならない（foldkit は重複を作成時に例外にする）", () => {
    for (const screen of SCREENS) {
      const keys = bindingsOf(screen).map((b) => b.keys.toLowerCase());
      expect(new Set(keys).size, screen).toBe(keys.length);
    }
  });
});
