import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  JsonExport,
  KINDS,
  exportFiles,
  speakerNameMap,
  toDrawnix,
  toJsonExport,
  toMarkdown,
  type ExportNode,
  type Remark,
  type Snapshot,
  type SpeakerNameTable,
} from "../src/core/index.ts";
import { KIND_COLORS } from "../src/core/drawnix.ts";
import { playBatches } from "./fixtures/batches.ts";

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

  it.effect("map.json はノードの木と根拠の発言（本文・トラック・時刻）を持ち、決定や TODO の一覧は持たない", () =>
    Effect.gen(function* () {
      const r1 = remark("r1", 3, "採用の話をします");
      const r2 = remark("r2", 7, "面接は何回にしますか");
      // 1 回目の呼び出しで議題、その呼び出し中に届いた 2 件目を渡す 2 回目の呼び出しでその下（確定した id n1）の論点を足す
      const { session } = yield* playBatches(
        [[r1], [r2]],
        [
          [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }],
          [{ op: "add", ref: "t2", parent: "n1", kind: "論点", text: "面接は何回か", evidence: ["r2"] }],
        ],
      );
      const json = JSON.parse(exportFiles(yield* session.exportJson)["map.json"]);
      expect(Object.keys(json)).toEqual(["root"]);
      expect(json.root.children[0]).toMatchObject({
        kind: "議題",
        text: "採用",
        evidence: [{ id: "r1", track: "相手", start: 3, end: 8, text: "採用の話をします" }],
        children: [{ kind: "論点", pointStatus: "未決", evidence: [{ id: "r2", start: 7, text: "面接は何回にしますか" }] }],
      });
    }));
});

describe("種別「要点」の書き出し", () => {
  const shared = (): JsonExport => ({
    root: node("root", "会議", "共有会", {
      children: [
        node("n1", "議題", "ふりかえり", {
          evidence: [remark("r1", 0)],
          children: [node("n2", "要点", "毎週 15 分で回している", { evidence: [remark("r2", 75)] })],
        }),
      ],
    }),
  });

  it("map.md のアウトラインに、要点の本文と時刻が議題の下の項目として出る。決定・TODO・未決の論点の一覧には入らない", () => {
    const md = toMarkdown(shared());

    expect(md).toContain("## アウトライン\n- ふりかえり（00:00）\n  - 毎週 15 分で回している（01:15）");
    expect(md).toContain("## 決定\n- なし");
    expect(md).toContain("## TODO\n- なし");
    expect(md).toContain("## 未決の論点\n- なし");
  });

  it("map.drawnix で、要点は色を持ち、ほかのどの種別とも違う塗りと枠になる", () => {
    type El = { id: string; fill?: string; strokeColor?: string; branchColor?: string; children?: El[] };
    const flat = (e: El): El[] => [e, ...(e.children ?? []).flatMap(flat)];
    const byId = new Map(flat(toDrawnix(shared()).elements[0] as El).map((e) => [e.id, e]));
    const point = byId.get("n2")!;

    expect(point.fill).toEqual(expect.any(String));
    expect(point.strokeColor).toEqual(expect.any(String));
    expect(point.branchColor).toBe(point.strokeColor);
    const others = Object.entries(KIND_COLORS).filter(([k]) => k !== "要点").map(([, c]) => c);
    expect(others).toHaveLength(KINDS.length - 1);
    for (const c of others) {
      expect(c.fill).not.toBe(point.fill);
      expect(c.stroke).not.toBe(point.strokeColor);
    }
  });
});

