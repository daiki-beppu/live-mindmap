import { HashMap, Option, Schema } from "effect";
import { given, message, model, story } from "foldkit/story";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeEntry, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { displayedPositions, init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import {
  cameraFocus,
  changedFocus,
  clampUserZoom,
  fitViewport,
  focusViewport,
  nodeFocusViewport,
  nodeRect,
  overviewViewport,
  panViewport,
  revealViewport,
  screenPoint,
  shiftIntoView,
  subtreeViewport,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  zoomAroundCenter,
  type Rect,
  type Viewport,
} from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { layout, NODE_WIDTH } from "../src/layout.ts";
import { humanSetsOf, type ViewingState, type ViewKey } from "../src/viewing.ts";

// マップの表示面のカメラ（Issue #819）の Story。update に Message を流し、そのたびの Model の viewport と viewing を見る。
// 反映で寄せる・人が動かすと止まる・全体を見て戻る・開閉で位置を保つ・列を出してずらす、を update の中の関数の呼び順として確かめる。
// 期待する viewport は、camera.ts の純粋な関数を直接呼んだ値（目標の位置と高さで測る。補間中の位置で測るのは、今の議題が無いときの収め直しだけ）。
// 同じ Model に Message を続けて流し、その途中の Model を観測する（条件だけ変えた別の Model を作り直して比べない）

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題", extra: Partial<SnapshotNode> = {}): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [], ...extra });
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 1, changes: [], remarks: [], ...extra });

// 会議 root > 議題 A（論点 A1・A2）・議題 B（論点 B1・B2・B3）。済みも古いものも無いので、畳まれるノードは無い。今の議題は A
const baseNodes = (): SnapshotNode[] => [
  node("root", null, "会議"),
  node("A", "root"),
  node("A1", "A", "論点"),
  node("A2", "A", "論点"),
  node("B", "root"),
  node("B1", "B", "論点"),
  node("B2", "B", "論点"),
  node("B3", "B", "論点"),
];
const tree = (extra: Partial<Snapshot> = {}): Snapshot => snap(baseNodes(), { currentTopic: "A", ...extra });
const change = (nodeId: string, round: number): ChangeEntry => ({ change: "追加", node: nodeId, kind: "論点", text: nodeId, round, at: round }) as ChangeEntry;
// 今の議題は A のまま、round の反映で ids が変わった。lastChanged は ids の最後
const withChanges = (ids: string[], round = 2, extra: Partial<Snapshot> = {}): Snapshot =>
  snap(baseNodes(), { round, currentTopic: "A", changes: ids.map((id) => change(id, round)), lastChanged: ids.at(-1)!, ...extra });
// 今の議題の下に、変更の記録を残さずノードが 1 つ増えた反映（寄せ先の箱が変わる）
const withSilentNode = (extra: Partial<Snapshot> = {}): Snapshot => snap([...baseNodes(), node("A3", "A", "論点")], { round: 2, currentTopic: "A", ...extra });

// 済みの議題 A（論点 A1・A2）は畳まれ、話し中の今の議題 B は畳まれない。A を開くと B が下へ動く
const foldable = (extra: Partial<Snapshot> = {}): Snapshot =>
  snap(
    [node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点"), node("A2", "A", "論点"), node("B", "root"), node("B1", "B", "論点")],
    { currentTopic: "B", now: 100, ...extra },
  );

const HEIGHTS: Record<string, number> = { root: 40, A: 60, A1: 60, A2: 60, A3: 60, B: 60, B1: 60, B2: 60, B3: 60 };
const SIZE = { width: 600, height: 400 };
const SMALL = { width: 300, height: 200 };
const measure = (size = SIZE, nodeHeights: Record<string, number> = HEIGHTS) => Message.MeasuredMapSurface({ ...size, nodeHeights });

const settle = (snapshot: Snapshot, mode: MapSurfaceModel["mode"] = "live", size = SIZE): MapSurfaceModel => update(init(snapshot, mode, false), measure(size)).model;
type Msg = typeof Message.Type;
const run = (start: MapSurfaceModel, ...messages: Array<Msg>): MapSurfaceModel => messages.reduce((m, next) => update(m, next).model, start);

// --- 入力の Message ---
const wheel = (over: Partial<typeof Message.WheeledMapSurface.Type> = {}) =>
  Message.WheeledMapSurface({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0, x: 300, y: 200, ...over });
const scroll = wheel({ deltaX: 40, deltaY: 100 });
const tick = (deltaMs: number) => Message.TickedAnimationFrame({ deltaMs });
const mods = { metaKey: false, ctrlKey: false, altKey: false };
const key = (k: ViewKey, over: Partial<typeof mods> = {}) => Message.PressedViewKey({ key: k, ...mods, ...over });
const changed = (snapshot: Snapshot) => Message.ChangedSnapshot({ snapshot });
const clickFoldDot = (nodeId: string) => Message.ClickedFoldDot({ nodeId });
const clickNode = (nodeId: string) => Message.ClickedNodeButton({ nodeId, clientX: 0, clientY: 0 });

// --- 期待する値（純粋な関数を直接呼ぶ） ---
const heightsOf = (m: MapSurfaceModel): Record<string, number> => Object.fromEntries(HashMap.toEntries(m.nodeHeights));
const dimsOf = (m: MapSurfaceModel): Record<string, { height: number }> => Object.fromEntries(HashMap.toEntries(m.nodeHeights).map(([id, height]) => [id, { height }]));
const sizeOf = (m: MapSurfaceModel) => Option.getOrThrow(m.size);
const viewOf = (m: MapSurfaceModel) => {
  if (m.mode === "still") return null;
  const { opened, folded, unbundled } = humanSetsOf(m.viewing);
  return foldView(m.snapshot, opened, m.viewing.selection?.id ?? null, folded, unbundled);
};
const shownOf = (m: MapSurfaceModel): SnapshotNode[] => viewOf(m)?.nodes ?? m.snapshot.nodes;
const targetsOf = (m: MapSurfaceModel) => layout(shownOf(m), heightsOf(m));

// 今の議題へ寄せた位置。見せないノードは、それを隠している畳んだノードに置き換えて測る
const focusExpected = (m: MapSurfaceModel): Viewport => {
  const focus = cameraFocus(m.snapshot)!;
  const view = viewOf(m);
  const shownId = (id: string) => view?.shownAs[id] ?? id;
  const target = targetsOf(m);
  const dims = dimsOf(m);
  return focusViewport([...new Set(focus.ids.map(shownId))].map((id) => nodeRect(id, target, dims)), nodeRect(shownId(focus.center), target, dims), sizeOf(m));
};
// 最後の反映で変わったノードへ寄せた位置（下限は人の下限）。見せないノードは、見えている代わりのノードに置き換えて測る
const changedExpected = (m: MapSurfaceModel): Viewport => {
  const focus = changedFocus(m.snapshot, viewOf(m)?.shownAs ?? {})!;
  const target = targetsOf(m);
  const dims = dimsOf(m);
  return focusViewport(focus.ids.map((id) => nodeRect(id, target, dims)), nodeRect(focus.center, target, dims), sizeOf(m), USER_MIN_ZOOM);
};
// 全体を収めた位置。測れたノードだけを、positions の位置で収める（still は下限 0.02、ふだんは 0.5）
const fitExpected = (m: MapSurfaceModel, positions: Record<string, { x: number; y: number }> = targetsOf(m)): Viewport => {
  const heights = heightsOf(m);
  const rects = shownOf(m)
    .filter((n) => heights[n.id] !== undefined)
    .map((n): Rect => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  return fitViewport(rects, sizeOf(m), m.mode === "still" ? 0.02 : 0.5, USER_MAX_ZOOM)!;
};
const overviewExpected = (m: MapSurfaceModel): Viewport => overviewViewport(shownOf(m).map((n) => n.id), targetsOf(m), dimsOf(m), sizeOf(m))!;

const expectViewport = (actual: Viewport, expected: Viewport) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 6);
};
const expectDifferent = (a: Viewport, b: Viewport) => expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.zoom - b.zoom)).toBeGreaterThan(1e-3);
const manualAt = (topic: string | undefined): ViewingState => ({ mode: "manual", topic });

