import { describe, expect, it } from "vitest";
import { INITIAL_VIEWING, reduceViewing, type ViewingEvent, type ViewingState, type VisibleTree } from "../src/viewing.ts";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView, type HumanFolds } from "../src/folding.ts";
import { relocations } from "../src/relocation.ts";
import { evidenceOf } from "../src/evidence.ts";
import { foldingActions } from "./foldingActions.ts";

const plainEscape: ViewingEvent = { type: "escape", meta: false, ctrl: false, alt: false };
const moved: ViewingEvent = { type: "key", key: "=", meta: false, ctrl: false, alt: false };
const reflect: ViewingEvent = { type: "reflect", replaced: {} };
const run = (events: [ViewingEvent, VisibleTree][], from: ViewingState = INITIAL_VIEWING) => {
  let state = from;
  for (const [event, tree] of events) state = reduceViewing(state, event, tree).state;
  return { state };
};
type Key = Extract<ViewingEvent, { type: "key" }>["key"];
const key = (key: Key): ViewingEvent => ({ type: "key", key, meta: false, ctrl: false, alt: false });

describe("reduceViewing: 右の列の出し入れ", () => {
  const side = (modifiers: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type: "side", meta: false, ctrl: false, alt: false, ...modifiers });

  it("最初は右の列を出し、E を繰り返すと隠す・出すを繰り返す", () => {
    expect(INITIAL_VIEWING.sideHidden).toBeUndefined();
    const hidden = reduceViewing(INITIAL_VIEWING, side(), arrowTree("A")).state;
    expect(hidden.sideHidden).toBe(true);
    expect(reduceViewing(hidden, side(), arrowTree("A")).state.sideHidden).toBeUndefined();
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの E では列の出し入れを変えない", (modifier) => {
    for (const state of [INITIAL_VIEWING, { sideHidden: true } satisfies ViewingState]) {
      expect(reduceViewing(state, side({ [modifier]: true }), arrowTree("A")).state).toEqual(state);
    }
  });

  it("他の出来事を続けても列を隠したままにする", () => {
    const events: ViewingEvent[] = [moved, reflect, { type: "edgeDot", id: "B" }, key("="), key("F"), key("F"), { type: "idle" }, { type: "timeMoved" }, plainEscape];
    let state: ViewingState = { sideHidden: true };
    for (const event of events) {
      state = reduceViewing(state, event, arrowTree("A")).state;
      expect(state.sideHidden).toBe(true);
    }
  });

  it("E は入力の状態と木を書き換えず、同じ入力から同じ結果になる", () => {
    const state: ViewingState = Object.freeze({ sideHidden: true });
    const tree = arrowTree("A");
    const before = structuredClone({ state, tree });
    const result = reduceViewing(state, side(), tree);
    expect({ state, tree }).toEqual(before);
    expect(result.state.sideHidden).toBeUndefined();
    expect(reduceViewing(state, side(), tree)).toEqual(result);
  });
});

