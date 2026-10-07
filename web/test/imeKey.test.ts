import { describe, expect, it } from "vitest";
import { halfWidthKeyOf, type KeyInput } from "../src/imeKey.ts";

const input = (over: Partial<KeyInput>): KeyInput => ({
  key: "",
  code: "",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...over,
});

const process = (code: string, over: Partial<KeyInput> = {}): KeyInput =>
  input({ key: "Process", code, isComposing: true, ...over });

// 送り直したイベントは半角・非変換中なので、もう一度拾わない（無限に送り直さない）。
const resentInput = (out: NonNullable<ReturnType<typeof halfWidthKeyOf>>): KeyInput => ({
  ...out,
  isComposing: false,
});

describe("halfWidthKeyOf: key が Process のとき code から作る", () => {
  it.each([
    ["KeyF", "f"],
    ["KeyA", "a"],
    ["KeyZ", "z"],
    ["Digit0", "0"],
    ["Digit9", "9"],
    ["Minus", "-"],
    ["Equal", "="],
    ["Slash", "/"],
  ])("Shift なし %s → %s", (code, key) => {
    expect(halfWidthKeyOf(process(code))?.key).toBe(key);
  });

  it.each([
    ["Slash", "?"],
    ["Minus", "="],
    ["Equal", "="],
    ["Comma", "<"],
    ["Period", ">"],
  ])("Shift あり %s → %s", (code, key) => {
    const out = halfWidthKeyOf(process(code, { shiftKey: true }));
    expect(out?.key).toBe(key);
    expect(out?.shiftKey).toBe(true);
  });

  it("Shift あり、表にない code は送り直さない（Shift なしでは送り直す）", () => {
    expect(halfWidthKeyOf(process("KeyF"))?.key).toBe("f");
    expect(halfWidthKeyOf(process("KeyF", { shiftKey: true }))).toBeNull();
    expect(halfWidthKeyOf(process("Digit0", { shiftKey: true }))).toBeNull();
  });

  it("code が表にないとき（IntlYen）は送り直さない", () => {
    expect(halfWidthKeyOf(process("KeyF"))).not.toBeNull();
    expect(halfWidthKeyOf(process("IntlYen"))).toBeNull();
  });

  it("Space は半角の Space（\" \"）に直す。Shift なしのときだけ", () => {
    const out = halfWidthKeyOf(process("Space"));
    expect(out?.key).toBe(" ");
    expect(out?.code).toBe("Space");
    expect(out?.shiftKey).toBe(false);
    expect(halfWidthKeyOf(process("Space", { shiftKey: true }))).toBeNull();
  });

  it("Shift なしの Comma・Period は、これまでどおり , . のまま", () => {
    expect(halfWidthKeyOf(process("Comma"))?.key).toBe(",");
    expect(halfWidthKeyOf(process("Period"))?.key).toBe(".");
  });

  it("Shift あり Comma・Period は < > にし、Shift は true のまま、code も保つ", () => {
    expect(halfWidthKeyOf(process("Comma", { shiftKey: true }))).toMatchObject({ key: "<", code: "Comma", shiftKey: true });
    expect(halfWidthKeyOf(process("Period", { shiftKey: true }))).toMatchObject({ key: ">", code: "Period", shiftKey: true });
  });

  it("key が Unidentified でも同じく code から作る", () => {
    expect(halfWidthKeyOf(input({ key: "Unidentified", code: "KeyF" }))?.key).toBe("f");
    expect(halfWidthKeyOf(input({ key: "Unidentified", code: "Space" }))?.key).toBe(" ");
    expect(halfWidthKeyOf(input({ key: "Unidentified", code: "Comma", shiftKey: true }))?.key).toBe("<");
    expect(halfWidthKeyOf(input({ key: "Unidentified", code: "Period", shiftKey: true }))?.key).toBe(">");
  });

  it("code も返す", () => {
    expect(halfWidthKeyOf(process("KeyF"))?.code).toBe("KeyF");
  });
});

describe("halfWidthKeyOf: 全角の 1 文字は 0xFEE0 を引いて半角にする", () => {
  it.each([
    ["？", "?"],
    ["ｆ", "f"],
    ["Ｆ", "F"],
    ["＝", "="],
    ["－", "-"],
    ["＾", "^"],
    ["０", "0"],
    ["！", "!"],
    ["～", "~"],
  ])("%s → %s", (key, half) => {
    expect(halfWidthKeyOf(input({ key, code: "KeyF", isComposing: true }))?.key).toBe(half);
  });

  it("変換中でなくても拾い、Shift 付きでも字そのものを変換する", () => {
    const out = halfWidthKeyOf(input({ key: "？", code: "Slash", shiftKey: true }));
    expect(out?.key).toBe("?");
    expect(out?.shiftKey).toBe(true);
  });

  it("全角の ＜ ＞ も < > にする（Shift 付きでも字そのものを変換する）", () => {
    expect(halfWidthKeyOf(input({ key: "＜", code: "Comma", shiftKey: true }))?.key).toBe("<");
    expect(halfWidthKeyOf(input({ key: "＞", code: "Period", shiftKey: true }))?.key).toBe(">");
    expect(halfWidthKeyOf(input({ key: "＜", code: "Comma", shiftKey: true }))?.shiftKey).toBe(true);
  });

  it("U+FF01〜FF5E の外（全角スペース・半角カナ）は全角変換しない", () => {
    expect(halfWidthKeyOf(input({ key: "　", code: "Space" }))).toBeNull();
    expect(halfWidthKeyOf(input({ key: "ｱ", code: "KeyA" }))).toBeNull();
  });
});