describe("カメラの Model: 欄の初期値と本物の Schema", () => {
  it("初期は viewport (0, 0, 倍率 1)。出来事の履歴で決まる事実は「無い」（Option の None・false）で、idleStamp は有限の数", () => {
    const m = init(tree(), "live", false);
    expect(m.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(Option.isNone(m.placedRound)).toBe(true);
    expect(Option.isNone(m.keepAnchor)).toBe(true);
    expect(m.pendingShift).toBe(false);
    expect(Number.isFinite(m.idleStamp)).toBe(true);
  });

  it("「無い」を null で書いたカメラの欄・形の違う欄は通らず、値を持つ欄は通る", () => {
    const is = Schema.is(Model);
    const m = init(tree(), "live", false);
    expect(is(m)).toBe(true);
    expect(is({ ...m, placedRound: Option.some(2), keepAnchor: Option.some({ id: "A", point: { x: 3, y: 4 } }), pendingShift: true })).toBe(true);
    expect(is({ ...m, placedRound: null })).toBe(false);
    expect(is({ ...m, keepAnchor: null })).toBe(false);
    expect(is({ ...m, keepAnchor: Option.some({ id: "A", point: { x: "3", y: 4 } }) })).toBe(false);
    expect(is({ ...m, pendingShift: "yes" })).toBe(false);
  });
});

describe("反映で寄せる: 反映（round の変化）を見る状態へ渡す", () => {
  it("止めている（manual）間に、今の議題が変わる反映が来ると、自動に戻り、新しい今の議題へ寄る", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(scroll),
      model((m) => expect(m.viewing).toEqual(manualAt("A"))),
      message(changed(tree({ round: 2, currentTopic: "B", lastChanged: "B1" }))),
      model((m) => {
        expect(m.viewing).toEqual({ mode: "auto" });
        expect(m.snapshot.currentTopic).toBe("B");
        expectViewport(m.viewport, focusExpected(m));
        expectDifferent(m.viewport, start.viewport);
      }),
    );
  });

  it("止めている間に、同じ今の議題のままの反映が来ても、止めたまま（manual のまま）", () => {
    story(
      update,
      given(settle(tree())),
      message(scroll),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      model((m) => expect(m.viewing).toEqual(manualAt("A"))),
    );
  });

  it("round が変わらない Snapshot の差し替えは反映ではないので、今の議題が変わっても止めたまま", () => {
    story(
      update,
      given(settle(tree())),
      message(scroll),
      message(changed(tree({ currentTopic: "B" }))),
      model((m) => expect(m.viewing).toEqual(manualAt("A"))),
    );
  });

  it("選んでいたノードが反映で消えたら、選択が親（relocations の移り先）に替わる。木は反映の後の Snapshot で作る", () => {
    const withoutB2 = snap(
      baseNodes().filter((n) => n.id !== "B2"),
      { round: 2, currentTopic: "A" },
    );
    story(
      update,
      given(settle(tree())),
      message(clickNode("B2")),
      model((m) => expect(m.viewing.selection).toEqual({ id: "B2", byKey: false })),
      message(changed(withoutB2)),
      model((m) => expect(m.viewing.selection).toEqual({ id: "B", byKey: false })),
    );
  });

  it("止めている間でも、選んでいたノードが消えれば選択は移り先に替わる（止めたまま）", () => {
    const withoutB2 = snap(
      baseNodes().filter((n) => n.id !== "B2"),
      { round: 2, currentTopic: "A" },
    );
    story(
      update,
      given(settle(tree())),
      message(clickNode("B2")),
      message(scroll),
      message(changed(withoutB2)),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "B", byKey: false });
        expect(m.viewing.mode).toBe("manual");
      }),
    );
  });

  it("1 つの Message の中で、反映（選択の移し替え・自動に戻す）→ 寄せる の順に働き、寄せ先は反映の後の Snapshot と選択で決まる", () => {
    const withoutB2 = snap(
      baseNodes().filter((n) => n.id !== "B2"),
      { round: 2, currentTopic: "B", lastChanged: "B1" },
    );
    const start = settle(tree());
    story(
      update,
      given(start),
      message(clickNode("B2")),
      message(scroll),
      message(changed(withoutB2)),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "B", byKey: false });
        expect(m.viewing.mode).toBe("auto");
        expectViewport(m.viewport, focusExpected(m));
        expectDifferent(m.viewport, start.viewport);
      }),
    );
  });
});

