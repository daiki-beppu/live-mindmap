import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChangeEntry } from "../../server/src/core/index.ts";
import { ChangeList } from "../src/ChangeList.tsx";
import { findAll } from "./tree.ts";

const entries: ChangeEntry[] = [
  { round: 1, at: 19.2, change: "追加", node: "n1", kind: "議題", text: "採用" },
  { round: 1, at: 19.2, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" },
  { round: 2, at: 65, change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
  { round: 2, at: 65, change: "追加", node: "n3", kind: "決定", text: "2 回にする" },
];

describe("ChangeList: 右側の「変わったこと」一覧", () => {
  it("見出しと、各記録の 時刻（mm:ss）・変化の種類・種別・本文 を出す", () => {
    const html = renderToStaticMarkup(<ChangeList changes={entries} onSelect={() => {}} />);
    expect(html).toContain("変わったこと");
    const items = html.match(/<li[\s\S]*?<\/li>/g)!;
    expect(items).toHaveLength(4);
    // 新しい順の先頭は、最後に積まれた「追加 n3」
    expect(items[0]).toContain("01:05");
    expect(items[0]).toContain("追加");
    expect(items[0]).toContain("決定");
    expect(items[0]).toContain("2 回にする");
    // 末尾は最初の記録
    expect(items[3]).toContain("00:19");
    expect(items[3]).toContain("議題");
    expect(items[3]).toContain("採用");
  });

  it("新しい順（積んだ順の逆）に並べる", () => {
    const html = renderToStaticMarkup(<ChangeList changes={entries} onSelect={() => {}} />);
    const order = ["2 回にする", "決定済み化", "面接は何回か", "採用"].map((t) => html.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("本文は HTML としてではなく、文字として描く", () => {
    const html = renderToStaticMarkup(
      <ChangeList changes={[{ round: 1, at: 1, change: "追加", node: "n1", kind: "議題", text: "<b>強調</b>" }]} onSelect={() => {}} />,
    );
    expect(html).not.toContain("<b>強調</b>");
    expect(html).toContain("&lt;b&gt;強調&lt;/b&gt;");
  });

  it("記録がなくても見出しは出し、行は出さない", () => {
    const html = renderToStaticMarkup(<ChangeList changes={[]} onSelect={() => {}} />);
    expect(html).toContain("変わったこと");
    expect(html).not.toContain("<li");
  });

  it("各項目は button で、クリックするとその記録のノード ID で onSelect を呼ぶ（新しい順の並びのまま）", () => {
    const onSelect = vi.fn();
    const buttons = findAll(ChangeList({ changes: entries, onSelect }), "button");
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b.props.type).toBe("button");
    (buttons[0]!.props.onClick as () => void)(); // 先頭: 追加 n3
    (buttons[1]!.props.onClick as () => void)(); // 決定済み化 n2
    (buttons[3]!.props.onClick as () => void)(); // 末尾: 追加 n1
    expect(onSelect.mock.calls).toEqual([["n3"], ["n2"], ["n1"]]);
  });

  it("各項目の 時刻・変化の種類・本文 は button の中に描く（項目全体が押せる）", () => {
    const html = renderToStaticMarkup(<ChangeList changes={entries} onSelect={() => {}} />);
    const items = html.match(/<li[\s\S]*?<\/li>/g)!;
    for (const li of items) expect(li).toMatch(/<button[\s\S]*<\/button>/);
    const first = items[0]!.match(/<button[\s\S]*?<\/button>/)![0];
    for (const t of ["01:05", "追加", "決定", "2 回にする"]) expect(first).toContain(t);
  });
});