// Issue #1028: 書き出しに話者を載せる。名前の表は speakerNames（ラベル → 名前）として JsonExport に載り、書き出し時点の名前で出る
describe("話者の書き出し: map.md", () => {
  const withNames = (children: ExportNode[], speakerNames?: Record<string, string>): JsonExport => ({
    root: node("root", "会議", "定例", { children }),
    ...(speakerNames ? { speakerNames } : {}),
  });
  const at = (sec: number) => [remark("r", sec)];
  const mdLines = (exp: JsonExport) => toMarkdown(exp).split("\n");
  const section = (exp: JsonExport, heading: string) => {
    const lines = mdLines(exp);
    const from = lines.indexOf(heading) + 1;
    const rest = lines.slice(from);
    const end = rest.findIndex((l) => l.startsWith("## "));
    return (end === -1 ? rest : rest.slice(0, end)).filter((l) => l !== "");
  };

  describe("案の出した人", () => {
    it("名前があれば「- 本文 — 名前（mm:ss）」で、アウトラインに出る", () => {
      const exp = withNames([node("p", "案", "1 回", { proposer: "相手 A", evidence: at(14) })], { "相手 A": "田中" });
      expect(section(exp, "## アウトライン")).toEqual(["- 1 回 — 田中（00:14）"]);
    });
    it("名前が無ければラベル（相手 A）で出す", () => {
      const exp = withNames([node("p", "案", "1 回", { proposer: "相手 A", evidence: at(14) })]);
      expect(section(exp, "## アウトライン")).toEqual(["- 1 回 — 相手 A（00:14）"]);
    });
    it("名前の表に別のラベルしか無ければ、その案はラベルのまま", () => {
      const exp = withNames([node("p", "案", "1 回", { proposer: "相手 A", evidence: at(14) })], { "相手 B": "田中" });
      expect(section(exp, "## アウトライン")).toEqual(["- 1 回 — 相手 A（00:14）"]);
    });
    it("自分は「自分」のまま", () => {
      const exp = withNames([node("p", "案", "1 回", { proposer: "自分", evidence: at(14) })], { "相手 A": "田中" });
      expect(section(exp, "## アウトライン")).toEqual(["- 1 回 — 自分（00:14）"]);
    });
    it("出した人のいない案・話者なしの相手（相手）の案は、本文だけで何も足さない", () => {
      const exp = withNames([
        node("p1", "案", "出した人なし", { evidence: at(1) }),
        node("p2", "案", "相手のみ", { proposer: "相手", evidence: at(2) }),
      ], { "相手 A": "田中" });
      expect(section(exp, "## アウトライン")).toEqual(["- 出した人なし（00:01）", "- 相手のみ（00:02）"]);
    });
    it("却下の案は、取り消し線を本文だけに掛け、人の欄は線の外に出す", () => {
      const exp = withNames([node("p", "案", "3 回", { planStatus: "却下", proposer: "相手 A", evidence: at(12) })], { "相手 A": "田中" });
      expect(section(exp, "## アウトライン")).toEqual(["- ~~3 回~~ — 田中（00:12）"]);
    });
  });

  describe("TODO の担当", () => {
    const todo = (init: NodeInit) => node("t", "TODO", "資料を送る", { evidence: at(190), ...init });

    it("担当の話者に名前があれば、「担当：」欄に名前と期限が入る。冒頭の一覧とアウトラインで同じ書き方", () => {
      const exp = withNames([todo({ assigneeSpeaker: "相手 B", due: "10/15" })], { "相手 B": "田中" });
      const line = "- 資料を送る（担当：田中・期限：10/15）（03:10）";
      expect(section(exp, "## TODO")).toEqual([line]);
      expect(section(exp, "## アウトライン")).toEqual([line]);
    });
    it("名前が無ければラベル（相手 B）で、同じ「担当：」欄に出す", () => {
      const exp = withNames([todo({ assigneeSpeaker: "相手 B", due: "10/15" })]);
      const line = "- 資料を送る（担当：相手 B・期限：10/15）（03:10）";
      expect(section(exp, "## TODO")).toEqual([line]);
      expect(section(exp, "## アウトライン")).toEqual([line]);
    });
    it("自分は「自分」のまま", () => {
      const exp = withNames([todo({ assigneeSpeaker: "自分", due: "10/15" })], { "相手 B": "田中" });
      const line = "- 資料を送る（担当：自分・期限：10/15）（03:10）";
      expect(section(exp, "## TODO")).toEqual([line]);
      expect(section(exp, "## アウトライン")).toEqual([line]);
    });
    it("担当の話者だけ（期限なし）なら「担当：」だけ", () => {
      const exp = withNames([todo({ assigneeSpeaker: "相手 B" })], { "相手 B": "田中" });
      expect(section(exp, "## TODO")).toEqual(["- 資料を送る（担当：田中）（03:10）"]);
    });
    it("担当の人がいない TODO は、期限だけ（担当：の欄を作らない）", () => {
      const exp = withNames([todo({ due: "10/15" })], { "相手 B": "田中" });
      expect(section(exp, "## TODO")).toEqual(["- 資料を送る（期限：10/15）（03:10）"]);
    });
    it("担当の話者が話者なしの相手（相手）なら担当者としては出さない", () => {
      const exp = withNames([todo({ assigneeSpeaker: "相手", due: "10/15" })]);
      expect(section(exp, "## TODO")).toEqual(["- 資料を送る（期限：10/15）（03:10）"]);
    });
    it("会話に出た名前（assignee）は、担当の話者より優先する", () => {
      const exp = withNames([todo({ assignee: "高橋", assigneeSpeaker: "相手 B", due: "10/15" })], { "相手 B": "田中" });
      expect(section(exp, "## TODO")).toEqual(["- 資料を送る（担当：高橋・期限：10/15）（03:10）"]);
    });
  });

  it("決定・論点には人の欄を足さない（出した人・担当の話者を持っていても）", () => {
    const exp = withNames([
      node("d", "決定", "2 回にする", { proposer: "相手 A", assigneeSpeaker: "相手 A", evidence: at(5) }),
    ], { "相手 A": "田中" });
    expect(section(exp, "## 決定")).toEqual(["- 定例 → 2 回にする（00:05）"]);
    expect(section(exp, "## アウトライン")).toEqual(["- → 決定：2 回にする（00:05）"]);
  });
});