// 矢印での選択用の木。深さ 2 の同じ段は y 順に A1(0) < A2(100) < B1(200) で、A1・A2 は A の子、B1 は B の子（親をまたぐ）。
// 子への移りは y の近さで決まる: root(150) の子は B(200) が A(0) より近く、A(80) の子は A2(100) が A1(0) より近い
const arrowTree = (currentTopic: string | undefined, over: Partial<VisibleTree> = {}): VisibleTree => ({
  ids: ["root", "A", "B", "A1", "A2", "B1"],
  targets: {
    root: { x: 0, y: 150 },
    A: { x: 200, y: 80 },
    B: { x: 200, y: 200 },
    A1: { x: 400, y: 0 },
    A2: { x: 400, y: 100 },
    B1: { x: 400, y: 200 },
  },
  parents: { root: null, A: "root", B: "root", A1: "A", A2: "A", B1: "B" },
  fold: null,
  currentTopic,
  ...over,
});
const arrow = (dir: "left" | "right" | "up" | "down", mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({
  type: "arrow",
  dir,
  meta: false,
  ctrl: false,
  alt: false,
  ...mods,
});
const click = (id: string): ViewingEvent => ({ type: "select", id });
const selectionOf = (s: ViewingState) => s.selection;
const selected = (id: string, byKey: boolean): ViewingState => ({ selection: { id, byKey } });

describe("reduceViewing: 矢印の移り先（見せるノードの中で、目標の位置で測る）", () => {
  it.each([
    ["A2", "down", "B1"],
    ["B1", "up", "A2"],
    ["A1", "down", "A2"],
    ["A2", "up", "A1"],
    ["A", "down", "B"],
    ["B", "up", "A"],
  ] as const)("%s で %s を押すと同じ深さの %s へ（親をまたぐ）", (from, dir, to) => {
    const out = reduceViewing(selected(from, true), arrow(dir), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: to, byKey: true });
  });

  it.each([
    ["A1", "up"],
    ["B1", "down"],
    ["A", "up"],
    ["B", "down"],
  ] as const)("端の %s で %s を押しても動かない（回り込まない）", (from, dir) => {
    const out = reduceViewing(selected(from, true), arrow(dir), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: from, byKey: true });
  });

  it("同じ深さが 1 つだけのルートは、上下で動かない", () => {
    for (const dir of ["up", "down"] as const) {
      expect(selectionOf(reduceViewing(selected("root", true), arrow(dir), arrowTree("A")).state)?.id).toBe("root");
    }
  });

  it("→ は、子のうち目標の位置の y が今のノードに一番近い子へ（先頭の子ではない）", () => {
    expect(selectionOf(reduceViewing(selected("root", true), arrow("right"), arrowTree("A")).state)?.id).toBe("B"); // root(150): A は 150、B は 50
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), arrowTree("A")).state)?.id).toBe("A2"); // A(80): A1 は 80、A2 は 20
    expect(selectionOf(reduceViewing(selected("B", true), arrow("right"), arrowTree("A")).state)?.id).toBe("B1");
  });

  it("→ は、見せるノードにない子（畳んだ中）には入らない。子が見えなければ動かない", () => {
    const t = arrowTree("A", { ids: ["root", "A", "B"] });
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), t).state)?.id).toBe("A");
  });

  it("← は親へ。ルートでは動かない", () => {
    expect(selectionOf(reduceViewing(selected("A2", true), arrow("left"), arrowTree("A")).state)?.id).toBe("A");
    expect(selectionOf(reduceViewing(selected("A", true), arrow("left"), arrowTree("A")).state)?.id).toBe("root");
    expect(selectionOf(reduceViewing(selected("root", true), arrow("left"), arrowTree("A")).state)?.id).toBe("root");
  });

  it("端で動かないときも byKey は true になる", () => {
    const out = reduceViewing(selected("A1", false), arrow("up"), arrowTree("A"));
    expect(out.state).toEqual({ selection: { id: "A1", byKey: true } });
  });
});

