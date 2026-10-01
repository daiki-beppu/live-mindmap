import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { EvidencePanel } from "../src/EvidencePanel.tsx";
import { evidenceOf } from "../src/evidence.ts";

const snapshot: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    { id: "n1", parent: "root", kind: "論点", text: "面接は何回か", evidence: ["r2", "r1"], pointStatus: "決定済み" },
    { id: "n2", parent: "n1", kind: "案", text: "<b>2 回</b>", evidence: ["r1"], planStatus: "却下" },
    { id: "n3", parent: "root", kind: "課題", text: "人が足りない", evidence: ["r1"] },
  ],
  round: 1,
  changes: [],
  remarks: [
    { id: "r1", track: "自分", start: 65, end: 71.9, text: "<i>二回で</i>いきます" },
    { id: "r2", track: "相手", start: 125, end: 130, text: "了解です" },
  ],
};

const render = (selectedId: string | null) => renderToStaticMarkup(<EvidencePanel selectedId={selectedId} evidence={selectedId ? evidenceOf(snapshot, selectedId) : null} />);

describe("EvidencePanel: 右の列の根拠", () => {
  it("未選択では、見出し「根拠」とノードを選ぶ案内を出し、発言は出さない", () => {
    const html = render(null);
    expect(html).toContain("根拠");
    expect(html).toContain("選");
    expect(html).not.toContain("<li");
  });

  it("論点: 種別・状態・本文を出す", () => {
    const html = render("n1");
    expect(html).toContain("論点");
    expect(html).toContain("決定済み");
    expect(html).toContain("面接は何回か");
  });

  it("案: 状態は planStatus を出す", () => {
    const html = render("n2");
    expect(html).toContain("案");
    expect(html).toContain("却下");
  });

  it("状態を持たない種別では、状態の語を出さない", () => {
    const html = render("n3");
    expect(html).toContain("課題");
    for (const s of ["未決", "決定済み", "検討中", "却下"]) expect(html).not.toContain(s);
  });

  it("根拠の発言を 開始〜終了（mm:ss）・トラック・本文 で、開始時刻の昇順に並べる", () => {
    const html = render("n1");
    const items = html.match(/<li[\s\S]*?<\/li>/g)!;
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("01:05〜01:11");
    expect(items[0]).toContain("自分");
    expect(items[1]).toContain("02:05〜02:10");
    expect(items[1]).toContain("相手");
    expect(items[1]).toContain("了解です");
  });

  it("本文は HTML としてではなく、文字として描く（ノードの本文も発言の本文も）", () => {
    const html = render("n2");
    expect(html).not.toContain("<b>2 回</b>");
    expect(html).toContain("&lt;b&gt;2 回&lt;/b&gt;");
    expect(html).not.toContain("<i>二回で</i>");
    expect(html).toContain("&lt;i&gt;二回で&lt;/i&gt;いきます");
  });

  it("ルート（会議）は種別と本文を出し、根拠の発言がないことを示す（行は出さない）", () => {
    const html = render("root");
    expect(html).toContain("会議");
    expect(html).toContain("定例");
    expect(html).not.toContain("<li");
  });

  it("選んだノードが今のマップにないときは、その旨を出し、他のノードの内容は出さない", () => {
    const html = render("n99");
    expect(html).toContain("根拠");
    expect(html).toContain("ありません");
    expect(html).not.toContain("<li");
    expect(html).not.toContain("面接は何回か");
  });
});
