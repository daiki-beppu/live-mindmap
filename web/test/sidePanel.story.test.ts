import { HashMap, Option } from "effect";
import { expectNoOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import { initialCamera, cameraFocus, focusViewport, nodeFocusViewport, nodeRect, shiftIntoView, type Rect, type Viewport } from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { layout } from "../src/layout.ts";
import { INITIAL_VIEWING, reduceViewing, type ViewingEvent, type ViewingState, type VisibleTree } from "../src/viewing.ts";
import { foldingActions } from "./foldingActions.ts";

// 右の列（Issue #821）の update。変わったことの項目を押した事実が、見る状態（選んだノード・開いた祖先）とビューポートを、今の画面（SessionView の point）と同じにすること、
// 右の列の出す・隠すが見る状態の sideHidden だけを変えることを見る。期待値は、純粋な関数（reduceViewing・camera.ts）を直接呼んだ値と、手で書いた値。
// カメラの指示は update の中でその場でビューポートに当たる（Issue #819）ので、指示そのものではなく、外から見える viewport で確かめる

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: Exclude<SnapshotNode["kind"], "補足"> = "議題", extra: Partial<Exclude<SnapshotNode, { kind: "補足" }>> = {}): Exclude<SnapshotNode, { kind: "補足" }> => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [], ...extra });
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 3, changes: [], remarks: [], ...extra });

// 済みの議題 A（論点 A1 を持つ）は畳まれ、話し中の今の議題 B は畳まれない
const single = (): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("B", "root", "議題")], { currentTopic: "B", now: 100 });
const HEIGHTS = { root: 40, A: 50, A1: 60, B: 70 };
const shownView = (m: MapSurfaceModel) => foldView(m.snapshot, m.viewing.humanFolds, m.viewing.selection?.id ?? null);

const measuredModel = (snapshot: Snapshot, viewing: ViewingState = INITIAL_VIEWING, camera: Pick<MapSurfaceModel["camera"], "mode" | "topic"> = { mode: "auto", topic: undefined }): MapSurfaceModel => ({
  ...init(snapshot, "live", false),
  size: Option.some({ width: 800, height: 600 }),
  nodeHeights: HashMap.make(...Object.entries(HEIGHTS)),
  viewing,
  camera: { ...initialCamera(), ...camera },
});
// 更新後の見る状態で見せるノードを、実寸の高さで並べた目標の位置から、ノード id の箱を測って寄せた位置（倍率は今のまま）
const focusedOn = (m: MapSurfaceModel, id: string, zoom: number): Viewport => {
  const shown = foldView(m.snapshot, m.viewing.humanFolds, m.viewing.selection?.id ?? null).nodes;
  const dims = Object.fromEntries(Object.entries(HEIGHTS).map(([k, height]) => [k, { height }]));
  return nodeFocusViewport(nodeRect(id, layout(shown, HEIGHTS), dims), zoom, Option.getOrThrow(m.size));
};
// 自動のカメラが今の議題へ寄せた位置（話し中の議題 B）
const focusBoxes = (m: MapSurfaceModel): { rects: Rect[]; center: Rect } => {
  const view = foldView(m.snapshot, m.viewing.humanFolds, m.viewing.selection?.id ?? null);
  const focus = cameraFocus(m.snapshot)!;
  const target = layout(view.nodes, HEIGHTS);
  const dims = Object.fromEntries(Object.entries(HEIGHTS).map(([k, height]) => [k, { height }]));
  const shownId = (id: string) => view.shownAs[id] ?? id;
  return { rects: [...new Set(focus.ids.map(shownId))].map((id) => nodeRect(id, target, dims)), center: nodeRect(shownId(focus.center), target, dims) };
};
const autoFocused = (m: MapSurfaceModel): Viewport => {
  const { rects, center } = focusBoxes(m);
  return focusViewport(rects, center, Option.getOrThrow(m.size));
};
const expectViewport = (actual: Viewport, expected: Viewport) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 6);
};
const differs = (a: Viewport, b: Viewport) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.zoom - b.zoom) > 1e-3;
const clickChange = (nodeId: string) => message(Message.ClickedChangeItem({ nodeId }));
const toggleSide = (isOpen: boolean) => message(Message.ToggledSide({ isOpen }));