describe("話者の書き出し: map.drawnix", () => {
  type Piece = { text: string; color?: string };
  type El = { id: string; data: { topic: { children: Piece[] } }; children: El[] };
  const pieces = (exp: JsonExport, id: string): Piece[] => {
    const find = (e: El): El | undefined => (e.id === id ? e : e.children.map(find).find(Boolean));
    return find(toDrawnix(exp).elements[0] as unknown as El)!.data.topic.children;
  };
  const spoken = (children: ExportNode[], speakerNames?: Record<string, string>): JsonExport => ({
    // 話者を持つ根拠の発言が 1 件ある = 話者を持つセッション
    root: node("root", "会議", "定例", {
      evidence: [{ ...remark("r0", 0), speaker: "相手 A" }],
      children,
    }),
    ...(speakerNames ? { speakerNames } : {}),
  });
  const GRAY = "#6b7280";

  it("案は、本文の後ろに薄い文字の「 — 名前」を別の片として足す（本文の片に連結しない）", () => {
    const exp = spoken([node("p", "案", "1 回", { proposer: "相手 A" })], { "相手 A": "田中" });
    expect(pieces(exp, "p")).toEqual([{ text: "1 回" }, { text: " — 田中", color: GRAY }]);
  });
  it("案の名前が無ければラベルで出す", () => {
    expect(pieces(spoken([node("p", "案", "1 回", { proposer: "相手 A" })]), "p")).toEqual([{ text: "1 回" }, { text: " — 相手 A", color: GRAY }]);
  });
  it("TODO は、本文の後ろに薄い文字の「 → 担当者 · 期限」を足す", () => {
    const exp = spoken([node("t", "TODO", "資料を送る", { assigneeSpeaker: "相手 B", due: "10/15" })], { "相手 B": "田中" });
    expect(pieces(exp, "t")).toEqual([{ text: "資料を送る" }, { text: " → 田中 · 10/15", color: GRAY }]);
  });
  it("出した人のいない案・話者なしの相手の案は本文の 1 片だけ", () => {
    const exp = spoken([node("p1", "案", "出した人なし"), node("p2", "案", "相手のみ", { proposer: "相手" })]);
    expect(pieces(exp, "p1")).toEqual([{ text: "出した人なし" }]);
    expect(pieces(exp, "p2")).toEqual([{ text: "相手のみ" }]);
  });
  it("案と TODO 以外の種別には人を足さない", () => {
    const exp = spoken([node("d", "決定", "2 回", { proposer: "相手 A", assigneeSpeaker: "相手 A", due: "来週" }), node("i", "論点", "何回", { proposer: "相手 A" })]);
    expect(pieces(exp, "d")).toEqual([{ text: "2 回" }]);
    expect(pieces(exp, "i")).toEqual([{ text: "何回" }]);
  });
  it("話者を持たない古いセッション（話者のある根拠の発言が無い）は、担当者・期限のある TODO も今までどおり本文の 1 片だけ", () => {
    const exp = sample();
    expect(pieces(exp, "n7")).toEqual([{ text: "求人票を直す" }]);
    expect(pieces(exp, "n4")).toEqual([{ text: "3 回" }]);
    expect(JSON.stringify(toDrawnix(exp))).not.toContain("color");
  });
  describe("根拠の発言に話者が無くても、ノードに「自分」があれば人を出す", () => {
    const noSpeaker = (children: ExportNode[]): JsonExport => ({ root: node("root", "会議", "定例", { children }) });
    it("案の出した人が「自分」", () => {
      expect(pieces(noSpeaker([node("p", "案", "1 回", { proposer: "自分" })]), "p")).toEqual([{ text: "1 回" }, { text: " — 自分", color: GRAY }]);
    });
    it("TODO の担当の話者が「自分」（期限つき）", () => {
      expect(pieces(noSpeaker([node("t", "TODO", "資料を送る", { assigneeSpeaker: "自分", due: "10/15" })]), "t")).toEqual([
        { text: "資料を送る" },
        { text: " → 自分 · 10/15", color: GRAY },
      ]);
    });
    it("案の出した人が「相手」だけなら人の印にならず、TODO の担当者・期限も出ない", () => {
      const exp = noSpeaker([node("p", "案", "1 回", { proposer: "相手" }), node("t", "TODO", "資料を送る", { assignee: "佐藤", due: "来週" })]);
      expect(pieces(exp, "p")).toEqual([{ text: "1 回" }]);
      expect(pieces(exp, "t")).toEqual([{ text: "資料を送る" }]);
    });
  });
});

