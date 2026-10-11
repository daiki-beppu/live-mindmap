import { HashMap, Option, Schema } from "effect";
import { expectNoOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import { foldView, pointedNode } from "../src/folding.ts";
import { humanSetsOf, INITIAL_VIEWING, reduceViewing, ViewingState, type CameraCommand, type ViewingEvent, type VisibleTree } from "../src/viewing.ts";

// 右の列（Issue #821）の update。変わったことの項目を押した事実が、見る状態（選んだノード・開いた祖先）とカメラへの指示を、今の画面（SessionView の point）と同じにすること、
// 右の列の出す・隠すが見る状態の sideHidden だけを変えることを見る。期待値は、純粋な関数（pointedNode・reduceViewing）を直接呼んだ値と、手で書いた値。
// カメラの指示をビューポートに当てるのは #819 の範囲なので、ここでは指示そのもの（Model.camera）までを見る

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題", extra: Partial<SnapshotNode> = {}): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [], ...extra });
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 3, changes: [], remarks: [], ...extra });

// 済みの議題 A（論点 A1 を持つ）は畳まれ、話し中の今の議題 B は畳まれない
const single = (): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("B", "root", "議題")], { currentTopic: "B", now: 100 });
const HEIGHTS = { root: 40, A: 50, A1: 60, B: 70 };
const NONE: ReadonlySet<string> = new Set();

const measuredModel = (snapshot: Snapshot, viewing: ViewingState = INITIAL_VIEWING): MapSurfaceModel => ({
  ...init(snapshot, "live", false),
  size: Option.some({ width: 800, height: 600 }),
  nodeHeights: HashMap.make(...Object.entries(HEIGHTS)),
  viewing,
});
const clickChange = (nodeId: string) => message(Message.ClickedChangeItem({ nodeId }));
const toggleSide = (isOpen: boolean) => message(Message.ToggledSide({ isOpen }));

// pointChange・select・side は、木の中身を使わない（currentTopic だけ）。更新前の木の currentTopic を渡して純粋な関数を呼ぶ
const treeOf = (snapshot: Snapshot): VisibleTree => ({ ids: [], targets: {}, parents: {}, foldState: {}, runs: {}, currentTopic: snapshot.currentTopic });
const reduced = (state: ViewingState, event: ViewingEvent, snapshot: Snapshot) => reduceViewing(state, event, treeOf(snapshot));
// 項目を押したときの、今の画面と同じ出来事（SessionView.tsx の point）
const pointEvent = (snapshot: Snapshot, state: ViewingState, id: string): ViewingEvent => {
  const { opened, folded, unbundled } = humanSetsOf(state);
  const found = pointedNode(snapshot, id, opened, folded, unbundled);
  return found === null ? { type: "select", id } : { type: "pointChange", id, ...found };
};

describe("mapSurface の Model: カメラへの指示の欄", () => {
  it("init は今の画面の始まりと同じ follow（自動で寄せる）で始まり、本物の Schema の Model に通る", () => {
    expect(init(single(), "live", false).camera).toEqual({ type: "follow" });
    expect(init(single(), "still", false).camera).toEqual({ type: "follow" });
    const is = Schema.is(Model);
    expect(is(init(single(), "live", false))).toBe(true);
    expect(is({ ...init(single(), "live", false), camera: { type: "focusNode", id: "A" } })).toBe(true);
    expect(is({ ...init(single(), "live", false), camera: { type: "zoomBy", factor: 1.5 } })).toBe(true);
  });

  it("知らない指示・欄の足りない指示・camera を持たない Model は通らない", () => {
    const is = Schema.is(Model);
    expect(is({ ...init(single(), "live", false), camera: { type: "spin" } })).toBe(false);
    expect(is({ ...init(single(), "live", false), camera: { type: "focusNode" } })).toBe(false);
    expect(is({ ...init(single(), "live", false), camera: { type: "zoomBy", factor: "2" } })).toBe(false);
    expect(is({ ...init(single(), "live", false), camera: null })).toBe(false);
    const { camera: _camera, ...without } = init(single(), "live", false);
    expect(is(without)).toBe(false);
  });

  it("カメラの 13 の指示は、そのまま Model に入る（今の CameraCommand の形と同じ）", () => {
    const is = Schema.is(Model);
    const commands: CameraCommand[] = [
      { type: "follow" },
      { type: "refocus" },
      { type: "hold" },
      { type: "zoomBy", factor: 1.2 },
      { type: "zoomTo", zoom: 1 },
      { type: "pan", dx: 1, dy: -1 },
      { type: "fitAll" },
      { type: "focusNode", id: "A" },
      { type: "keepNode", id: "A" },
      { type: "revealNode", id: "A" },
      { type: "fitSubtree", id: "A" },
      { type: "restore" },
      { type: "shiftIntoView" },
    ];
    expect(commands).toHaveLength(13);
    for (const camera of commands) expect(is({ ...init(single(), "live", false), camera })).toBe(true);
  });
});