// pointChange は実際の表示を渡し、select と side は同じ reducer を使う。
const reduced = (state: ViewingState, event: ViewingEvent, snapshot: Snapshot) => {
  const fold = foldView(snapshot, state.humanFolds, state.selection?.id ?? null);
  const tree: VisibleTree = { ids: fold.nodes.map((n) => n.id), targets: {}, parents: Object.fromEntries(fold.nodes.map((n) => [n.id, n.parent])), fold, currentTopic: snapshot.currentTopic };
  return reduceViewing(state, event, tree);
};

describe("mapSurface の update: 変わったことの項目を押す（reduceViewing の pointChange）", () => {
  it("畳まれた議題 A の項目を押すと、A を選び（byKey は false）、手動のカメラになり、A を人が開いた集合に足し、ビューポートが A へ寄る", () => {
    const snapshot = single();
    const start = measuredModel(snapshot);
    story(
      update,
      given(start),
      clickChange("A"),
      model((m) => {
        expect(m.viewing).toEqual(reduced(INITIAL_VIEWING, { type: "pointChange", id: "A" }, snapshot).state);
        expect(m.viewing).toMatchObject({ selection: { id: "A", byKey: false } });
        expect(m.camera.mode).toBe("manual");
        expect(m.camera.topic).toBe("B");
        expect(shownView(m).openness["A"]).toEqual({ state: "open", byHuman: true });
        expectViewport(m.camera.viewport, focusedOn(m, "A", start.camera.viewport.zoom));
        expect(differs(m.camera.viewport, start.camera.viewport)).toBe(true);
      }),
      expectNoOutMessage(),
    );
  });

  it("人が畳んだ議題 A の中の A1 の項目を押すと、A の人の畳みが外れ、A1 を選び、ビューポートが A1 へ寄る。A1 自身は畳む条件に当たらないので開いた集合には足さない", () => {
    const snapshot = single();
    const folded: ViewingState = { humanFolds: foldingActions(single(), [{ type: "toggle", id: "A" }, { type: "toggle", id: "A" }]).human };
    const start = measuredModel(snapshot, folded);
    story(
      update,
      given(start),
      clickChange("A1"),
      model((m) => {
        expect(m.viewing).toEqual(reduced(folded, { type: "pointChange", id: "A1" }, snapshot).state);
        expect(m.viewing.selection).toEqual({ id: "A1", byKey: false });
        expect(m.camera.mode).toBe("manual");
        expect(shownView(m).nodes.map((n) => n.id)).toContain("A1");
        expect(shownView(m).openness["A"]).toEqual({ state: "open", byHuman: false });
        expectViewport(m.camera.viewport, focusedOn(m, "A1", start.camera.viewport.zoom));
        expect(differs(m.camera.viewport, start.camera.viewport)).toBe(true);
      }),
    );
  });

  it("押す前の人の開閉は残る（関係のない祖先の畳みも外れない）", () => {
    const snapshot = single();
    const before: ViewingState = { humanFolds: foldingActions({ ...snapshot, currentTopic: "A1" }, [{ type: "toggle", id: "B" }]).human };
    story(
      update,
      given(measuredModel(snapshot, before, { mode: "manual", topic: "B" })),
      clickChange("A1"),
      model((m) => {
        expect(m.viewing).toEqual(reduced(before, { type: "pointChange", id: "A1" }, snapshot).state);
        expect(foldView({ ...snapshot, currentTopic: "A1" }, m.viewing.humanFolds, null).openness["B"]?.state).toBe("folded");
        expect(shownView(m).openness["A"]).toEqual({ state: "open", byHuman: false });
      }),
    );
  });

  it("今のマップに無いノードの項目を押すと、select と同じ（mode は変えず、選ぶだけ）で、ビューポートは押したノードへ寄らず、select のときと同じ", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot)),
      clickChange("gone"),
      model((m) => {
        const expected = reduced(INITIAL_VIEWING, { type: "select", id: "gone" }, snapshot);
        expect(m.viewing).toEqual(expected.state);
        expect(m.viewing).toEqual({ selection: { id: "gone", byKey: false } });
        expect(m.camera.mode).toBe("auto");
        // mode が auto のままなので、自動のカメラが今の議題へ寄せる（消えたノードへは寄らない）
        expectViewport(m.camera.viewport, autoFocused(m));
      }),
    );
  });

  it("別のノードを選んでいても、押したノードへ移る（選択は押したノードに替わる）", () => {
    const snapshot = single();
    const before: ViewingState = { selection: { id: "B", byKey: true } };
    const start = measuredModel(snapshot, before, { mode: "manual", topic: "B" });
    story(
      update,
      given(start),
      clickChange("A1"),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "A1", byKey: false });
        expectViewport(m.camera.viewport, focusedOn(m, "A1", start.camera.viewport.zoom));
      }),
    );
  });

  it("続けて別の項目を押すと、見る状態もビューポートも、そのつど押したノードの結果になる（最初の結果が残らない）", () => {
    const snapshot = single();
    let atA: Viewport | undefined;
    let atB: Viewport | undefined;
    story(
      update,
      given(measuredModel(snapshot)),
      clickChange("A"),
      model((m) => {
        atA = m.camera.viewport;
        expectViewport(m.camera.viewport, focusedOn(m, "A", 1));
      }),
      clickChange("B"),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "B", byKey: false });
        atB = m.camera.viewport;
        expectViewport(m.camera.viewport, focusedOn(m, "B", atA!.zoom));
        expect(differs(m.camera.viewport, atA!)).toBe(true);
      }),
      clickChange("gone"),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "gone", byKey: false });
        // 手動のまま（select は mode を変えない）なので、消えたノードへは寄らず、B へ寄せた位置のまま
        expect(m.camera.mode).toBe("manual");
        expectViewport(m.camera.viewport, atB!);
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
        const shown = shownView(m).nodes.map((n) => n.id);
        expect(shown).toContain("A1");
        expect(Option.isSome(m.motion)).toBe(true);
      }),
    );
  });

  it("項目を押す前のビューポートは始まりのまま、押してもスナップショットは変わらない", () => {
    const snapshot = single();
    const start = measuredModel(snapshot);
    expect(start.camera.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    story(
      update,
      given(start),
      clickChange("A"),
      model((m) => expect(m.snapshot).toEqual(single())),
    );
  });
});