describe("反映で寄せる: 自動のとき今の議題へ寄せる・今の議題が無ければ全体を収める", () => {
  it("測ると、今の議題（と祖先・子孫）を、倍率 0.75〜1.1 で画面に収める位置になる。全体を収めた位置とは違う", () => {
    const m = settle(tree());
    expect(m.viewing).toEqual({ mode: "auto" });
    expectViewport(m.viewport, focusExpected(m));
    expectDifferent(m.viewport, fitExpected(m));
  });

  it("変化の付いた反映（lastChanged あり）で今の議題が変わると、新しい今の議題へ寄る（目標の位置で測る）", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(changed(tree({ round: 2, currentTopic: "B", lastChanged: "B3" }))),
      model((m) => {
        expectViewport(m.viewport, focusExpected(m));
        expectDifferent(m.viewport, start.viewport);
        expect(m.viewing).toEqual({ mode: "auto" });
      }),
    );
  });

  it("変化の無い反映（lastChanged も、その round の変更も無い）では、寄せ直さない。変化の付く反映では、同じ構成でも寄せ直す", () => {
    const start = settle(tree());
    // 今の議題の下にノードが増えているので、寄せ直せば寄せ先は変わる（変わらないことで、寄せ直していないと分かる）
    const quiet = update(start, changed(withSilentNode())).model;
    expect(quiet.viewport).toEqual(start.viewport);
    const noisy = update(start, changed(withSilentNode({ lastChanged: "A3" }))).model;
    expectViewport(noisy.viewport, focusExpected(noisy));
    expectDifferent(noisy.viewport, start.viewport);
  });

  it("その round の変更の記録が付いた反映でも寄せ直す", () => {
    const start = settle(tree());
    const m = update(start, changed(withSilentNode({ changes: [{ change: "追加", node: "A3", kind: "論点", text: "A3", round: 2, at: 0 } as Snapshot["changes"][number]] }))).model;
    expectViewport(m.viewport, focusExpected(m));
    expectDifferent(m.viewport, start.viewport);
  });

  it("同じ round の測り直し（実寸が届いた）では、変化が無くても寄せ直す", () => {
    const start = settle(tree());
    const m = update(start, measure(SIZE, { A: 200 })).model;
    expect(heightsOf(m)["A"]).toBe(200);
    expectViewport(m.viewport, focusExpected(m));
    expectDifferent(m.viewport, start.viewport);
  });

  it("寄せ先の箱は、畳まれて見えないノードを、それを隠している畳んだノードに置き換えて測る（位置の無い ID を原点で測らない）", () => {
    // 今の議題 B の子の議題 C（済み）は畳まれ、C1 は隠れる。C1 は寄せ先の子孫に入るが、見せているのは C
    const snapshot = snap(
      [node("root", null, "会議"), node("A", "root"), node("B", "root"), node("B1", "B", "論点"), node("C", "B", "議題", { talkStatus: "済み" }), node("C1", "C", "論点")],
      { currentTopic: "B", now: 100 },
    );
    const m = update(init(snapshot, "live", false), measure(SIZE, { root: 40, A: 60, B: 60, B1: 60, C: 60, C1: 60 })).model;
    const view = viewOf(m)!;
    expect(view.shownAs["C1"]).toBe("C");
    expect(cameraFocus(m.snapshot)!.ids).toContain("C1");
    expectViewport(m.viewport, focusExpected(m));
  });

  it("今の議題が無い反映では、全体を収める（ふだんは下限 0.5）。今の議題が戻った反映は、変化が無くても寄せる", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(changed(snap(baseNodes(), { round: 2 }))),
      model((m) => {
        expectViewport(m.viewport, fitExpected(m));
        expect(m.viewing).toEqual({ mode: "auto" });
      }),
      message(changed(tree({ round: 3 }))),
      model((m) => expectViewport(m.viewport, focusExpected(m))),
    );
  });

  it("撮影（still）は今の議題があっても全体を収め、下限は 0.02（大きなマップも収める）", () => {
    const m = settle(tree(), "still", SMALL);
    expectViewport(m.viewport, fitExpected(m));
    expect(m.viewport.zoom).toBeLessThan(0.5);
    expect(m.viewing).toEqual({ mode: "auto" });
  });

  it("今の議題が無いとき、ふだん（live）の全体の収め方は倍率 0.5 で止まる", () => {
    const m = settle(snap(baseNodes()), "live", SMALL);
    expect(m.viewport.zoom).toBe(0.5);
    expectViewport(m.viewport, fitExpected(m));
  });

  it("今の議題が無いと、補間のフレームごとに、そのときの（補間中の）位置で全体を収め直し、補間が終わると目標の位置で収める", () => {
    const start = settle(snap(baseNodes()));
    story(
      update,
      given(start),
      message(changed(snap([...baseNodes(), node("A3", "A", "論点")], { round: 2 }))),
      model((m) => {
        expect(Option.isSome(m.motion)).toBe(true);
        // この入力は、補間中の位置で収めた値が、目標の位置で収めた値と違うものでなければ検証にならない
        expectDifferent(fitExpected(m, displayedPositions(m)), fitExpected(m));
        expectViewport(m.viewport, fitExpected(m, displayedPositions(m)));
      }),
      message(tick(100)),
      model((m) => expectViewport(m.viewport, fitExpected(m, displayedPositions(m)))),
      message(tick(150)),
      model((m) => expectViewport(m.viewport, fitExpected(m, displayedPositions(m)))),
      message(tick(500)),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        expectViewport(m.viewport, fitExpected(m));
      }),
    );
  });

  it("今の議題があるときは、補間のフレームでは動かさない（寄せ先は目標の位置で測るので変わらない）", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      model((m) => expect(Option.isSome(m.motion)).toBe(true)),
      message(tick(100)),
      model((m) => expectViewport(m.viewport, focusExpected(m))),
    );
  });
});

