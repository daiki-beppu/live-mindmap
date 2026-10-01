import { describe, expect, it } from "vitest";
import {
  KINDS,
  createSession,
  exportFiles,
  toDrawnix,
  toMarkdown,
  type ExportNode,
  type JsonExport,
  type Op,
  type Remark,
} from "../src/core/index.ts";
import { KIND_COLORS } from "../src/core/drawnix.ts";

const remark = (id: string, start: number, text = "発言"): Remark => ({ id, track: "相手", start, end: start + 5, text });

type NodeInit = Partial<Omit<ExportNode, "id" | "kind" | "text" | "children">> & {
  children?: ExportNode[];
};
const node = (id: string, kind: ExportNode["kind"], text: string, init: NodeInit = {}): ExportNode => ({
  id,
  kind,
  text,
  evidence: [],
  children: [],
  ...init,
});

// 全部の状態を含むスナップショット（00:00 / 00:09 / 00:19 / 00:12 / 00:14 / 30:30 / 00:28 / 61:40）
const sample = (): JsonExport => ({
  root: node("root", "会議", "定例", {
    children: [
      node("n1", "議題", "採用", {
        evidence: [remark("r1", 0)],
        children: [
          node("n2", "論点", "面接は何回か", {
            pointStatus: "決定済み",
            evidence: [remark("r2", 9.8)],
            children: [
              node("n3", "決定", "2 回にする", { evidence: [remark("r3", 19.2)] }),
              node("n4", "案", "3 回", { planStatus: "却下", evidence: [remark("r4", 12)] }),
              node("n5", "案", "1 回", { planStatus: "検討中", evidence: [remark("r5", 14)] }),
            ],
          }),
          node("n6", "論点", "評価基準", { pointStatus: "未決", evidence: [remark("r6", 1830)] }),
          node("n7", "TODO", "求人票を直す", { assignee: "佐藤", due: "来週", evidence: [remark("r7", 28)] }),
        ],
      }),
      node("n8", "TODO", "日程を決める", { evidence: [remark("r8", 3725), remark("r9", 3700)] }),
    ],
  }),
});

describe("map.md（toMarkdown）", () => {
  it("冒頭に 3 つの一覧、その後にアウトラインを置く。根拠は最も早い時刻 1 つだけ", () => {
    expect(toMarkdown(sample()).trimEnd()).toBe(
      [
        "# 定例",
        "",
        "## 決定",
        "- 面接は何回か → 2 回にする（00:19）",
        "",
        "## TODO",
        "- 求人票を直す（担当：佐藤・期限：来週）（00:28）",
        "- 日程を決める（61:40）",
        "",
        "## 未決の論点",
        "- 評価基準（30:30）",
        "",
        "## アウトライン",
        "- 採用（00:00）",
        "  - 面接は何回か（00:09）",
        "    - → 決定：2 回にする（00:19）",
        "    - ~~3 回~~（00:12）",
        "    - 1 回（00:14）",
        "  - 評価基準（未決）（30:30）",
        "  - 求人票を直す（担当：佐藤・期限：来週）（00:28）",
        "- 日程を決める（61:40）",
      ].join("\n"),
    );
  });

  it("検討中の案には印を付けず、却下だけを取り消し線にする。決定済みの論点に（未決）は付かない", () => {
    const lines = toMarkdown(sample()).split("\n");
    expect(lines).toContain("    - 1 回（00:14）");
    expect(lines).toContain("    - ~~3 回~~（00:12）");
    expect(lines).toContain("  - 面接は何回か（00:09）");
    expect(lines.filter((l) => l.includes("（未決）"))).toEqual(["  - 評価基準（未決）（30:30）"]);
  });

  it("項目のない一覧は「なし」と書く", () => {
    const md = toMarkdown({ root: node("root", "会議", "定例", { children: [node("n1", "議題", "採用", { evidence: [remark("r1", 0)] })] }) });
    expect(md).toContain("## 決定\n- なし");
    expect(md).toContain("## TODO\n- なし");
    expect(md).toContain("## 未決の論点\n- なし");
    expect(md).toContain("## アウトライン\n- 採用（00:00）");
  });

  it("担当者だけ・期限だけの TODO は、あるものだけを出す", () => {
    const md = toMarkdown({
      root: node("root", "会議", "定例", {
        children: [
          node("n1", "TODO", "A", { assignee: "佐藤", evidence: [remark("r1", 1)] }),
          node("n2", "TODO", "B", { due: "来週", evidence: [remark("r2", 2)] }),
        ],
      }),
    });
    expect(md).toContain("- A（担当：佐藤）（00:01）");
    expect(md).toContain("- B（期限：来週）（00:02）");
  });
});