describe("mapSurface の update: 他の出来事（select）では、自動のカメラが今の議題へ寄せる", () => {
  it("ノード本体の click（select）の後は、自動のカメラが今の議題へ寄せる。項目を押したときのように押したノードへは寄らない", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot)),
      message(Message.ClickedNodeButton({ nodeId: "B", clientX: 0, clientY: 0 })),
      model((m) => {
        expect(m.viewing).toEqual(reduced(INITIAL_VIEWING, { type: "select", id: "B" }, snapshot).state);
        expectViewport(m.camera.viewport, autoFocused(m));
      }),
    );
  });
});

describe("mapSurface の update: 右の列の出す・隠す（reduceViewing の side）", () => {
  it("隠す（ToggledSide の isOpen=false）と viewing.sideHidden が true になり、ビューポートは動かず、幅が変わったときのずらしが保留になる。選択など他の状態は残る", () => {
    const snapshot = single();
    const before: ViewingState = { selection: { id: "A", byKey: false }, humanFolds: foldingActions(single(), [{ type: "toggle", id: "A" }]).human };
    const start = measuredModel(snapshot, before, { mode: "manual", topic: "B" });
    story(
      update,
      given(start),
      toggleSide(false),
      model((m) => {
        const expected = reduced(before, { type: "side", meta: false, ctrl: false, alt: false }, snapshot);
        expect(m.viewing).toEqual(expected.state);
        expect(m.viewing).toEqual({ ...before, sideHidden: true });
        expect(m.camera.viewport).toEqual(start.camera.viewport);
        expect(m.camera.pendingShift).toBe(true);
      }),
      expectNoOutMessage(),
    );
  });

  it("出す（isOpen=true）と sideHidden の欄が無くなる（false ではなく欄ごと消える。INITIAL_VIEWING に戻る）", () => {
    const snapshot = single();
    story(
      update,
      given(measuredModel(snapshot, { sideHidden: true })),
      toggleSide(true),
      model((m) => {
        expect(m.viewing).toEqual(INITIAL_VIEWING);
        expect("sideHidden" in m.viewing).toBe(false);
        expect(m.camera.pendingShift).toBe(true);
      }),
    );
  });

  it("出す側の状態を「出す」、隠す側の状態を「隠す」で受けても、Model 全体が変わらない（ビューポートもずらしの保留も動かさない）", () => {
    const snapshot = single();
    const shown = measuredModel(snapshot);
    story(
      update,
      given(shown),
      toggleSide(true),
      model((m) => {
        expect(m.viewing).toEqual(shown.viewing);
        expect(m).toEqual(shown);
      }),
    );
    const hidden = measuredModel(snapshot, { sideHidden: true });
    story(
      update,
      given(hidden),
      toggleSide(false),
      model((m) => {
        expect(m.viewing).toEqual(hidden.viewing);
        expect(m).toEqual(hidden);
      }),
    );
  });

  it("隠す → 出すを続けると、同じ Model の上で元の見る状態に戻る（出し入れの前後で選択は保たれる）", () => {
    const snapshot = single();
    const before: ViewingState = { selection: { id: "A1", byKey: false } };
    story(
      update,
      given(measuredModel(snapshot, before, { mode: "manual", topic: "B" })),
      toggleSide(false),
      model((m) => expect(m.viewing.sideHidden).toBe(true)),
      toggleSide(true),
      model((m) => expect(m.viewing).toEqual(before)),
    );
  });

  it("出した後に画面の幅が狭まった測定が来ると、ビューポートが今の議題の切れる分だけずれる（出した時点では動かない）", () => {
    const snapshot = single();
    const hidden: MapSurfaceModel = { ...measuredModel(snapshot, { sideHidden: true }), camera: { ...initialCamera(), viewport: { x: 100, y: 0, zoom: 1 } } };
    const narrow = { width: 300, height: 600 };
    const expected = shiftIntoView(hidden.camera.viewport, focusBoxes(hidden).rects, narrow);
    // 前提: ずらしの量が 0 でない
    expect(differs(expected, hidden.camera.viewport)).toBe(true);
    story(
      update,
      given(hidden),
      toggleSide(true),
      model((m) => {
        expect(m.viewing).toEqual(INITIAL_VIEWING);
        expect(m.camera.viewport).toEqual(hidden.camera.viewport);
      }),
      message(Message.MeasuredMapSurface({ ...narrow, nodeHeights: {} })),
      model((m) => {
        expectViewport(m.camera.viewport, expected);
        expect(m.camera.pendingShift).toBe(false);
      }),
    );
  });

  it("隠している間も、項目を押せば選べて、ビューポートが押したノードへ寄る（sideHidden は選択の結果に影響せず、保たれる）", () => {
    const snapshot = single();
    const start = measuredModel(snapshot, { sideHidden: true });
    story(
      update,
      given(start),
      clickChange("A"),
      model((m) => {
        expect(m.viewing.sideHidden).toBe(true);
        expect(m.viewing.selection).toEqual({ id: "A", byKey: false });
        expectViewport(m.camera.viewport, focusedOn(m, "A", start.camera.viewport.zoom));
        expect(differs(m.camera.viewport, start.camera.viewport)).toBe(true);
      }),
    );
  });
});