describe("人が動かすと止まる: パン・ズームで見る状態の userMoved を渡す", () => {
  const press = Message.PressedMapSurface({ clientX: 100, clientY: 100, button: 0, ctrlKey: false, insideNoPan: false });
  const POINT = { x: 300, y: 200 };
  const moves: ReadonlyArray<readonly [string, ReadonlyArray<Msg>]> = [
    ["二本指スクロール", [scroll]],
    ["⌘/Ctrl＋Shift＋スクロール（軸固定）", [wheel({ deltaX: 30, deltaY: 5, shiftKey: true, metaKey: true, timeStamp: 1000 })]],
    ["Ctrl＋ホイール（ピンチ）", [wheel({ ctrlKey: true, deltaY: -100, ...POINT })]],
    ["⌘＋クリック", [Message.ClickedMapSurfaceWithModifier({ ...POINT, ctrlKey: false, metaKey: true, altKey: false })]],
    ["Safari の gesture", [Message.StartedMapSurfaceGesture(), Message.ChangedMapSurfaceGesture({ scale: 1.3, ...POINT })]],
    ["空いたところのドラッグ", [press, Message.MovedPointer({ clientX: 130, clientY: 90, buttons: 1 })]],
  ];

  it.each(moves)("%s: 見る状態が manual（今の議題を覚える）になり、続く同じ今の議題の反映・実測・補間では viewport を動かさない", (_name, inputs) => {
    const start = settle(tree());
    const moved = run(start, ...inputs);
    expect(moved.viewing).toEqual(manualAt("A"));
    expectDifferent(moved.viewport, start.viewport);
    // 今の議題の下にノードが増えた反映と、実寸の変化で、自動のままなら寄せ先が変わる
    story(
      update,
      given(moved),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      model((m) => {
        expect(m.viewport).toEqual(moved.viewport);
        expect(m.viewing).toEqual(manualAt("A"));
      }),
      message(measure(SIZE, { A: 200, A1: 120 })),
      model((m) => expect(m.viewport).toEqual(moved.viewport)),
      message(tick(100)),
      model((m) => expect(m.viewport).toEqual(moved.viewport)),
    );
  });

  it("押しただけ（動かしていない）では、自動のカメラを止めない", () => {
    story(
      update,
      given(settle(tree())),
      message(press),
      model((m) => expect(m.viewing).toEqual({ mode: "auto" })),
    );
  });

  it("still は人のパン・ズームを受けず、見る状態も変えない", () => {
    const start = settle(tree(), "still");
    const m = run(start, scroll, wheel({ ctrlKey: true, deltaY: -100, ...POINT }), press, Message.MovedPointer({ clientX: 130, clientY: 90, buttons: 1 }));
    expect(m.viewport).toEqual(start.viewport);
    expect(m.viewing).toEqual({ mode: "auto" });
  });

  it("全体を見ていて 0.5 未満の倍率から動かすと、人の倍率の範囲（0.5）に収めてから manual になる", () => {
    const overview = run(settle(tree(), "live", SMALL), key("F"));
    expect(overview.viewport.zoom).toBeLessThan(0.5);
    story(
      update,
      given(overview),
      message(scroll),
      model((m) => {
        expect(m.viewing).toEqual(manualAt("A"));
        expect(m.viewport.zoom).toBeCloseTo(0.5, 9);
      }),
    );
  });

  it("0.5 以上の倍率からは、倍率を変えない（スクロールは平行移動だけ）", () => {
    const start = settle(tree());
    const m = update(start, scroll).model;
    expect(m.viewport.zoom).toBe(start.viewport.zoom);
    expect(m.viewport.x).toBeCloseTo(start.viewport.x - 20, 9);
    expect(m.viewport.y).toBeCloseTo(start.viewport.y - 50, 9);
  });
});

describe("全体を見て、もう一度で変わったところへ寄る", () => {
  // 今の議題 A の外（B1）が最後の反映で変わった。自動のカメラは A に寄るので、B1 は寄せ先に入らない
  const outside = () => settle(withChanges(["B1"]));

  it("止めている位置から F を押すと、全体を目標の位置で収めた viewport になり（見る状態は overview）、もう一度 F で、変わったノードへ寄る viewport になって diff になる（止めていた位置へは戻らない）", () => {
    const start = outside();
    story(
      update,
      given(start),
      message(scroll),
      model((m) => expect(m.viewing).toEqual(manualAt("A"))),
      message(key("F")),
      model((m) => {
        expect(m.viewing.mode).toBe("overview");
        expectViewport(m.viewport, overviewExpected(m));
      }),
      message(key("F")),
      model((m) => {
        expect(m.viewing).toEqual({ mode: "diff", topic: "A" });
        expectViewport(m.viewport, changedExpected(m));
        // 止めていた位置でも、自動のカメラが寄る今の議題でもない
        expectDifferent(m.viewport, update(start, scroll).model.viewport);
        expectDifferent(m.viewport, focusExpected(m));
      }),
    );
  });

  it("自動から F・F でも同じ。diff になり、変わったノード（議題の外の B1）へ寄る", () => {
    story(
      update,
      given(outside()),
      message(key("F")),
      model((m) => expect(m.viewing.mode).toBe("overview")),
      message(key("F")),
      model((m) => {
        expect(m.viewing).toEqual({ mode: "diff", topic: "A" });
        expectViewport(m.viewport, changedExpected(m));
        expectDifferent(m.viewport, focusExpected(m));
      }),
    );
  });

  it("寄せ先は最後の反映で変わったノード全部。議題の外（B1）と中（A1）の両方が画面に入る", () => {
    const m = run(settle(withChanges(["A1", "B1"])), key("F"), key("F"));
    const target = targetsOf(m);
    const dims = dimsOf(m);
    expect(m.viewing).toEqual({ mode: "diff", topic: "A" });
    for (const id of ["A1", "B1"]) {
      const r = nodeRect(id, target, dims);
      const left = r.x * m.viewport.zoom + m.viewport.x;
      const top = r.y * m.viewport.zoom + m.viewport.y;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + r.width * m.viewport.zoom).toBeLessThanOrEqual(SIZE.width);
      expect(top + r.height * m.viewport.zoom).toBeLessThanOrEqual(SIZE.height);
    }
  });

  it("人の下限 0.5 でも収まらないとき、倍率は 0.5 で、最後に変わったノード（lastChanged）が画面の中央に来る", () => {
    const m = run(settle(withChanges(["A1", "B3"]), "live", SMALL), key("F"), key("F"));
    const b3 = nodeRect("B3", targetsOf(m), dimsOf(m));
    expect(m.viewing).toEqual({ mode: "diff", topic: "A" });
    expect(m.viewport.zoom).toBeCloseTo(USER_MIN_ZOOM, 6);
    const at = screenPoint(m.viewport, { x: b3.x + b3.width / 2, y: b3.y + b3.height / 2 });
    expect(at.x).toBeCloseTo(SMALL.width / 2, 6);
    expect(at.y).toBeCloseTo(SMALL.height / 2, 6);
  });

  it("変わったノードが畳みで隠れているとき、畳みを解かず、見えている祖先（済みの議題 A）に寄る", () => {
    const folded = foldable({ round: 2, changes: [change("A1", 2)], lastChanged: "A1" });
    const m = run(settle(folded), key("F"), key("F"));
    const view = viewOf(m)!;
    expect(view.nodes.map((n) => n.id)).not.toContain("A1");
    expect(m.viewing).toEqual({ mode: "diff", topic: "B" });
    expect(humanSetsOf(m.viewing).opened.size).toBe(0);
    const a = nodeRect("A", targetsOf(m), dimsOf(m));
    expectViewport(m.viewport, focusViewport([a], a, sizeOf(m), USER_MIN_ZOOM));
  });

  it("最後の反映で変わったノードが無いときの F・F は、自動に戻り、今の議題へ寄せ直す。止めていても同じ", () => {
    const quiet = settle(tree());
    for (const start of [quiet, update(quiet, scroll).model]) {
      const m = run(start, key("F"), key("F"));
      expect(m.viewing).toEqual({ mode: "auto" });
      expectViewport(m.viewport, focusExpected(m));
    }
  });

  it("何もしない反映の後（最後の反映で変わったノードが無い）も、F・F は自動に戻る。前の反映の変化は寄せ先にならない", () => {
    const afterQuiet = run(outside(), changed(withChanges(["B1"], 2, { round: 3, changes: [change("B1", 2)] })));
    const m = run(afterQuiet, key("F"), key("F"));
    expect(m.viewing).toEqual({ mode: "auto" });
    expectViewport(m.viewport, focusExpected(m));
  });

  it("自動から F・F で戻る前に、変化の無い反映が届いても、自動に戻り、今の議題へ寄せ直す（全体を見ている間の反映を含めた今の寄せ先）", () => {
    story(
      update,
      given(settle(tree())),
      message(key("F")),
      model((m) => expect(m.viewing.mode).toBe("overview")),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      message(key("F")),
      model((m) => {
        expect(m.viewing).toEqual({ mode: "auto" });
        expectViewport(m.viewport, focusExpected(m));
      }),
    );
  });

  it("全体を見ている間は、反映のたびに、全体を目標の位置で収め直す（同じ今の議題の反映でも overview のまま）", () => {
    const start = run(settle(tree()), key("F"));
    story(
      update,
      given(start),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      model((m) => {
        expect(m.viewing.mode).toBe("overview");
        expectViewport(m.viewport, overviewExpected(m));
        expectDifferent(m.viewport, start.viewport);
      }),
    );
  });

  it("全体を見ている間は、実測（ノードの高さ・画面の大きさ）が届くたびに収め直す", () => {
    const start = run(settle(tree()), key("F"));
    story(
      update,
      given(start),
      message(measure(SIZE, { B: 400 })),
      model((m) => {
        expectViewport(m.viewport, overviewExpected(m));
        expectDifferent(m.viewport, start.viewport);
      }),
      message(measure({ width: 900, height: 500 }, {})),
      model((m) => expectViewport(m.viewport, overviewExpected(m))),
    );
  });

  it("全体を見ている間に、人が動かすと manual になる（動かすだけで viewport は変わらない）", () => {
    story(
      update,
      given(settle(tree())),
      message(scroll),
      message(key("F")),
      message(wheel({ deltaX: 10, deltaY: 10 })),
      model((m) => expect(m.viewing).toEqual(manualAt("A"))),
    );
  });
});

