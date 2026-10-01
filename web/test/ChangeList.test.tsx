import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "../../server/src/core/index.ts";
import { ChangeList } from "../src/ChangeList.tsx";

const entries: ChangeEntry[] = [
  { round: 1, at: 19.2, change: "追加", node: "n1", kind: "議題", text: "採用" },
  { round: 1, at: 19.2, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" },
  { round: 2, at: 65, change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
  { round: 2, at: 65, change: "追加", node: "n3", kind: "決定", text: "2 回にする" },
];

describe("ChangeList: 右側の「変わったこと」一覧", () => {
  it("見出しと、各記録の 時刻（mm:ss）・変化の種類・種別・本文 を出す", () => {
    const html = renderToStaticMarkup(<ChangeList changes={entries} />);
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
    const html = renderToStaticMarkup(<ChangeList changes={entries} />);
    const order = ["2 回にする", "決定済み化", "面接は何回か", "採用"].map((t) => html.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("本文は HTML としてではなく、文字として描く", () => {
    const html = renderToStaticMarkup(
      <ChangeList changes={[{ round: 1, at: 1, change: "追加", node: "n1", kind: "議題", text: "<b>強調</b>" }]} />,
    );
    expect(html).not.toContain("<b>強調</b>");
    expect(html).toContain("&lt;b&gt;強調&lt;/b&gt;");
  });

  it("記録がなくても見出しは出し、行は出さない", () => {
    const html = renderToStaticMarkup(<ChangeList changes={[]} />);
    expect(html).toContain("変わったこと");
    expect(html).not.toContain("<li");
  });
});