describe("話者の書き出し: map.json（toJsonExport）", () => {
  const rem = (id: string, speaker?: string): Remark => ({ id, track: "相手", start: 1, end: 2, text: "発言", ...(speaker ? { speaker } : {}) });
  const snapshot = (): Snapshot => ({
    nodes: [
      { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
      { id: "n1", parent: "root", kind: "案", text: "1 回", evidence: ["r1"], proposer: "相手 B" },
      { id: "n2", parent: "root", kind: "TODO", text: "資料を送る", evidence: ["r2"], assigneeSpeaker: "相手 B", due: "10/15" },
    ],
    round: 1,
    changes: [],
    remarks: [rem("r1", "相手 B"), rem("r2", "自分")],
  });
  const json = (exp: JsonExport) => JSON.parse(exportFiles(exp)["map.json"]);

  it("案の出した人・TODO の担当の話者・根拠の発言の話者は、名前に置き換えずラベルのまま載る", () => {
    const out = json(toJsonExport(snapshot(), snapshot().remarks, new Map([["相手 B", "田中"]])));
    const [plan, todo] = out.root.children;
    expect(plan).toMatchObject({ proposer: "相手 B", evidence: [{ id: "r1", speaker: "相手 B" }] });
    expect(todo).toMatchObject({ assigneeSpeaker: "相手 B", due: "10/15", evidence: [{ id: "r2", speaker: "自分" }] });
    expect(JSON.stringify(out.root)).not.toContain("田中");
  });
  it("ラベルと名前の対応表を、ルートの speakerNames に 1 つだけ載せる", () => {
    const out = json(toJsonExport(snapshot(), snapshot().remarks, new Map([["相手 B", "田中"], ["相手 A", "佐藤"]])));
    expect(out.speakerNames).toEqual({ "相手 B": "田中", "相手 A": "佐藤" });
    expect(Object.keys(out).sort()).toEqual(["root", "speakerNames"]);
    expect(JSON.stringify(out).match(/speakerNames/g)).toHaveLength(1);
  });
  it("名前が無い（表が空・渡さない）ときは speakerNames のキーごと出さない", () => {
    expect(Object.keys(json(toJsonExport(snapshot(), snapshot().remarks)))).toEqual(["root"]);
    expect(Object.keys(json(toJsonExport(snapshot(), snapshot().remarks, new Map())))).toEqual(["root"]);
  });
  it("書き出した JSON は JsonExport の Schema で読み戻せ、人の欄と対応表を保つ", () => {
    const exp = toJsonExport(snapshot(), snapshot().remarks, new Map([["相手 B", "田中"]]));
    const decoded = Schema.decodeUnknownSync(JsonExport)(JSON.parse(exportFiles(exp)["map.json"]));
    expect(decoded).toEqual(exp);
    expect(decoded.speakerNames).toEqual({ "相手 B": "田中" });
  });
  it("名前を渡すと map.md にも同じ表が使われ、渡さなければラベルで出る（JsonExport 1 つから 3 形式に届く）", () => {
    const named = exportFiles(toJsonExport(snapshot(), snapshot().remarks, new Map([["相手 B", "田中"]])));
    expect(named["map.md"]).toContain("- 1 回 — 田中（00:01）");
    expect(named["map.md"]).toContain("- 資料を送る（担当：田中・期限：10/15）（00:01）");
    expect(named["map.drawnix"]).toContain(" — 田中");
    const unnamed = exportFiles(toJsonExport(snapshot(), snapshot().remarks));
    expect(unnamed["map.md"]).toContain("- 1 回 — 相手 B（00:01）");
  });
  it("話者を持たない古い入力の map.json は、人の欄も speakerNames も出さない", () => {
    const old: Snapshot = {
      nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }, { id: "n1", parent: "root", kind: "案", text: "1 回", evidence: ["r1"] }],
      round: 1,
      changes: [],
      remarks: [rem("r1")],
    };
    const text = exportFiles(toJsonExport(old, old.remarks))["map.json"];
    expect(text).not.toContain("proposer");
    expect(text).not.toContain("assigneeSpeaker");
    expect(text).not.toContain("speaker");
  });
});

describe("speakerNameMap（名前の表 → ラベルと名前の Map）", () => {
  it("ラベル → 名前だけを取り出す（出どころは落とす）", () => {
    const table: SpeakerNameTable = new Map([["相手 A", { name: "佐藤", source: "推定" }], ["相手 B", { name: "田中", source: "手入力" }]]);
    expect([...speakerNameMap(table)]).toEqual([["相手 A", "佐藤"], ["相手 B", "田中"]]);
  });
  it("空の表は空の Map", () => expect(speakerNameMap(new Map()).size).toBe(0));
});