describe("差分を見ている間のカメラ", () => {
  const inDiff = () => run(settle(withChanges(["B1"])), key("F"), key("F"));

  it("F で全体を見る（overview）。目標の位置で全体を収めた viewport になる", () => {
    const m = run(inDiff(), key("F"));
    expect(m.viewing).toEqual({ mode: "overview", topic: "A" });
    expectViewport(m.viewport, overviewExpected(m));
  });

  it("Esc で自動に戻り、今の議題へ寄る", () => {
    const m = update(inDiff(), Message.PressedEscapeKey({ ...mods })).model;
    expect(m.viewing).toEqual({ mode: "auto" });
    expectViewport(m.viewport, focusExpected(m));
  });

  it("人が動かすと manual になる。スクロールで viewport は動かした分だけ動く", () => {
    const start = inDiff();
    const m = update(start, scroll).model;
    expect(m.viewing).toEqual(manualAt("A"));
    expect(m.viewport.zoom).toBe(start.viewport.zoom);
    expect(m.viewport.x).toBeCloseTo(start.viewport.x - 20, 9);
    expect(m.viewport.y).toBeCloseTo(start.viewport.y - 50, 9);
  });

  it("今の議題が同じ反映で変化があれば、新しい反映で変わったノード全部へ寄り直す（diff のまま）", () => {
    const start = inDiff();
    const next = snap(baseNodes(), { round: 3, currentTopic: "A", changes: [change("B1", 2), change("A1", 3), change("B3", 3)], lastChanged: "B3" });
    const m = update(start, changed(next)).model;
    expect(m.viewing).toEqual({ mode: "diff", topic: "A" });
    expectViewport(m.viewport, changedExpected(m));
    expectDifferent(m.viewport, start.viewport);
    // 前の反映の変化（B1）ではなく、新しい反映の変化（A1・B3）で決まる
    expect(changedFocus(m.snapshot, {})!.ids.sort()).toEqual(["A1", "B3"]);
  });

  it("今の議題が同じで変化の無い反映は、動かさない（viewport も見る状態もそのまま）。何度届いても", () => {
    const start = inDiff();
    const quiet = snap(baseNodes(), { round: 3, currentTopic: "A", changes: [change("B1", 2)] });
    const once = update(start, changed(quiet)).model;
    expect(once.viewing).toEqual({ mode: "diff", topic: "A" });
    expect(once.viewport).toEqual(start.viewport);
    const twice = update(once, changed({ ...quiet, round: 4 })).model;
    expect(twice.viewing).toEqual({ mode: "diff", topic: "A" });
    expect(twice.viewport).toEqual(start.viewport);
  });

  it("今の議題が変わる反映は、自動に戻り、新しい今の議題へ寄る", () => {
    const next = snap(baseNodes(), { round: 3, currentTopic: "B", changes: [change("B2", 3)], lastChanged: "B2" });
    const m = update(inDiff(), changed(next)).model;
    expect(m.viewing).toEqual({ mode: "auto" });
    expectViewport(m.viewport, focusExpected(m));
  });

  it("実測（ノードの高さ・画面の大きさ）が届くたびに、変わったノードへ寄せ直す", () => {
    const start = inDiff();
    const m = update(start, measure(SMALL, { B1: 200 })).model;
    expect(m.viewing).toEqual({ mode: "diff", topic: "A" });
    expectViewport(m.viewport, changedExpected(m));
    expectDifferent(m.viewport, start.viewport);
  });
});

