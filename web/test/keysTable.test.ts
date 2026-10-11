import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AUDIO_KEY_LIST, KEY_LIST, REVIEW_KEY_LIST } from "../src/KeyList.tsx";
import { bindingsOf, KeyId, keyListRows, POINTER_ROWS, type Screen } from "../src/app/keys/table.ts";

// キーの表（Issue #822）。Subscription（bindingsOf）とキーの一覧（keyListRows）は、同じ表を画面で絞って作る。
// 一覧の文言と順は今の React 版（KeyList.tsx の KEY_LIST・REVIEW_KEY_LIST・AUDIO_KEY_LIST）と同じ。「マウス・トラックパッド」の行は、キーの行と同じ形の静的な表（POINTER_ROWS）から作る

const SCREENS: readonly Screen[] = ["live", "review", "reviewAudio"];
const keyRows = KEY_LIST.filter((row) => row.group === "キー");
const mouseRows = KEY_LIST.filter((row) => row.group !== "キー");
const pair = (rows: ReadonlyArray<{ keys: string; action: string }>) => rows.map(({ keys, action }) => ({ keys, action }));

describe("キーの一覧: 今の React 版と同じ文言・同じ順", () => {
  it("会議中: キーの行 → マウス・トラックパッドの行（KEY_LIST と同じ）", () => {
    expect(pair(keyListRows("live"))).toEqual(pair(KEY_LIST));
  });

  it("見返し（音声なし）: キーの行 → 見返しの行 → マウスの行。M の行は出ない", () => {
    expect(pair(keyListRows("review"))).toEqual(pair([...keyRows, ...REVIEW_KEY_LIST, ...mouseRows]));
    expect(keyListRows("review").some((row) => row.keys === "M")).toBe(false);
  });

  it("見返し（音声つき）: キーの行 → 見返しの行 → M の行 → マウスの行", () => {
    expect(pair(keyListRows("reviewAudio"))).toEqual(pair([...keyRows, ...REVIEW_KEY_LIST, ...AUDIO_KEY_LIST, ...mouseRows]));
  });

  it("会議中の一覧に見返しのキー（Space・K など）は出ない", () => {
    const labels = keyListRows("live").map((row) => row.keys);
    for (const row of [...REVIEW_KEY_LIST, ...AUDIO_KEY_LIST]) expect(labels).not.toContain(row.keys);
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

  it("画面で絞る: 会議中は見返しのキーを受けず、音声なしの見返しは M を受けない", () => {
    const keysOf = (screen: Screen) => bindingsOf(screen).map((b) => b.keys);
    expect(keysOf("live")).not.toContain("Space");
    expect(keysOf("live")).not.toContain("J");
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