describe("reduceViewing: 選んでいないとき、または選んだノードが見えないときの矢印は、今の議題を選ぶだけ", () => {
  it.each(["left", "right", "up", "down"] as const)("未選択で %s を押すと、その向きには動かず今の議題を選ぶ", (dir) => {
    const out = reduceViewing(INITIAL_VIEWING, arrow(dir), arrowTree("A2"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
  });

  it("今の議題が無ければ、ルートを選ぶ", () => {
    for (const dir of ["left", "right", "up", "down"] as const) {
      expect(selectionOf(reduceViewing(INITIAL_VIEWING, arrow(dir), arrowTree(undefined)).state)).toEqual({ id: "root", byKey: true });
    }
  });

  it("今の議題が見せるノードに無いときも、ルートを選ぶ", () => {
    expect(selectionOf(reduceViewing(INITIAL_VIEWING, arrow("down"), arrowTree("gone")).state)?.id).toBe("root");
  });

  it("選んだノードが見せるノードに無い（消えた・畳んだ中）ときも、動かず今の議題を選ぶ", () => {
    const out = reduceViewing(selected("gone", false), arrow("right"), arrowTree("A2"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });

    const hiddenChild = arrowTree("B", { ids: ["root", "A", "B", "B1"] });
    expect(selectionOf(reduceViewing(selected("A1", true), arrow("up"), hiddenChild).state)?.id).toBe("B");
  });

  it("ルートが今の議題でなく、選んだノードが見えないとき、ルートではなく今の議題を選ぶ", () => {
    expect(selectionOf(reduceViewing(selected("gone", true), arrow("left"), arrowTree("B1")).state)?.id).toBe("B1");
  });

  it("選べるノードが何もないときは、何も変えない", () => {
    const empty: VisibleTree = { ids: [], targets: {}, parents: {}, fold: null, currentTopic: undefined };
    const out = reduceViewing(INITIAL_VIEWING, arrow("down"), empty);
    expect(out.state).toEqual({});
  });
});

describe("reduceViewing: ⌘・Ctrl・Option 付きの矢印では何も変わらない", () => {
  for (const mod of ["meta", "ctrl", "alt"] as const) {
    it(`${mod} 付きの矢印は、選択を変えない`, () => {
      const auto = selected("A1", true);
      for (const dir of ["left", "right", "up", "down"] as const) {
        const a = reduceViewing(auto, arrow(dir, { [mod]: true }), arrowTree("A"));
        expect(a.state).toEqual(auto);

      }
      const none = reduceViewing(INITIAL_VIEWING, arrow("down", { [mod]: true }), arrowTree("A"));
      expect(none.state).toEqual({});
    });
  }
});

describe("reduceViewing: キーとクリックによる選択", () => {
  it("未選択からの矢印は今の議題をキーで選ぶ", () => {
    const out = reduceViewing(INITIAL_VIEWING, arrow("down"), arrowTree("A2"));
    expect(out.state).toEqual({ selection: { id: "A2", byKey: true } });
  });

  it("選択済みの矢印は今の議題と異なる枝でも選択から移る", () => {
    const from: ViewingState = { selection: { id: "A1", byKey: true } };
    const out = reduceViewing(from, arrow("down"), arrowTree("B"));
    expect(out.state).toEqual({ selection: { id: "A2", byKey: true } });
  });

  it("クリックで選んだノードからも矢印で移れる", () => {
    const from: ViewingState = { selection: { id: "A1", byKey: false } };
    const out = reduceViewing(from, arrow("down"), arrowTree("A"));
    expect(out.state).toEqual({ selection: { id: "A2", byKey: true } });
  });

  it("クリックで選ぶと、選んだ ID とクリックによる選択を覚える", () => {
    const out = reduceViewing(INITIAL_VIEWING, click("A1"), arrowTree("A"));
    expect(out.state).toEqual({ selection: { id: "A1", byKey: false } });
  });

  it("クリックで選び直すと、キーで選んだ印（byKey）は外れ、選び直した ID になる", () => {
    const out = reduceViewing(selected("A1", true), click("B"), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: "B", byKey: false });
  });

  it("クリックで選んだノードから、矢印で続けられる（クリックのあとの矢印は選んだノードから動く）", () => {
    const { state } = run([[click("A1"), arrowTree("A")], [arrow("down"), arrowTree("A")]]);
    expect(selectionOf(state)).toEqual({ id: "A2", byKey: true });
  });

  it("キーで選んだ後、クリックで選び直すと byKey を外す", () => {
    const { state } = run([[arrow("down"), arrowTree("A")], [click("B"), arrowTree("A")]]);
    expect(state).toEqual({ selection: { id: "B", byKey: false } });
  });
});

describe("reduceViewing: 選択は右の列の出し入れに触らない", () => {
  it("右の列を隠していても、クリックでもキーでも隠したまま（列を出さない）", () => {
    const hidden: ViewingState = { sideHidden: true };
    expect(reduceViewing(hidden, click("A1"), arrowTree("A")).state).toEqual({ ...hidden, selection: { id: "A1", byKey: false } });
    expect(reduceViewing(hidden, arrow("down"), arrowTree("A")).state).toEqual({ sideHidden: true, selection: { id: "A", byKey: true } });
  });

  it("E で出し入れしても、選択は残る", () => {
    const side: ViewingEvent = { type: "side", meta: false, ctrl: false, alt: false };
    const sel = selected("A1", true);
    const hide = reduceViewing(sel, side, arrowTree("A"));
    expect(hide.state).toEqual({ ...sel, sideHidden: true });
    expect(reduceViewing(hide.state, side, arrowTree("A")).state).toEqual(sel);
  });
});

describe("reduceViewing: 選択は他の出来事では外れず、今の議題が変わって自動に戻っても残る", () => {
  const sel = selected("A1", true);

  it("今の議題が変わる反映で自動に戻り（refocus）、選択は残る", () => {
    const { state } = run([[reflect, arrowTree("B")]], sel);
    expect(state).toEqual({ selection: { id: "A1", byKey: true } });
  });

  it("同じ状態の上で、矢印 → 議題が変わる反映（自動に戻る）→ 次の矢印、と続けても、選択から続きカメラは選んだノードへ戻る", () => {
    const { state } = run([
      [arrow("down"), arrowTree("A")], // 今の議題 A を選ぶ（manual, topic A）
      [arrow("right"), arrowTree("A")], // A → A2
      [reflect, arrowTree("B")], // 議題が B に変わり自動に戻る。選択 A2 は残る
      [arrow("down"), arrowTree("B")], // A2 → B1。画面の外なら寄せるのは revealNode
    ]);

    expect(state).toEqual({ selection: { id: "B1", byKey: true } });
  });

  it("自動に戻った直後の矢印は、今の議題ではなく選んだノードから動く", () => {
    const back = run([[reflect, arrowTree("B")]], sel).state;
    const out = reduceViewing(back, arrow("down"), arrowTree("B"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
  });

  it("同じ議題の反映・人の操作・縁の点でも選択は残る", () => {
    expect(selectionOf(reduceViewing(sel, reflect, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    expect(selectionOf(reduceViewing(sel, moved, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    const dot = reduceViewing(sel, { type: "edgeDot", id: "B" }, arrowTree("A")).state;
    expect(selectionOf(dot)).toEqual({ id: "A1", byKey: true });
  });

  it("キー（倍率・Shift+矢印の移動）でも選択は残る", () => {
    for (const k of ["=", "-", "0", "Shift+ArrowLeft", "Shift+ArrowDown"] as const) {
      expect(selectionOf(reduceViewing(sel, key(k), arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    }
  });

  it("F で全体を見て、もう一度 F で差分を見る状態に入っても選択は残る。変化が無くて自動に戻っても残る", () => {
    const changedTree = arrowTree("A");
    const overview = reduceViewing(sel, key("F"), changedTree).state;
    expect(overview).toEqual({ selection: { id: "A1", byKey: true } });
    expect(reduceViewing(overview, key("F"), changedTree).state).toEqual({ selection: { id: "A1", byKey: true } });
    const fromAuto = reduceViewing(selected("A1", false), key("F"), arrowTree("A")).state;
    expect(fromAuto).toEqual({ selection: { id: "A1", byKey: false } });
    expect(reduceViewing(fromAuto, key("F"), arrowTree("A")).state).toEqual(selected("A1", false));
  });

  it("全体を見ている間の反映でも選択は残る", () => {
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(selectionOf(reduceViewing(overview, reflect, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    expect(selectionOf(reduceViewing(overview, reflect, arrowTree("B")).state)).toEqual({ id: "A1", byKey: true });
  });

  it("見返しの idle・timeMoved で自動に戻っても、選択は残る", () => {
    const idleBack = reduceViewing(sel, { type: "idle" }, arrowTree("A"));
    expect(idleBack.state).toEqual({ selection: { id: "A1", byKey: true } });

    const moveBack = reduceViewing(sel, { type: "timeMoved" }, arrowTree("A"));
    expect(moveBack.state).toEqual({ selection: { id: "A1", byKey: true } });
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(reduceViewing(overview, { type: "timeMoved" }, arrowTree("A")).state).toEqual({ selection: { id: "A1", byKey: true } });
  });

  it("選んでいないときは selection のフィールドを置かない（全ての出来事で）", () => {
    for (const event of [reflect, moved, plainEscape, key("="), { type: "idle" } as ViewingEvent]) {
      expect("selection" in reduceViewing(INITIAL_VIEWING, event, arrowTree("A")).state).toBe(false);
    }
  });
});

describe("reduceViewing: 選択は Esc でだけ外れる", () => {
  it.each([true, false])("修飾なしの Esc で選択を外す（byKey=%s）", (byKey) => {
    const out = reduceViewing(selected("A1", byKey), plainEscape, arrowTree("A"));
    expect(out.state.selection).toBeUndefined();
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの Esc では選択が残る", (mod) => {
    for (const byKey of [true, false]) {
      const from = selected("A1", byKey);
      expect(reduceViewing(from, { ...plainEscape, [mod]: true }, arrowTree("A")).state).toEqual(from);
    }
  });

  it("Esc で外したあとの矢印は、未選択と同じく今の議題を選ぶだけ", () => {
    const { state } = run([[arrow("down"), arrowTree("A")], [arrow("down"), arrowTree("A")], [plainEscape, arrowTree("A")], [arrow("down"), arrowTree("A2")]]);
    expect(selectionOf(state)).toEqual({ id: "A2", byKey: true });
  });

  it("Esc で右の列の出し入れは変わらない", () => {
    const from: ViewingState = { sideHidden: true, selection: { id: "A1", byKey: true } };
    expect(reduceViewing(from, plainEscape, arrowTree("A")).state).toEqual({ sideHidden: true });
  });
});

describe("reduceViewing: 選択でも入力を書き換えない", () => {
  it("select・arrow・escape は、入力の状態と木を書き換えず、新しいオブジェクトを返す", () => {
    const state: ViewingState = Object.freeze({ selection: Object.freeze({ id: "A1", byKey: true }) });
    const t = arrowTree("A");
    const before = JSON.stringify(t);
    for (const event of [click("B"), arrow("down"), arrow("right"), plainEscape]) {
      reduceViewing(state, event, t);
    }
    expect(state).toEqual({ selection: { id: "A1", byKey: true } });
    expect(JSON.stringify(t)).toBe(before);
  });
});

// ---- #319: 選択と畳む見せ方のつなぎ ----

const fnode = (id: string, parent: string | null, kind: SnapshotNode["kind"], evidence: string[], extra: Partial<SnapshotNode> = {}): SnapshotNode => ({
  id,
  parent,
  kind,
  text: id,
  evidence,
  ...extra,
});
const fsnap = (nodes: SnapshotNode[], round: number, currentTopic?: string): Snapshot => ({
  nodes,
  round,
  changes: [],
  remarks: [],
  now: 10,
  ...(currentTopic !== undefined ? { currentTopic } : {}),
});
const finished = { talkStatus: "済み" } as const;
const froot = fnode("root", null, "会議", []);

// 本番と同じく、畳む見せ方の結果から見えている木を組み立てる
const visibleOf = (
  snapshot: Snapshot,
  selectedId: string | null,
  human: HumanFolds | undefined = undefined,
): VisibleTree => {
  const view = foldView(snapshot, human, selectedId);
  const shown = view.nodes;
  return {
    ids: shown.map((n) => n.id),
    targets: Object.fromEntries(shown.map((n, i) => [n.id, { x: n.parent === null ? 0 : 200, y: i * 50 }])),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    fold: view,
    currentTopic: snapshot.currentTopic,
  };
};

describe("reduceViewing: Esc で選択を外した直後は、普段どおりに畳まれる", () => {
  // 済みの議題 A の下の論点 A1 を選んでいる間は A は開き、Esc で外れた次の描画で畳まれる
  const snapshot = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("B", "root", "議題", ["r1"])], 4, "B");
  const sel = selected("A1", true);

  it("選んでいる間は祖先 A が開いて A1 が見え、Esc の出力の selection（無い）を渡すと A1 は畳まれて見えない", () => {
    expect(foldView(snapshot, undefined, sel.selection?.id ?? null).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B"]);
    const out = reduceViewing(sel, plainEscape, visibleOf(snapshot, "A1"));
    expect(out.state.selection).toBeUndefined();
    expect(foldView(snapshot, undefined, out.state.selection?.id ?? null).nodes.map((n) => n.id)).toEqual(["root", "A", "B"]);
  });

  it("修飾つきの Esc では選択が残るので、畳み方も変わらない", () => {
    const out = reduceViewing(sel, { ...plainEscape, meta: true } as ViewingEvent, visibleOf(snapshot, "A1"));
    expect(foldView(snapshot, undefined, out.state.selection?.id ?? null).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B"]);
  });
});

describe("reduceViewing: 畳んだ議題・「議題 N 件」では → で中へ入らない", () => {
  const nodes = [
    froot,
    fnode("A", "root", "議題", ["r1"], finished),
    fnode("A1", "A", "論点", ["r1"]),
    fnode("B", "root", "議題", ["r1"], finished),
    fnode("B1", "B", "論点", ["r1"]),
    fnode("C", "root", "議題", ["r1"]),
    fnode("C1", "C", "論点", ["r1"], finished),
    fnode("C1a", "C1", "決定", ["r1"]),
  ];
  const snapshot = fsnap(nodes, 4, "C");

  it("「議題 N 件」（run:A）を選んで → を押しても、同じ run:A のまま（中身は見せるノードに無い）", () => {
    const t = visibleOf(snapshot, "run:A");
    expect(t.ids).toEqual(["root", "run:A", "C", "C1"]);
    const out = reduceViewing(selected("run:A", true), arrow("right"), t);
    expect(selectionOf(out.state)).toEqual({ id: "run:A", byKey: true });
  });

  it("畳んだ議題（まとめに入らない単独のもの）を選んで → を押しても、同じ議題のまま", () => {
    const single = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("C", "root", "議題", ["r1"])], 4, "C");
    const t = visibleOf(single, "A");
    expect(t.ids).toEqual(["root", "A", "C"]);
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), t).state)).toEqual({ id: "A", byKey: true });
  });

  it("畳んだ論点を選んで → を押しても動かない", () => {
    const t = visibleOf(snapshot, "C1");
    expect(t.ids).toContain("C1");
    expect(t.ids).not.toContain("C1a");
    expect(selectionOf(reduceViewing(selected("C1", true), arrow("right"), t).state)).toEqual({ id: "C1", byKey: true });
  });

  it("「議題 N 件」へは、同じ深さの矢印（↑）で選べる", () => {
    const t = visibleOf(snapshot, null);
    expect(selectionOf(reduceViewing(selected("C", true), arrow("up"), t).state)).toEqual({ id: "run:A", byKey: true });
  });
});

describe("reduceViewing: 選んだノードが統合・削除・時刻の巻き戻しで消えたら、選択を移す", () => {
  const before = fsnap(
    [
      froot,
      fnode("A", "root", "議題", ["r1"]),
      fnode("P1", "A", "論点", ["r1"]),
      fnode("P2", "A", "論点", ["r2"]),
      fnode("X", "P2", "案", ["r2"]),
    ],
    4,
    "A",
  );
  const merged: Snapshot = {
    ...fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1", "r2"]), fnode("X", "P1", "案", ["r2"])], 5, "A"),
    changes: [{ change: "統合", node: "P1", kind: "論点", text: "P1", from: ["P2"], round: 5, at: 10 }],
  };
  const deleted = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1"])], 5, "A");

  const reflectFrom = (b: Snapshot, a: Snapshot, state: ViewingState) => {
    const replaced = relocations({ tree: visibleOf(b, null), snapshot: b, selectedId: state.selection?.id ?? null }, { tree: visibleOf(a, null), snapshot: a });
    return reduceViewing(state, { type: "reflect", replaced }, visibleOf(a, null));
  };

  // 今の議題は B。人の畳み（A）で選択ノード P2 が前の木から隠れた状態で、反映が起きる。選択は移り先へ移り、根拠欄も移り先を出す
  const withB = (nodes: SnapshotNode[], round: number, changes: Snapshot["changes"] = []): Snapshot => ({ ...fsnap([...nodes, fnode("B", "root", "議題", ["r3"])], round, "B"), changes });
  const reflectHidden = (b: Snapshot, a: Snapshot) => {
    const humanFolds = foldingActions(b, [{ type: "toggle", id: "A" }]).human;
    const state: ViewingState = { humanFolds, selection: { id: "P2", byKey: true } };
    const prevTree = visibleOf(b, "P2", humanFolds);
    expect(prevTree.ids).not.toContain("P2");
    const replaced = relocations({ tree: prevTree, snapshot: b, selectedId: "P2" }, { tree: visibleOf(a, "P2", humanFolds), snapshot: a });
    const out = reduceViewing(state, { type: "reflect", replaced }, visibleOf(a, "P2", humanFolds));
    return { out, evidence: evidenceOf(a, out.state.selection?.id ?? "", humanFolds) };
  };
  const hiddenBefore = withB(before.nodes, 4);

  it("人の畳みで隠れた選択ノードが削除されたら、残る祖先 A へ移り、根拠欄も A を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(deleted.nodes, 5));
    expect(out.state.selection).toEqual({ id: "A", byKey: true });
    expect(evidence?.node.id).toBe("A");
  });

  it("人の畳みで隠れた選択ノードが統合されたら、統合先 P1 へ移り、根拠欄も P1 を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(merged.nodes, 5, merged.changes));
    expect(out.state.selection).toEqual({ id: "P1", byKey: true });
    expect(evidence?.node.id).toBe("P1");
  });

  it("人の畳みで隠れた選択ノードが、巻き戻しで無い時点になったら、統合先ではなく祖先 A へ移り、根拠欄も A を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(merged.nodes, 3, merged.changes));
    expect(out.state.selection).toEqual({ id: "A", byKey: true });
    expect(evidence?.node.id).toBe("A");
  });

  it("統合されたら、残った統合先へ選択を移し byKey を保つ", () => {
    for (const byKey of [true, false]) {
      const state = selected("P2", byKey);
      const out = reflectFrom(before, merged, state);

      expect(out.state).toEqual({ selection: { id: "P1", byKey } });
    }
  });

  it("削除されたら、親へ移る。子もまとめて消えたノードを選んでいても、残っている親へ", () => {
    expect(reflectFrom(before, deleted, selected("P2", true)).state.selection).toEqual({ id: "A", byKey: true });
    expect(reflectFrom(before, deleted, selected("X", false)).state.selection).toEqual({ id: "A", byKey: false });
  });

  it("削除されたノードから残った祖先へ選択を移す", () => {
    const out = reflectFrom(before, deleted, selected("P2", true));
    expect(out.state).toEqual({ selection: { id: "A", byKey: true } });
  });

  it("選択を移しても byKey を保つ", () => {
    const overview: ViewingState = { selection: { id: "P2", byKey: true } };
    const out = reflectFrom(before, deleted, overview);
    expect(out.state).toEqual({ ...overview, selection: { id: "A", byKey: true } });
  });

  it("消えていないノードを選んでいるときは、ほかのノードが消えても選択はそのまま", () => {
    const state = selected("P1", true);
    expect(reflectFrom(before, deleted, state).state).toEqual(state);
  });

  it("選択が無いときは、ノードが消えても選択は付かない", () => {
    const out = reflectFrom(before, deleted, {});
    expect(out.state).toEqual({});
  });

  it("移した後は、右の列を隠した状態も残る", () => {
    const state: ViewingState = { sideHidden: true, selection: { id: "P2", byKey: true } };
    expect(reflectFrom(before, deleted, state).state).toEqual({ ...state, selection: { id: "A", byKey: true } });
  });

  it("見返しで時刻を戻して選んだノードがまだ無い時点になったら、その時点にある、いちばん近い祖先へ移る", () => {
    const later = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1"]), fnode("P3", "A", "論点", ["r3"]), fnode("Y", "P3", "案", ["r3"])], 5, "A");
    const earlier = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1", "r3"])], 3, "A");
    const state = selected("Y", true);
    const out = reflectFrom(later, earlier, state);
    expect(out.state).toEqual({ selection: { id: "A", byKey: true } });
  });

  it("移り先を求める入力（replaced）を書き換えない", () => {
    const replaced = Object.freeze({ P2: "P1" });
    const state = Object.freeze({ selection: Object.freeze({ id: "P2", byKey: true }) });
    const out = reduceViewing(state, { type: "reflect", replaced }, arrowTree("A"));
    expect(out.state.selection).toEqual({ id: "P1", byKey: true });
    expect(state.selection).toEqual({ id: "P2", byKey: true });
    expect(replaced).toEqual({ P2: "P1" });
  });
});

const hnodes = [froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("B", "root", "議題", ["r1"]), fnode("C", "root", "議題", ["r1"]), fnode("C1", "C", "論点", ["r1"])];
const curB = fsnap(hnodes, 4, "B");
const runsSnap = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("D", "root", "議題", ["r1"], finished), fnode("B", "root", "議題", ["r1"])], 4, "B");
const enter = (mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type: "enter", meta: false, ctrl: false, alt: false, ...mods });
const press = (state: ViewingState, event: ViewingEvent, snapshot: Snapshot = curB) => reduceViewing(state, event, visibleOf(snapshot, state.selection?.id ?? null, state.humanFolds));
const selectionAndSide = (state: ViewingState) => {
  const { humanFolds: _human, ...rest } = state;
  return rest;
};

describe("reduceViewing: 開閉の結果を選択へ反映する", () => {
  it.each([true, false])("子孫を畳んだ議題へ選択を移し、byKey=%s を保つ", (byKey) => {
    const out = press(selected("C1", byKey), { type: "foldDot", id: "C" });
    expect(out.state.selection).toEqual({ id: "C", byKey });
  });

  it("Enter は選択の byKey を変えない", () => {
    const out = press(selected("A", false), enter());
    expect(selectionAndSide(out.state)).toEqual({ selection: { id: "A", byKey: false } });
  });

  it("開閉しても右の列と選択を保つ", () => {
    const out = press({ sideHidden: true, selection: { id: "A", byKey: true } }, enter());
    expect(selectionAndSide(out.state)).toEqual({ sideHidden: true, selection: { id: "A", byKey: true } });
  });

  it("丸で別の枝を開いても選択を変えず、選択なしの丸でも選択を付けない", () => {
    expect(press(selected("B", true), { type: "foldDot", id: "A" }).state.selection).toEqual({ id: "B", byKey: true });
    expect(press(INITIAL_VIEWING, { type: "foldDot", id: "A" }).state.selection).toBeUndefined();
  });

  it("修飾付き Enter と選択なしの Enter は見方の状態を変えない", () => {
    for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) {
      const from = selected("A", true);
      expect(press(from, enter(mods)).state).toEqual(from);
    }
    expect(press(INITIAL_VIEWING, enter()).state).toEqual(INITIAL_VIEWING);
  });

  it("効かない丸と fold のない木では見方の状態を変えない", () => {
    for (const id of ["B", "root", "A1", "gone"]) expect(press(INITIAL_VIEWING, { type: "foldDot", id }).state).toEqual(INITIAL_VIEWING);
    expect(reduceViewing(selected("A", true), enter(), { ...visibleOf(curB, "A"), fold: null }).state).toEqual(selected("A", true));
  });

  it.each([true, false])("まとめを解くと先頭へ選択を移し、byKey=%s を保つ", (byKey) => {
    const out = press(selected("run:A", byKey), enter(), runsSnap);
    expect(out.state.selection).toEqual({ id: "A", byKey });
  });

  it("選択なしでまとめの丸を押すと先頭を選ぶ", () => {
    const out = press({}, { type: "foldDot", id: "run:A" }, runsSnap);
    expect(out.state.selection).toEqual({ id: "A", byKey: false });
  });

  it("pointChange は対象を選び、右の列を隠したままにする", () => {
    const out = press({ sideHidden: true }, { type: "pointChange", id: "A" });
    expect(selectionAndSide(out.state)).toEqual({ sideHidden: true, selection: { id: "A", byKey: false } });
  });

  it("存在しない ID の pointChange は select と同じ選択になる", () => {
    const pointed = press(INITIAL_VIEWING, { type: "pointChange", id: "gone" });
    const selected = press(INITIAL_VIEWING, { type: "select", id: "gone" });
    expect(pointed.state).toEqual(selected.state);
  });

  it("reflect は選択を付け替える", () => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "C" }]).human;
    const from: ViewingState = { humanFolds, selection: { id: "old", byKey: true } };
    const next = { ...curB, currentTopic: "C" };
    const out = press(from, { type: "reflect", replaced: { old: "C" } }, next);
    expect(selectionAndSide(out.state)).toEqual({ selection: { id: "C", byKey: true } });
  });

  it("Esc は人の欄と選択を落とす", () => {
    const humanFolds = foldingActions(runsSnap, [{ type: "toggle", id: "run:A" }]).human;
    const from: ViewingState = { humanFolds, sideHidden: true, selection: { id: "A", byKey: true } };
    const out = press(from, plainEscape, runsSnap);
    expect(out.state).toEqual({ sideHidden: true });

    for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) expect(press(from, { ...plainEscape, ...mods }, runsSnap).state).toEqual(from);
  });

  it("他の出来事を連続しても、人の開閉による表示を保つ", () => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "A" }, { type: "toggle", id: "C" }]).human;
    let state: ViewingState = { humanFolds };
    const events: ViewingEvent[] = [{ type: "idle" }, key("="), key("="), key("F"), key("F"), { type: "side", meta: false, ctrl: false, alt: false }, arrow("down"), { type: "edgeDot", id: "B" }, { type: "select", id: "B" }, { type: "timeMoved" }, { type: "deselect" }];
    for (const event of events) {
      state = press(state, event).state;
      expect(foldView(curB, state.humanFolds, null).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B", "C"]);
    }
  });

  it("開閉・point・Esc・reflect は入力の状態・木・出来事を変更しない", () => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "A" }]).human;
    const state: ViewingState = Object.freeze({ humanFolds, selection: { id: "A1", byKey: true } });
    const t = visibleOf(curB, "A1", humanFolds);
    const before = structuredClone({ state, t });
    for (const event of [enter(), { type: "foldDot", id: "A" }, { type: "pointChange", id: "C" }, plainEscape, reflect] satisfies ViewingEvent[]) {
      const input = structuredClone(event);
      reduceViewing(state, event, t);
      expect(event).toEqual(input);
    }
    expect({ state, t }).toEqual(before);
    expect(foldView(curB, humanFolds, "A1")).toEqual(t.fold);
  });
});

describe("reduceViewing: deselect は選択だけを外す", () => {
  it("選択を外しても、人の開閉と右の列の出し入れを保つ", () => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "A" }]).human;
    const from: ViewingState = { humanFolds, sideHidden: true, selection: { id: "A1", byKey: true } };
    const out = press(from, { type: "deselect" });
    expect(selectionAndSide(out.state)).toEqual({ sideHidden: true });

    expect(foldView(curB, out.state.humanFolds, null).openness["A"]).toEqual({ state: "open", byHuman: true });
  });
});