describe("開閉で位置を保つ: 開閉したノードを同じ画面座標に映し続ける", () => {
  // 開いた A の画面座標。補間中の表示位置で測る
  const anchorOf = (m: MapSurfaceModel) => screenPoint(m.viewport, displayedPositions(m)["A"]!);
  const expectPointAt = (m: MapSurfaceModel, point: { x: number; y: number }) => {
    const at = anchorOf(m);
    expect(at.x).toBeCloseTo(point.x, 6);
    expect(at.y).toBeCloseTo(point.y, 6);
  };
  // 止めている状態で A の丸を押した直後（補間の経過 0）。押す前の A の画面座標も返す
  const opened = (start = run(settle(foldable()), scroll)) => {
    const point = anchorOf(start);
    return { start, point, afterClick: update(start, clickFoldDot("A")).model };
  };

  it("止めている間に丸を押すと、開いたノードは補間の途中も終わりも、押す前と同じ画面座標に映る（倍率は変えない）", () => {
    const { start, point, afterClick } = opened();
    expect(afterClick.viewing.humanOpened).toEqual(new Set(["A"]));
    // この入力は、補間で A が動くものでなければ検証にならない
    expectDifferent({ ...targetsOf(afterClick)["A"]!, zoom: 1 }, { ...displayedPositions(afterClick)["A"]!, zoom: 1 });
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      model((m) => expectPointAt(m, point)),
      message(tick(100)),
      model((m) => expectPointAt(m, point)),
      message(tick(150)),
      model((m) => expectPointAt(m, point)),
      message(tick(250)),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        expectPointAt(m, point);
        expect(m.viewport.zoom).toBe(start.viewport.zoom);
        expect(m.viewing.mode).toBe("manual");
      }),
    );
    const mid = run(afterClick, tick(250));
    expectDifferent(mid.viewport, afterClick.viewport);
  });

  it("開いて新しく見えたノードの実寸が届いて配置が動いても、開いたノードを同じ画面座標に合わせ直す", () => {
    const { start, point } = opened();
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      message(tick(100)),
      message(measure(SIZE, { A1: 160, A2: 90 })),
      model((m) => expectPointAt(m, point)),
      message(tick(500)),
      model((m) => expectPointAt(m, point)),
    );
  });

  it("人が動かすと保持が外れ、以後の補間では viewport を動かさない", () => {
    const { afterClick } = opened();
    const moved = update(afterClick, wheel({ deltaX: 20, deltaY: 20 })).model;
    const after = update(moved, tick(100)).model;
    expectDifferent({ ...displayedPositions(after)["A"]!, zoom: 1 }, { ...displayedPositions(moved)["A"]!, zoom: 1 });
    expect(after.viewport).toEqual(moved.viewport);
  });

  it("次のキーの指示でも保持が外れる", () => {
    const { afterClick } = opened();
    const zoomed = update(afterClick, key("=")).model;
    const after = update(zoomed, tick(100)).model;
    expect(after.viewport).toEqual(zoomed.viewport);
  });

  it("全体を見ている間の開閉も位置を保つ。保っている間は全体を収め直さず、倍率も変えない", () => {
    const start = run(settle(foldable()), key("F"));
    const point = anchorOf(start);
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      model((m) => {
        expect(m.viewing.mode).toBe("overview");
        expectPointAt(m, point);
      }),
      message(tick(100)),
      model((m) => expectPointAt(m, point)),
      message(measure(SIZE, { A1: 160 })),
      message(tick(500)),
      model((m) => {
        expectPointAt(m, point);
        expect(m.viewport.zoom).toBe(start.viewport.zoom);
      }),
    );
  });

  it("自動のときの開閉は位置を保たず、今の議題へ寄せ直す（開いた後の目標の位置で測る）", () => {
    const start = settle(foldable());
    expectViewport(start.viewport, focusExpected(start));
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      model((m) => {
        expect(m.viewing.mode).toBe("auto");
        expectViewport(m.viewport, focusExpected(m));
        expectDifferent(m.viewport, start.viewport);
      }),
    );
  });
});

