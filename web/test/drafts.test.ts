import { describe, expect, it } from "vitest";
import type { SnapshotNode } from "../../server/src/core/index.ts";
import { draftPositions, draftsOf, DRAFT_TAIL, tailText } from "../src/drafts.ts";
import { DEFAULT_HEIGHT, GAP_X, GAP_Y, layout, NODE_WIDTH } from "../src/layout.ts";

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題"): SnapshotNode => ({
  id,
  parent,
  kind,
  text: id,
  evidence: parent ? ["r1"] : [],
});

// 作られた順。A の子孫（A1・A2）が、最後の兄弟 B の下端より下まで伸びる
const nodes = (): SnapshotNode[] => [node("root", null, "会議"), node("A", "root"), node("B", "root"), node("A1", "A", "論点"), node("A2", "A", "論点"), node("A3", "A", "論点")];
const heights = (extra: Record<string, number> = {}): Record<string, number> => ({ root: 40, A: 40, B: 40, A1: 40, A2: 40, A3: 40, ...extra });
const bottomOf = (pos: Record<string, { x: number; y: number }>, h: Record<string, number>) => Math.max(...Object.entries(pos).map(([id, p]) => p.y + (h[id] ?? DEFAULT_HEIGHT)));

describe("tailText（長い文字は末尾だけを出す）", () => {
  it("DRAFT_TAIL は数十文字", () => {
    expect(DRAFT_TAIL).toBeGreaterThanOrEqual(20);
    expect(DRAFT_TAIL).toBeLessThan(100);
  });

  it("DRAFT_TAIL 文字ちょうどまでは、そのまま出す", () => {
    const text = "あ".repeat(DRAFT_TAIL - 1) + "い";
    expect(tailText(text)).toBe(text);
    expect(tailText("短い")).toBe("短い");
  });

  it("DRAFT_TAIL + 1 文字からは、先頭を省いて末尾の DRAFT_TAIL 文字だけを出す（省いたことは「…」で示す）", () => {
    const text = "先" + "あ".repeat(DRAFT_TAIL - 1) + "末";
    const shown = tailText(text);
    expect(shown).toBe("…" + "あ".repeat(DRAFT_TAIL - 1) + "末");
    expect(shown).not.toContain("先");
  });

  it("文字数は、サロゲートペアの文字を 1 文字として数える（文字を割らない）", () => {
    const text = "😀".repeat(DRAFT_TAIL + 1);
    expect(tailText(text)).toBe("…" + "😀".repeat(DRAFT_TAIL));
    expect(tailText("😀".repeat(DRAFT_TAIL))).toBe("😀".repeat(DRAFT_TAIL));
  });
});

describe("draftsOf（トラックごとに 1 つまでの仮のノード）", () => {
  it("文字があるトラックだけ、相手 → 自分 の順に 1 つずつ出す", () => {
    expect(draftsOf({ 相手: "あ", 自分: "い" })).toEqual([
      { id: "draft:相手", text: "あ" },
      { id: "draft:自分", text: "い" },
    ]);
  });

  it("文字が空のトラックは出さない。両方空なら仮のノードはない", () => {
    expect(draftsOf({ 相手: "", 自分: "い" }).map((d) => d.id)).toEqual(["draft:自分"]);
    expect(draftsOf({ 相手: "あ", 自分: "" }).map((d) => d.id)).toEqual(["draft:相手"]);
    expect(draftsOf({ 相手: "", 自分: "" })).toEqual([]);
  });

  it("長い文字は末尾だけにする", () => {
    const long = "先" + "あ".repeat(DRAFT_TAIL);
    expect(draftsOf({ 相手: long, 自分: "" })[0]!.text).toBe(tailText(long));
  });
});

describe("draftPositions（仮のノードの位置。正式なノードの配置には入れない）", () => {
  const ids = ["draft:相手", "draft:自分"];

  it("x は、ルートの子と同じ深さ", () => {
    const formal = layout(nodes(), heights());
    const pos = draftPositions(formal, heights({ "draft:相手": 60, "draft:自分": 60 }), ids);
    expect(pos["draft:相手"]!.x).toBe(NODE_WIDTH + GAP_X);
    expect(pos["draft:相手"]!.x).toBe(formal.A!.x);
    expect(pos["draft:自分"]!.x).toBe(formal.B!.x);
  });

  it("最後の兄弟（とその子孫）を含む、正式なノード全体の下端より下に置く", () => {
    const h = heights({ "draft:相手": 60, "draft:自分": 60 });
    const formal = layout(nodes(), h);
    const pos = draftPositions(formal, h, ids);

    expect(pos["draft:相手"]!.y).toBe(bottomOf(formal, h) + GAP_Y);
    expect(pos["draft:相手"]!.y).toBeGreaterThan(formal.B!.y + h.B!); // 最後の兄弟 B の下端より下
  });

  it("相手 → 自分 の順に積み、重ならない", () => {
    const h = heights({ "draft:相手": 60, "draft:自分": 80 });
    const pos = draftPositions(layout(nodes(), h), h, ids);

    expect(pos["draft:自分"]!.y).toBe(pos["draft:相手"]!.y + 60 + GAP_Y);
  });

  it("仮のノードが 1 つだけのときは、そのトラックだけを返す", () => {
    const h = heights({ "draft:自分": 60 });
    const pos = draftPositions(layout(nodes(), h), h, ["draft:自分"]);

    expect(Object.keys(pos)).toEqual(["draft:自分"]);
    expect(pos["draft:自分"]!.y).toBe(bottomOf(layout(nodes(), h), h) + GAP_Y);
  });

  it("まだ測っていない仮のノードの高さは、既定の高さで積む", () => {
    const formal = layout(nodes(), heights());
    const pos = draftPositions(formal, heights(), ids);

    expect(pos["draft:自分"]!.y).toBe(pos["draft:相手"]!.y + DEFAULT_HEIGHT + GAP_Y);
  });

  it("仮のノードが増減しても、正式なノードの位置は動かない（正式な配置は仮のノードを入力に持たない）", () => {
    const h = heights({ "draft:相手": 60, "draft:自分": 60 });
    const formal = layout(nodes(), h);
    const before = structuredClone(formal);

    const two = draftPositions(formal, h, ids);
    const one = draftPositions(formal, h, ["draft:相手"]);
    draftPositions(formal, h, []);

    expect(formal).toEqual(before); // 渡した正式な配置を書き換えない
    expect(layout(nodes(), h)).toEqual(before); // 仮のノードの高さが測られていても、正式な配置は同じ
    expect(Object.keys(two)).toEqual(ids);
    expect(one["draft:相手"]).toEqual(two["draft:相手"]); // 自分が増減しても、相手の位置は動かない
    expect(draftPositions(formal, h, [])).toEqual({});
  });

  it("正式なノードが下へ伸びたら、仮のノードも追従する（下端から導く）", () => {
    const h = heights({ "draft:相手": 60 });
    const grown = [...nodes(), node("A4", "A", "論点")];
    const small = draftPositions(layout(nodes(), h), h, ["draft:相手"]);
    const big = draftPositions(layout(grown, { ...h, A4: 40 }), { ...h, A4: 40 }, ["draft:相手"]);

    expect(big["draft:相手"]!.y).toBeGreaterThan(small["draft:相手"]!.y);
  });
});
