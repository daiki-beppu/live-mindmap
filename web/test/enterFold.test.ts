import { describe, expect, it } from "vitest";
import { MAP_NODE_BUTTON_CLASS, enterFoldsSelection } from "../src/enterFold.ts";

// DOM を持たないので、closest だけを持つ代役の要素で見る。祖先に一致するセレクタ（完全一致）を渡す
const focusedIn = (...matches: string[]) => ({ closest: (selector: string) => (matches.includes(selector) ? {} : null) });
const NODE = `.${MAP_NODE_BUTTON_CLASS}`;
const ANY_BUTTON = "button, a[href]";

describe("enterFoldsSelection: Enter を選んだノードの開閉に使うか", () => {
  it("フォーカスなしなら使う（選択の有無に関わらない）", () => {
    expect(enterFoldsSelection(null, true)).toBe(true);
    expect(enterFoldsSelection(null, false)).toBe(true);
  });

  it("ノード本体のボタンでは、選択があるときだけ使う（選択が無ければ click で選ぶ）", () => {
    const node = focusedIn(NODE, ANY_BUTTON);
    expect(enterFoldsSelection(node, true)).toBe(true);
    expect(enterFoldsSelection(node, false)).toBe(false);
  });

  it("マップ以外のボタン・リンクでは使わない", () => {
    expect(enterFoldsSelection(focusedIn(ANY_BUTTON), true)).toBe(false);
    expect(enterFoldsSelection(focusedIn(ANY_BUTTON), false)).toBe(false);
  });

  it("ボタンでもリンクでもない要素では使う", () => {
    expect(enterFoldsSelection(focusedIn(), true)).toBe(true);
  });
});

// 開閉の丸の button（ノード本体の外にある button）の代役。祖先に button はあるが、ノード本体のボタンではない
describe("enterFoldsSelection: 開閉の丸の button にフォーカスがあるとき", () => {
  const dotButton = (cls: string) => ({
    closest: (selector: string) => (selector === "button, a[href]" || selector === `.${cls}` ? {} : null),
  });

  it.each(["map-node__count--pressable", "map-node__fold-dot"])("%s では、選択の有無に関わらず使わない（丸の開閉と選んだノードの開閉が二重に起きない）", (cls) => {
    expect(enterFoldsSelection(dotButton(cls), true)).toBe(false);
    expect(enterFoldsSelection(dotButton(cls), false)).toBe(false);
  });
});