describe("列を出してずらす: E で保留を立て、画面の幅が変わったとき、今の議題が切れる分だけずらす", () => {
  const WIDE = { width: 600, height: 400 };
  const NARROW = { width: 500, height: 400 };
  // 今の議題 A（A・A1・A2）の箱が、幅 600 では右に収まらない位置。列を隠している状態（E で出す側）
  const hiddenColumn = (viewing: ViewingState = { ...manualAt("A"), sideHidden: true }): MapSurfaceModel => ({
    ...settle(tree()),
    viewport: { x: 100, y: 0, zoom: 1 },
    viewing,
  });
  const side = () => Message.PressedSideKey({ ...mods });
  const focusRects = (m: MapSurfaceModel): Rect[] => {
    const focus = cameraFocus(m.snapshot)!;
    return [...new Set(focus.ids)].map((id) => nodeRect(id, targetsOf(m), dimsOf(m)));
  };

  it("列を出す（E）だけでは動かさない。幅が変わった測定で、列で切れる分だけ横にずれる（倍率・縦は変えない）", () => {
    const start = hiddenColumn();
    const expected = shiftIntoView(start.viewport, focusRects(start), NARROW);
    expectDifferent(expected, start.viewport);
    story(
      update,
      given(start),
      message(side()),
      model((m) => {
        expect(m.viewing.sideHidden).toBeUndefined();
        expect(m.viewport).toEqual(start.viewport);
      }),
      message(measure(NARROW, {})),
      model((m) => {
        expectViewport(m.viewport, expected);
        expect(m.viewport.zoom).toBe(start.viewport.zoom);
        expect(m.viewport.y).toBe(start.viewport.y);
      }),
    );
  });

  it("高さだけが変わった測定（同じ幅）では保留のまま。幅が変わった測定で、そのときの画面の大きさでずらす", () => {
    const start = hiddenColumn();
    const expected = shiftIntoView(start.viewport, focusRects(start), { width: 500, height: 300 });
    expectDifferent(expected, start.viewport);
    story(
      update,
      given(start),
      message(side()),
      message(measure({ width: WIDE.width, height: 300 }, {})),
      model((m) => expect(m.viewport).toEqual(start.viewport)),
      message(measure({ width: 500, height: 300 }, {})),
      model((m) => expectViewport(m.viewport, expected)),
    );
  });

  it("ずらしは 1 回だけ。保留を使い切った後の幅の変化ではずらさない", () => {
    const start = hiddenColumn();
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => {
        const after = update(m, measure({ width: 480, height: 400 }, {})).model;
        expect(after.viewport).toEqual(m.viewport);
      }),
    );
  });

  it("列を隠したとき（sideHidden になる E）は、幅が変わってもずらさない。保留も残さない", () => {
    const start = hiddenColumn({ ...manualAt("A") });
    story(
      update,
      given(start),
      message(side()),
      model((m) => expect(m.viewing.sideHidden).toBe(true)),
      message(measure({ width: 700, height: 400 }, {})),
      model((m) => expect(m.viewport).toEqual(start.viewport)),
      message(measure(NARROW, {})),
      model((m) => expect(m.viewport).toEqual(start.viewport)),
    );
  });

  const atWidth = (m: MapSurfaceModel, size: { width: number; height: number }): MapSurfaceModel => ({ ...m, size: Option.some(size) });

  it("自動で列を出す（E）後の幅の測定は、寄せ直さず、E の前の viewport を列で切れる分だけずらす（倍率・縦は E の前のまま）", () => {
    const start = hiddenColumn({ mode: "auto", sideHidden: true });
    expect(Option.isSome(start.placedRound)).toBe(true);
    const expected = shiftIntoView(start.viewport, focusRects(start), NARROW);
    expectDifferent(expected, start.viewport);
    // 前提: 寄せ直すと別の viewport になる
    expectDifferent(focusExpected(atWidth(start, NARROW)), start.viewport);
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => {
        expect(m.viewing.mode).toBe("auto");
        expectViewport(m.viewport, expected);
        expect(m.viewport.zoom).toBe(start.viewport.zoom);
        expect(m.viewport.y).toBe(start.viewport.y);
      }),
    );
  });

  it("全体を見ている間に列を出す（E）後の幅の測定も、収め直さず、E の前の viewport をずらすだけ（overview のまま）", () => {
    const base = run(settle(tree()), key("F"));
    const start: MapSurfaceModel = { ...base, viewport: { x: 100, y: 0, zoom: 1 }, viewing: { ...base.viewing, sideHidden: true } };
    const expected = shiftIntoView(start.viewport, focusRects(start), NARROW);
    expectDifferent(expected, start.viewport);
    // 前提: 収め直すと別の viewport になる
    expectDifferent(overviewExpected(atWidth(start, NARROW)), start.viewport);
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => {
        expect(m.viewing.mode).toBe("overview");
        expectViewport(m.viewport, expected);
        expect(m.viewport.zoom).toBe(start.viewport.zoom);
        expect(m.viewport.y).toBe(start.viewport.y);
      }),
    );
  });

  it("自動でも全体を見ていても、列を隠す（E）後の幅の測定は viewport を変えず、保留も残さない", () => {
    const base = run(settle(tree()), key("F"));
    const starts: MapSurfaceModel[] = [hiddenColumn({ mode: "auto" }), { ...base, viewport: { x: 100, y: 0, zoom: 1 }, viewing: { ...base.viewing } }];
    const wide = { width: 700, height: 400 };
    expectDifferent(focusExpected(atWidth(starts[0]!, wide)), starts[0]!.viewport);
    expectDifferent(overviewExpected(atWidth(starts[1]!, wide)), starts[1]!.viewport);
    for (const start of starts) {
      story(
        update,
        given(start),
        message(side()),
        message(measure(wide, {})),
        model((m) => {
          expect(m.viewing.sideHidden).toBe(true);
          expect(m.viewport).toEqual(start.viewport);
          expect(m.pendingShift).toBe(false);
        }),
      );
    }
  });

  it("E は寄せ直しも収め直しもしない（自動でも全体を見ていても viewport はそのまま）", () => {
    const auto = { ...settle(tree()), viewport: { x: 5, y: 7, zoom: 1 } };
    expect(update(auto, side()).model.viewport).toEqual({ x: 5, y: 7, zoom: 1 });
    const overview = { ...run(settle(tree()), key("F")) };
    const kept = update({ ...overview, viewport: { x: 5, y: 7, zoom: 1 } }, side()).model;
    expect(kept.viewport).toEqual({ x: 5, y: 7, zoom: 1 });
    expect(kept.viewing.mode).toBe("overview");
  });

  it("E の後に別の指示（キーでのズーム）があると保留は消え、幅が変わってもずらさない", () => {
    const start = hiddenColumn();
    story(
      update,
      given(start),
      message(side()),
      message(key("=")),
      model((m) => {
        const after = update(m, measure(NARROW, {})).model;
        expect(after.viewport).toEqual(m.viewport);
      }),
    );
  });

  it("今の議題が無いときは、幅が変わってもずらさない", () => {
    const start = { ...hiddenColumn(), snapshot: snap(baseNodes()) };
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => expect(m.viewport).toEqual(start.viewport)),
    );
  });
});

describe("キーの指示: その場で適用する（seq を介さない）", () => {
  const start = settle(tree());
  const size = SIZE;

  const clamped = (cur: Viewport) => zoomAroundCenter(cur, clampUserZoom(cur.zoom), size);
  it.each<readonly [string, ViewKey, (cur: Viewport) => Viewport]>([
    ["=（1.25 倍）", "=", (cur) => zoomAroundCenter(cur, clampUserZoom(cur.zoom * 1.25), size)],
    ["-（1/1.25 倍）", "-", (cur) => zoomAroundCenter(cur, clampUserZoom(cur.zoom / 1.25), size)],
    ["0（倍率 1）", "0", (cur) => zoomAroundCenter(cur, clampUserZoom(1), size)],
    ["Shift＋→", "Shift+ArrowRight", (cur) => panViewport(clamped(cur), { dx: 1, dy: 0 }, size)],
    ["Shift＋←", "Shift+ArrowLeft", (cur) => panViewport(clamped(cur), { dx: -1, dy: 0 }, size)],
    ["Shift＋↑", "Shift+ArrowUp", (cur) => panViewport(clamped(cur), { dx: 0, dy: -1 }, size)],
    ["Shift＋↓", "Shift+ArrowDown", (cur) => panViewport(clamped(cur), { dx: 0, dy: 1 }, size)],
  ])("%s: 1 つの Message で viewport が camera.ts の値になり、見る状態は manual になる", (_name, pressed, expectedOf) => {
    const m = update(start, key(pressed)).model;
    expect(m.viewing).toEqual(manualAt("A"));
    expectViewport(m.viewport, expectedOf(start.viewport));
    expectDifferent(m.viewport, start.viewport);
  });

  it("Z: 選んだノードとその子孫が収まる位置へ寄る（fitSubtree）。選んでいなければ何も起きない", () => {
    const shown = shownOf(start);
    const expected = subtreeViewport("A", { ids: shown.map((n) => n.id), parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])) }, targetsOf(start), dimsOf(start), size);
    const selected = update(start, clickNode("A")).model;
    const m = update(selected, key("Z")).model;
    expect(m.viewing.mode).toBe("manual");
    expectViewport(m.viewport, expected);
    expectDifferent(m.viewport, selected.viewport);
    const none = update(start, key("Z")).model;
    expect(none.viewport).toEqual(start.viewport);
    expect(none.viewing).toEqual({ mode: "auto" });
  });

  it("矢印: 選択を移し、移り先が画面の外なら最小限ずらして入れる（revealNode）", () => {
    const offscreen = { ...update(start, clickNode("A")).model, viewport: { x: 200, y: 0, zoom: 1 } };
    const m = update(offscreen, Message.PressedArrowKey({ dir: "right", ...mods })).model;
    expect(m.viewing.selection).toEqual({ id: "A1", byKey: true });
    expect(m.viewing.mode).toBe("manual");
    const expected = revealViewport(zoomAroundCenter(offscreen.viewport, clampUserZoom(offscreen.viewport.zoom), size), nodeRect("A1", targetsOf(start), dimsOf(start)), size);
    expectViewport(m.viewport, expected);
    expectDifferent(m.viewport, offscreen.viewport);
  });

  it("全体を見ていて 0.5 未満の倍率から、キーのパン・矢印に移るときは、人の倍率の範囲（0.5）に収めてから動かす", () => {
    const overview = run(settle(tree(), "live", SMALL), key("F"));
    expect(overview.viewport.zoom).toBeLessThan(0.5);
    const panned = update(overview, key("Shift+ArrowRight")).model;
    expectViewport(panned.viewport, panViewport(zoomAroundCenter(overview.viewport, 0.5, SMALL), { dx: 1, dy: 0 }, SMALL));
    const selected = update(overview, clickNode("A")).model;
    const revealed = update(selected, Message.PressedArrowKey({ dir: "right", ...mods })).model;
    expect(revealed.viewport.zoom).toBeCloseTo(0.5, 9);
  });

  it("Esc: 止めた状態から自動に戻り、今の議題へ寄せ直す（refocus）", () => {
    const moved = update(start, scroll).model;
    const m = update(moved, Message.PressedEscapeKey({ ...mods })).model;
    expect(m.viewing).toEqual({ mode: "auto" });
    expectViewport(m.viewport, focusExpected(m));
    expectDifferent(m.viewport, moved.viewport);
  });

  it("修飾キー付き（⌘＋=）は何もしない", () => {
    const m = update(start, key("=", { metaKey: true })).model;
    expect(m.viewport).toEqual(start.viewport);
    expect(m.viewing).toEqual({ mode: "auto" });
  });

  it("still ではキーで動かさない", () => {
    const still = settle(tree(), "still");
    for (const input of [key("="), key("F"), key("Shift+ArrowRight"), Message.PressedEscapeKey({ ...mods })]) {
      const m = update(still, input).model;
      expect(m.viewport).toEqual(still.viewport);
      expect(m.viewing).toEqual({ mode: "auto" });
    }
  });

  it("live と見返し（review）のどちらでも同じように動く", () => {
    const review = settle(tree(), "review");
    expectViewport(update(review, key("=")).model.viewport, zoomAroundCenter(review.viewport, clampUserZoom(review.viewport.zoom * 1.25), size));
    expect(update(review, key("=")).model.viewing).toEqual(manualAt("A"));
  });
});