describe("mapSurface の update: 変わったことの項目を押す（reduceViewing の pointChange）", () => {
  it("畳まれた議題 A の項目を押すと、A を選び（byKey は false）、手動のカメラになり、A を人が開いた集合に足し、A へ寄る指示になる", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot)),
      clickChange("A"),
      model((m) => {
        expect(m.viewing).toEqual(reduced(INITIAL_VIEWING, pointEvent(snapshot, INITIAL_VIEWING, "A"), snapshot).state);
        expect(m.viewing).toEqual({ mode: "manual", topic: "B", selection: { id: "A", byKey: false }, humanOpened: new Set(["A"]) });
        expect(m.camera).toEqual({ type: "focusNode", id: "A" });
      }),
      expectNoOutMessage(),
    );
  });

  it("人が畳んだ議題 A の中の A1 の項目を押すと、A の人の畳みが外れ、A1 を選び、A1 へ寄る。A1 自身は畳む条件に当たらないので開いた集合には足さない", () => {
    const snapshot = single();
    const folded: ViewingState = { mode: "auto", humanFolded: new Set(["A"]) };
    story(
      update,
      given(measuredModel(snapshot, folded)),
      clickChange("A1"),
      model((m) => {
        expect(m.viewing).toEqual(reduced(folded, pointEvent(snapshot, folded, "A1"), snapshot).state);
        expect(m.viewing.selection).toEqual({ id: "A1", byKey: false });
        expect(m.viewing.mode).toBe("manual");
        expect(humanSetsOf(m.viewing).folded.has("A")).toBe(false);
        expect(humanSetsOf(m.viewing).opened.has("A1")).toBe(false);
        expect(m.camera).toEqual({ type: "focusNode", id: "A1" });
      }),
    );
  });

  it("押す前の人の開閉・キー一覧などの他の状態は残る（関係のない祖先の畳みも外れない）", () => {
    const snapshot = single();
    const before: ViewingState = { mode: "auto", keyList: true, humanFolded: new Set(["A", "B"]), humanOpened: new Set(["root"]), captionsHidden: true };
    story(
      update,
      given(measuredModel(snapshot, before)),
      clickChange("A1"),
      model((m) => {
        expect(m.viewing).toEqual(reduced(before, pointEvent(snapshot, before, "A1"), snapshot).state);
        expect(m.viewing.keyList).toBe(true);
        expect(m.viewing.captionsHidden).toBe(true);
        expect(humanSetsOf(m.viewing).folded.has("B")).toBe(true);
        expect(humanSetsOf(m.viewing).folded.has("A")).toBe(false);
        expect(humanSetsOf(m.viewing).opened.has("root")).toBe(true);
      }),
    );
  });

  it("今のマップに無いノードの項目を押すと、select と同じ（mode は変えず、選ぶだけ）で、カメラの指示は focusNode ではない", () => {
    const snapshot = single();
    expect(pointedNode(snapshot, "gone", NONE, NONE, NONE)).toBeNull();
    story(
      update,
      given(measuredModel(snapshot)),
      clickChange("gone"),
      model((m) => {
        const expected = reduced(INITIAL_VIEWING, { type: "select", id: "gone" }, snapshot);
        expect(m.viewing).toEqual(expected.state);
        expect(m.viewing).toEqual({ mode: "auto", selection: { id: "gone", byKey: false } });
        expect(m.camera).toEqual(expected.camera);
        expect(m.camera).not.toEqual({ type: "focusNode", id: "gone" });
      }),
    );
  });

  it("別のノードを選んでいても、押したノードへ移る（選択は押したノードに替わる）", () => {
    const snapshot = single();
    const before: ViewingState = { mode: "manual", topic: "B", selection: { id: "B", byKey: true } };
    story(
      update,
      given(measuredModel(snapshot, before)),
      clickChange("A1"),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "A1", byKey: false });
        expect(m.camera).toEqual({ type: "focusNode", id: "A1" });
      }),
    );
  });

  it("続けて別の項目を押すと、見る状態もカメラの指示も、そのつど押したノードの結果になる（最初の結果が残らない）", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot)),
      clickChange("A"),
      model((m) => expect(m.camera).toEqual({ type: "focusNode", id: "A" })),
      clickChange("B"),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "B", byKey: false });
        expect(m.camera).toEqual({ type: "focusNode", id: "B" });
      }),
      clickChange("gone"),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "gone", byKey: false });
        expect(m.camera).not.toEqual({ type: "focusNode", id: "B" });
      }),
    );
  });

  it("項目を押すと、畳んだ議題 A が開いて A1 が見え、更新前の位置から補間が始まる（選択・開閉で目標の位置が変わる）", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot)),
      clickChange("A1"),
      model((m) => {
        const shown = foldView(snapshot, humanSetsOf(m.viewing).opened, "A1", humanSetsOf(m.viewing).folded, humanSetsOf(m.viewing).unbundled).nodes.map((n) => n.id);
        expect(shown).toContain("A1");
        expect(Option.isSome(m.motion)).toBe(true);
      }),
    );
  });

  it("項目を押す前は camera は follow のまま、押してもスナップショットは変わらない", () => {
    const snapshot = single();
    const start = measuredModel(snapshot);
    expect(start.camera).toEqual({ type: "follow" });
    story(
      update,
      given(start),
      clickChange("A"),
      model((m) => expect(m.snapshot).toEqual(single())),
    );
  });
});