describe("halfWidthKeyOf: 変換中の 1 文字", () => {
  it("半角 ASCII はそのまま（変換中の印だけ外す）", () => {
    expect(halfWidthKeyOf(input({ key: "f", code: "KeyF", isComposing: true }))?.key).toBe("f");
    expect(halfWidthKeyOf(input({ key: "f", code: "KeyF", isComposing: false }))).toBeNull();
  });

  it("かななど半角にならない字は code から作る", () => {
    expect(halfWidthKeyOf(input({ key: "あ", code: "KeyA", isComposing: true }))?.key).toBe("a");
    expect(halfWidthKeyOf(input({ key: "あ", code: "Space", isComposing: true }))?.key).toBe(" ");
  });
});

describe("halfWidthKeyOf: 修飾キーの状態を保つ", () => {
  it("Process + KeyF で ctrl・alt・meta がそのまま残る", () => {
    const out = halfWidthKeyOf(process("KeyF", { ctrlKey: true, altKey: true, metaKey: true }));
    expect(out).toMatchObject({ key: "f", shiftKey: false, ctrlKey: true, altKey: true, metaKey: true });
  });

  it("修飾キーなしでは全て false のまま", () => {
    expect(halfWidthKeyOf(process("KeyF"))).toMatchObject({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  });

  it("全角の字でも修飾キーが残る", () => {
    expect(halfWidthKeyOf(input({ key: "＝", code: "Equal", metaKey: true, altKey: true }))).toMatchObject({
      key: "=",
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    });
  });
});

describe("halfWidthKeyOf: 送り直さないキー", () => {
  it("半角のキー（変換中でない）", () => {
    expect(halfWidthKeyOf(process("KeyF"))).not.toBeNull();
    expect(halfWidthKeyOf(input({ key: "f", code: "KeyF" }))).toBeNull();
    expect(halfWidthKeyOf(input({ key: "=", code: "Equal" }))).toBeNull();
    expect(halfWidthKeyOf(input({ key: "?", code: "Slash", shiftKey: true }))).toBeNull();
    expect(halfWidthKeyOf(input({ key: "<", code: "Comma", shiftKey: true }))).toBeNull();
    expect(halfWidthKeyOf(input({ key: ">", code: "Period", shiftKey: true }))).toBeNull();
    expect(halfWidthKeyOf(input({ key: " ", code: "Space" }))).toBeNull();
  });

  it("全角スペース（変換中でない）は Space として扱わず、送り直さない", () => {
    expect(halfWidthKeyOf(input({ key: "　", code: "Space" }))).toBeNull();
  });

  it("Escape・Enter・矢印は変換中でも送り直さない", () => {
    expect(halfWidthKeyOf(process("KeyF"))).not.toBeNull();
    for (const isComposing of [false, true]) {
      expect(halfWidthKeyOf(input({ key: "Escape", code: "Escape", isComposing }))).toBeNull();
      expect(halfWidthKeyOf(input({ key: "Enter", code: "Enter", isComposing }))).toBeNull();
      expect(halfWidthKeyOf(input({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true, isComposing }))).toBeNull();
      expect(halfWidthKeyOf(input({ key: "ArrowUp", code: "ArrowUp", isComposing }))).toBeNull();
    }
  });
});

describe("halfWidthKeyOf: 送り直したイベントをもう一度拾わない", () => {
  it.each([
    process("KeyF"),
    process("Digit0"),
    process("Minus"),
    process("Equal"),
    process("Slash", { shiftKey: true }),
    process("Minus", { shiftKey: true }),
    process("Comma", { shiftKey: true }),
    process("Period", { shiftKey: true }),
    process("Space"),
    input({ key: "Unidentified", code: "Space" }),
    input({ key: "＜", code: "Comma", shiftKey: true }),
    input({ key: "あ", code: "Space", isComposing: true }),
    input({ key: "？", code: "Slash", shiftKey: true }),
    input({ key: "ｆ", code: "KeyF" }),
    input({ key: "＝", code: "Equal" }),
    input({ key: "－", code: "Minus" }),
    input({ key: "あ", code: "KeyA", isComposing: true }),
    input({ key: "f", code: "KeyF", isComposing: true }),
  ])("%j", (original) => {
    const out = halfWidthKeyOf(original);
    expect(out).not.toBeNull();
    expect(halfWidthKeyOf(resentInput(out!))).toBeNull();
  });
});