describe("縁の点を押したら寄る", () => {
  it("今の倍率のまま、目標の位置と高さで測ったノードの中心が画面の中央に来る（キーでズームした後の倍率を使う）", () => {
    const zoomed = run(settle(tree()), key("="));
    expect(zoomed.viewport.zoom).not.toBe(1);
    story(
      update,
      given(zoomed),
      message(Message.ClickedEdgeDot({ nodeId: "B3" })),
      model((m) => {
        expectViewport(m.viewport, nodeFocusViewport(nodeRect("B3", targetsOf(m), dimsOf(m)), zoomed.viewport.zoom, SIZE));
        expect(m.viewing).toEqual(manualAt("A"));
      }),
    );
  });

  it("消えたノードの点では動かさない", () => {
    const zoomed = run(settle(tree()), key("="));
    const m = update(zoomed, Message.ClickedEdgeDot({ nodeId: "gone" })).model;
    expect(m.viewport).toEqual(zoomed.viewport);
  });
});

describe("見返しで触らずに 10 秒たつと自動に戻る", () => {
  const idle = () => Message.ElapsedIdleTime();

  it("見返しの manual で時間が経つと、自動に戻り、今の議題へ寄せ直す", () => {
    const moved = run(settle(tree(), "review"), scroll);
    expect(moved.viewing).toEqual(manualAt("A"));
    story(
      update,
      given(moved),
      message(idle()),
      model((m) => {
        expect(m.viewing).toEqual({ mode: "auto" });
        expectViewport(m.viewport, focusExpected(m));
        expectDifferent(m.viewport, moved.viewport);
      }),
    );
  });

  it("ライブでは、時間が経っても止めたまま", () => {
    const moved = run(settle(tree(), "live"), scroll);
    const m = update(moved, idle()).model;
    expect(m.viewing).toEqual(manualAt("A"));
    expect(m.viewport).toEqual(moved.viewport);
  });

  it("見返しでも、自動のとき・全体を見ているときは変わらない", () => {
    const auto = settle(tree(), "review");
    expect(update(auto, idle()).model.viewing).toEqual({ mode: "auto" });
    expect(update(auto, idle()).model.viewport).toEqual(auto.viewport);
    const overview = run(auto, key("F"));
    expect(update(overview, idle()).model.viewing.mode).toBe("overview");
    expect(update(overview, idle()).model.viewport).toEqual(overview.viewport);
  });

  it("still は時間では何も起こさない", () => {
    const still = settle(tree(), "still");
    expect(update(still, idle()).model.viewport).toEqual(still.viewport);
  });

  it("見る状態を動かす出来事（スクロール・キー・丸）のたびに idleStamp が変わり（10 秒を計り直す）、E・選択では変わらない", () => {
    const start = settle(foldable(), "review");
    const stamp = (m: MapSurfaceModel) => m.idleStamp;
    const scrolled = update(start, scroll).model;
    expect(stamp(scrolled)).not.toBe(stamp(start));
    const scrolledAgain = update(scrolled, scroll).model;
    expect(stamp(scrolledAgain)).not.toBe(stamp(scrolled));
    const keyed = update(scrolledAgain, key("=")).model;
    expect(stamp(keyed)).not.toBe(stamp(scrolledAgain));
    const folded = update(keyed, clickFoldDot("A")).model;
    expect(stamp(folded)).not.toBe(stamp(keyed));
    expect(stamp(update(folded, Message.PressedSideKey({ ...mods })).model)).toBe(stamp(folded));
    expect(stamp(update(folded, clickNode("B")).model)).toBe(stamp(folded));
  });
});

describe("update は時刻を読まない", () => {
  afterEach(() => vi.restoreAllMocks());

  it("反映・パン・キー・時間の Message を流しても、Date.now・performance.now を呼ばない", () => {
    const dateNow = vi.spyOn(Date, "now");
    const perfNow = vi.spyOn(performance, "now");
    run(settle(tree(), "review"), scroll, key("F"), key("F"), changed(tree({ round: 2, currentTopic: "B", lastChanged: "B1" })), Message.ElapsedIdleTime(), tick(100), Message.PressedSideKey({ ...mods }));
    expect(dateNow).not.toHaveBeenCalled();
    expect(perfNow).not.toHaveBeenCalled();
  });
});