describe("map.drawnix（toDrawnix）", () => {
  const texts = (el: { data: { topic: { children: { text: string }[] } }; children?: unknown[] }): unknown => ({
    text: el.data.topic.children[0]!.text,
    children: (el.children ?? []).map((c) => texts(c as typeof el)),
  });
  const expected = (n: ExportNode): unknown => ({ text: n.text, children: n.children.map(expected) });

  it("Drawnix の読み込み条件（type・elements が配列・viewport がオブジェクト）を満たす", () => {
    const file = toDrawnix(sample());
    expect(file.type).toBe("drawnix");
    expect(file.version).toBe(1);
    expect(file.source).toBe("web");
    expect(Array.isArray(file.elements)).toBe(true);
    expect(typeof file.viewport).toBe("object");
    expect(file.viewport).not.toBeNull();
  });

  it("mindmap 要素 1 つに、マップの木が children の入れ子と data.topic で一致する", () => {
    const file = toDrawnix(sample());
    expect(file.elements).toHaveLength(1);
    expect(file.elements[0]).toMatchObject({ type: "mindmap" });
    expect(texts(file.elements[0] as never)).toEqual(expected(sample().root));
  });

  it("種別ごとの色を fill / strokeColor / branchColor で付け、同じ種別は同じ色、違う種別は違う塗りになる", () => {
    expect(Object.keys(KIND_COLORS).sort()).toEqual([...KINDS].sort());
    type El = { id: string; fill?: string; strokeColor?: string; branchColor?: string; children?: El[] };
    const flat = (e: El): El[] => [e, ...(e.children ?? []).flatMap(flat)];
    const all = flat(toDrawnix(sample()).elements[0] as El);
    const byId = new Map(all.map((e) => [e.id, e]));
    const fills = new Map<string, string>();
    for (const [id, kind] of [["n1", "議題"], ["n2", "論点"], ["n3", "決定"], ["n4", "案"], ["n6", "論点"], ["n7", "TODO"]] as const) {
      const e = byId.get(id)!;
      expect(e.fill, id).toEqual(expect.any(String));
      expect(e.strokeColor, id).toEqual(expect.any(String));
      expect(e.branchColor, id).toBe(e.strokeColor);
      const prev = fills.get(kind);
      if (prev) expect(e.fill).toBe(prev);
      fills.set(kind, e.fill!);
    }
    expect(new Set(fills.values()).size).toBe(fills.size);
    expect(byId.get("n2")!.fill).toBe(byId.get("n6")!.fill);
  });

  it("根拠・状態を出力に含めない", () => {
    const json = JSON.stringify(toDrawnix(sample()));
    expect(json).not.toContain("evidence");
    expect(json).not.toContain("発言");
  });
});

describe("exportFiles と map.json", () => {
  it("3 つのファイルを、同じ JsonExport から作る。map.json は export --format json と同じ文字列", () => {
    const exp = sample();
    const files = exportFiles(exp);
    expect(Object.keys(files).sort()).toEqual(["map.drawnix", "map.json", "map.md"]);
    expect(files["map.json"]).toBe(JSON.stringify(exp, null, 2));
    expect(files["map.md"]).toBe(toMarkdown(exp));
    expect(JSON.parse(files["map.drawnix"])).toEqual(JSON.parse(JSON.stringify(toDrawnix(exp))));
  });

  it("map.json はノードの木と根拠の発言（本文・トラック・時刻）を持ち、決定や TODO の一覧は持たない", async () => {
    const r1 = remark("r1", 3, "採用の話をします");
    const r2 = remark("r2", 7, "面接は何回にしますか");
    const ops: Op[] = [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
      { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
    ];
    const session = createSession({ title: "定例", updater: async () => ({ ops }), log: () => {} });
    session.push(r1);
    session.push(r2);
    await session.idle();
    const json = JSON.parse(exportFiles(session.exportJson())["map.json"]);
    expect(Object.keys(json)).toEqual(["root"]);
    expect(json.root.children[0]).toMatchObject({
      kind: "議題",
      text: "採用",
      evidence: [{ id: "r1", track: "相手", start: 3, end: 8, text: "採用の話をします" }],
      children: [{ kind: "論点", pointStatus: "未決", evidence: [{ id: "r2", start: 7, text: "面接は何回にしますか" }] }],
    });
  });
});