describe("mapSurface の update: 他の出来事でも、見る状態が返したカメラの指示を Model に残す", () => {
  it("ノード本体の click（select）の後の camera は、select の結果（自動のカメラのままなので follow）になる", () => {
    const snapshot = single();
    story(
      update,
      given({ ...measuredModel(snapshot), camera: { type: "focusNode", id: "A" } as CameraCommand }),
      message(Message.ClickedNodeButton({ nodeId: "B", clientX: 0, clientY: 0 })),
      model((m) => expect(m.camera).toEqual(reduced(INITIAL_VIEWING, { type: "select", id: "B" }, snapshot).camera)),
    );
  });
});

describe("mapSurface の update: 右の列の出す・隠す（reduceViewing の side）", () => {
  it("隠す（ToggledSide の isOpen=false）と viewing.sideHidden が true になり、カメラの指示は shiftIntoView。選択など他の状態は残る", () => {
    const snapshot = single();
    const before: ViewingState = { mode: "manual", topic: "B", selection: { id: "A", byKey: false }, humanOpened: new Set(["A"]) };
    story(
      update,
      given(measuredModel(snapshot, before)),
      toggleSide(false),
      model((m) => {
        const expected = reduced(before, { type: "side", meta: false, ctrl: false, alt: false }, snapshot);
        expect(m.viewing).toEqual(expected.state);
        expect(m.viewing).toEqual({ ...before, sideHidden: true });
        expect(m.camera).toEqual({ type: "shiftIntoView" });
      }),
      expectNoOutMessage(),
    );
  });

  it("出す（isOpen=true）と sideHidden の欄が無くなる（false ではなく欄ごと消える。INITIAL_VIEWING に戻る）", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot, { mode: "auto", sideHidden: true })),
      toggleSide(true),
      model((m) => {
        expect(m.viewing).toEqual(INITIAL_VIEWING);
        expect("sideHidden" in m.viewing).toBe(false);
        expect(m.camera).toEqual({ type: "shiftIntoView" });
      }),
    );
  });

  it("出す側の状態を「出す」、隠す側の状態を「隠す」で受けても、見る状態は変わらず、カメラの指示も動かさない", () => {
    const snapshot = single();
    const shown = measuredModel(snapshot);
    story(
      update,
      given(shown),
      toggleSide(true),
      model((m) => {
        expect(m.viewing).toEqual(shown.viewing);
        expect(m.camera).toEqual(shown.camera);
      }),
    );
    const hidden = measuredModel(snapshot, { mode: "auto", sideHidden: true });
    story(
      update,
      given(hidden),
      toggleSide(false),
      model((m) => {
        expect(m.viewing).toEqual(hidden.viewing);
        expect(m.camera).toEqual(hidden.camera);
      }),
    );
  });

  it("隠す → 出すを続けると、同じ Model の上で元の見る状態に戻る（出し入れの前後で選択は保たれる）", () => {
    const snapshot = single();
    const before: ViewingState = { mode: "auto", selection: { id: "A1", byKey: false } };
    story(
      update,
      given(measuredModel(snapshot, before)),
      toggleSide(false),
      model((m) => expect(m.viewing.sideHidden).toBe(true)),
      toggleSide(true),
      model((m) => expect(m.viewing).toEqual(before)),
    );
  });

  it("隠している間も、項目を押せば選べる（sideHidden は選択の結果に影響せず、保たれる）", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot, { mode: "auto", sideHidden: true })),
      clickChange("A"),
      model((m) => {
        expect(m.viewing.sideHidden).toBe(true);
        expect(m.viewing.selection).toEqual({ id: "A", byKey: false });
      }),
    );
  });
});
