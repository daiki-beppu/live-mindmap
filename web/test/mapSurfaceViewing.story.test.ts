import { HashMap, Option, Schema } from "effect";
import { expectNoOutMessage, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { displayedPositions, init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message, OutMessage } from "../src/app/mapSurface/message.ts";
import { initialCamera, nodeFocusViewport, nodeRect } from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { layout } from "../src/layout.ts";
import { INITIAL_VIEWING, ViewingState } from "../src/viewing.ts";
import { foldingActions } from "./foldingActions.ts";

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: Exclude<SnapshotNode["kind"], "補足"> = "議題", extra: Partial<Exclude<SnapshotNode, { kind: "補足" }>> = {}): Exclude<SnapshotNode, { kind: "補足" }> => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [], ...extra });
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 3, changes: [], remarks: [], ...extra });

const single = (): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("B", "root", "議題")], { currentTopic: "B", now: 100 });
const bundled = (): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("A2", "root", "議題", { talkStatus: "済み" }), node("B", "root", "議題")], {
    currentTopic: "B",
    now: 100,
  });
const HEIGHTS = { root: 40, A: 50, A1: 60, A2: 50, B: 70, "run:A": 50 };
const openedA = () => foldingActions(single(), [{ type: "toggle", id: "A" }]).human;
const shownView = (m: MapSurfaceModel) => foldView(m.snapshot, Option.getOrUndefined(m.viewing.humanFolds), Option.getOrNull(Option.map(m.viewing.selection, (selection) => selection.id)));

const measuredModel = (snapshot: Snapshot, mode: MapSurfaceModel["mode"] = "live", viewing: ViewingState = INITIAL_VIEWING, camera: Pick<MapSurfaceModel["camera"], "mode" | "topic"> = { mode: "auto", topic: undefined }): MapSurfaceModel => ({
  ...init(snapshot, mode, false),
  size: Option.some({ width: 800, height: 600 }),
  cssNodeHeights: HashMap.make(...Object.entries(HEIGHTS)),
  viewing,
  camera: { ...initialCamera(), ...camera },
});
const clickNode = (nodeId: string) => message(Message.ClickedNodeButton({ nodeId, clientX: 0, clientY: 0 }));
const clickFoldDot = (nodeId: string) => message(Message.ClickedFoldDot({ nodeId }));
const clickEdgeDot = (nodeId: string) => message(Message.ClickedEdgeDot({ nodeId }));
const tick = (deltaMs: number) => message(Message.TickedAnimationFrame({ deltaMs }));
const positionsOf = (m: MapSurfaceModel) => displayedPositions(m);

describe("ViewingState の Schema（Schema.declare で素通しにしない）", () => {
  const is = Schema.is(ViewingState);

  it("選択・人の開閉・列の出し入れを持つ見る状態は通る", () => {
    expect(is({ sideHidden: true, selection: Option.some({ id: "A", byKey: true }), humanFolds: Option.fromUndefinedOr(openedA()) })).toBe(true);
    expect(is({ sideHidden: false, selection: Option.none(), humanFolds: Option.none() })).toBe(true);
    expect(is(INITIAL_VIEWING)).toBe(true);
  });

  it("集合を配列で書いたもの・形の崩れた選択は通らない", () => {
    expect(is({ ...INITIAL_VIEWING, humanFolds: Option.some(["A"]) })).toBe(false);
    expect(is({ ...INITIAL_VIEWING, humanFolds: Option.some(1) })).toBe(false);
    expect(is({ ...INITIAL_VIEWING, selection: Option.some({ id: "A" }) })).toBe(false);
    expect(is({ ...INITIAL_VIEWING, selection: Option.some({ id: 1, byKey: false }) })).toBe(false);
  });
});

describe("mapSurface の Model: 見る状態の欄", () => {
  it("init は INITIAL_VIEWING（自動のカメラ・選択なし・人の開閉なし）で始まる", () => {
    expect(init(single(), "live", false).viewing).toEqual({ sideHidden: false, selection: Option.none(), humanFolds: Option.none() });
    expect(init(single(), "still", false).viewing).toEqual(INITIAL_VIEWING);
  });

  it("本物の見る状態を持つ Model は通り、集合を配列で書いた viewing は通らない", () => {
    const is = Schema.is(Model);
    const viewing: ViewingState = { ...INITIAL_VIEWING, selection: Option.some({ id: "A", byKey: false }), humanFolds: Option.fromUndefinedOr(openedA()) };
    expect(is({ ...init(single(), "live", false), viewing })).toBe(true);
    expect(is({ ...init(single(), "live", false), viewing: { humanFolds: ["A"] } })).toBe(false);
    expect(is({ ...init(single(), "live", false), viewing: null })).toBe(false);
  });
});

describe("mapSurface の update: ノード本体の click で選ぶ（reduceViewing の select）", () => {
  it("click すると viewing が select の結果（選択が id・byKey は false）になり、SelectedNode も出る", () => {
    story(
      update,
      given(measuredModel(single())),
      clickNode("B"),
      model((m) => {
        expect(m.viewing).toEqual({ ...INITIAL_VIEWING, selection: Option.some({ id: "B", byKey: false }) });
        expect(m.camera.mode).toBe("auto");
      }),
      expectOutMessage(OutMessage.SelectedNode({ nodeId: "B" })),
    );
  });

  it("別のノードを click すると選択が移る。人の開閉などの他の状態はそのまま残る", () => {
    const before: ViewingState = { ...INITIAL_VIEWING, selection: Option.some({ id: "B", byKey: true }), humanFolds: Option.fromUndefinedOr(openedA()) };
    story(
      update,
      given(measuredModel(single(), "live", before, { mode: "manual", topic: "B" })),
      clickNode("root"),
      model((m) => {
        expect(m.camera.mode).toBe("manual");
        expect(shownView(m).openness["A"]).toEqual({ state: "open", byHuman: true });
        expect(m.viewing.selection).toEqual(Option.some({ id: "root", byKey: false }));
      }),
    );
  });

  it("still でも選べる（viewing が変わり、SelectedNode が出る）", () => {
    story(
      update,
      given(measuredModel(single(), "still")),
      clickNode("A"),
      model((m) => expect(m.viewing.selection).toEqual(Option.some({ id: "A", byKey: false }))),
      expectOutMessage(OutMessage.SelectedNode({ nodeId: "A" })),
    );
  });

  it("ドラッグ（押した位置から離れた click）では選ばない。viewing は変わらず、SelectedNode も出ない", () => {
    story(
      update,
      given(measuredModel(single())),
      message(Message.PressedNodeButton({ nodeId: "B", clientX: 50, clientY: 50 })),
      message(Message.MovedPointer({ clientX: 80, clientY: 50, buttons: 1 })),
      message(Message.ReleasedPointer()),
      message(Message.ClickedNodeButton({ nodeId: "B", clientX: 80, clientY: 50 })),
      model((m) => expect(m.viewing).toEqual(INITIAL_VIEWING)),
      expectNoOutMessage(),
    );
  });

  it("押した記録の無い click（キーボード）は選ぶ", () => {
    story(
      update,
      given(measuredModel(single())),
      message(Message.ClickedNodeButtonWithoutPointer({ nodeId: "B" })),
      model((m) => expect(m.viewing.selection).toEqual(Option.some({ id: "B", byKey: false }))),
    );
  });

  it("まとめのノード（run:）の click は選ばない。viewing は変わらず、SelectedNode も出ない", () => {
    story(
      update,
      given(measuredModel(bundled())),
      clickNode("run:A"),
      model((m) => expect(m.viewing).toEqual(INITIAL_VIEWING)),
      expectNoOutMessage(),
    );
  });

  it("まとめのノードを押してドラッグ判定になった click も、押した記録を使い切る（続くキーボードの click で他のノードは選べる）", () => {
    story(
      update,
      given(measuredModel(bundled())),
      message(Message.PressedNodeButton({ nodeId: "run:A", clientX: 50, clientY: 50 })),
      message(Message.ReleasedPointer()),
      message(Message.ClickedNodeButton({ nodeId: "run:A", clientX: 50, clientY: 50 })),
      model((m) => expect(Option.isNone(m.nodePress)).toBe(true)),
      expectNoOutMessage(),
      clickNode("B"),
      model((m) => expect(m.viewing.selection).toEqual(Option.some({ id: "B", byKey: false }))),
    );
  });
});

describe("mapSurface の update: 丸の click で開く・畳む（reduceViewing の foldDot）", () => {

  it("畳んだ議題を開くと子が見え、Esc で人の開閉と選択が None に戻り、子が隠れる", () => {
    story(
      update,
      given(measuredModel(single())),
      clickFoldDot("A"),
      model((m) => {
        expect(m.camera.mode).toBe("auto");
        expect(m.viewing.selection).toEqual(Option.none());
        expect(shownView(m).nodes.map((n) => n.id)).toContain("A1");
        expect(shownView(m).openness["A"]).toEqual({ state: "open", byHuman: true });
      }),
      clickNode("A1"),
      model((m) => expect(m.viewing.selection).toEqual(Option.some({ id: "A1", byKey: false }))),
      message(Message.PressedEscapeKey({ metaKey: false, ctrlKey: false, altKey: false })),
      model((m) => {
        expect(m.viewing.selection).toEqual(Option.none());
        expect(m.viewing.humanFolds).toEqual(Option.none());
        expect(shownView(m).nodes.map((n) => n.id)).not.toContain("A1");
      }),
    );
  });

  it("開いた後は子が見える。位置は人が開いた集合で foldView が返す木を layout した値になる", () => {
    const shown = foldView(single(), openedA(), null).nodes;
    expect(shown.map((n) => n.id)).toContain("A1");
    const target = layout(shown, HEIGHTS);
    story(
      update,
      given(measuredModel(single())),
      clickFoldDot("A"),
      tick(500),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        const positions = positionsOf(m);
        expect(Object.keys(positions).sort()).toEqual(shown.map((n) => n.id).sort());
        for (const n of shown) expect(positions[n.id]).toEqual(target[n.id]);
      }),
    );
  });

  it("開閉で目標の位置が変わるので、補間が始まる（始まりは開く前の位置）", () => {
    const before = measuredModel(single());
    const from = positionsOf(before);
    story(
      update,
      given(before),
      clickFoldDot("A"),
      model((m) => {
        expect(Option.isSome(m.motion)).toBe(true);
        const motion = Option.getOrThrow(m.motion);
        expect(motion.elapsedMs).toBe(0);
        for (const id of Object.keys(from)) expect(Object.fromEntries(HashMap.toEntries(motion.start))[id]).toEqual(from[id]);
      }),
    );
  });

  it("開いたノードの丸をもう一度押すと畳んだ表示になる", () => {
    story(
      update,
      given(measuredModel(single())),
      clickFoldDot("A"),
      clickFoldDot("A"),
      model((m) => {
        expect(m.camera.mode).toBe("auto");
        expect(shownView(m).nodes.map((n) => n.id)).not.toContain("A1");
        expect(shownView(m).openness["A"]?.state).toBe("folded");
      }),
    );
  });

  it("今の議題とその祖先・開閉できないノード・見えていないノード・知らない ID の丸は効かない（viewing も補間も変わらない）", () => {
    for (const id of ["B", "root", "A1", "nope"]) {
      story(
        update,
        given(measuredModel(single())),
        clickFoldDot(id),
        model((m) => {
          expect(m.viewing).toEqual(INITIAL_VIEWING);
          expect(Option.isNone(m.motion)).toBe(true);
        }),
      );
    }
  });

  it("人の開閉は選択に使われる。選んだノードが畳むノードの子孫なら、選択は畳むノードへ移る", () => {
    story(
      update,
      given(measuredModel(single())),
      clickFoldDot("A"),
      clickNode("A1"),
      clickFoldDot("A"),
      model((m) => {
        expect(shownView(m).openness["A"]?.state).toBe("folded");
        expect(m.viewing.selection).toEqual(Option.some({ id: "A", byKey: false }));
      }),
    );
  });

  it("still は畳まないので丸は無く、押しても viewing は変わらない", () => {
    story(
      update,
      given(measuredModel(single(), "still")),
      clickFoldDot("A"),
      model((m) => expect(m.viewing).toEqual(INITIAL_VIEWING)),
    );
  });

  it("まとめのノードの丸を押すと個々の議題になり、選択が先頭へ移る。中身は畳んだまま", () => {
    story(
      update,
      given(measuredModel(bundled())),
      clickFoldDot("run:A"),
      model((m) => {
        expect(m.viewing.selection).toEqual(Option.some({ id: "A", byKey: false }));
        expect(shownView(m).openness).toMatchObject({ A: { state: "folded" }, A2: { state: "folded" } });
        const shown = shownView(m).nodes;
        expect(shown.map((n) => n.id)).not.toContain("run:A");
        expect(shown.map((n) => n.id)).toContain("A2");
        expect(Object.keys(positionsOf(m)).sort()).toEqual(shown.map((n) => n.id).sort());
      }),
    );
  });
});

describe("mapSurface の update: 反映で解いた人の畳みの保存", () => {
  it.each(["C", "B"])("中間の今の議題が %s のとき、次の反映でも解除対象に応じた表示を保つ", (intermediateTopic) => {
    const nodes = [node("root", null, "会議"), node("B", "root"), node("C", "root"), node("C1", "C", "論点")];
    const initial = snap(nodes, { currentTopic: "B", now: 100 });
    let current = measuredModel(initial, "review");
    expect(shownView(current).nodes.map((n) => n.id)).toContain("C1");
    expect(shownView(current).openness["C"]).toEqual({ state: "open", byHuman: false });

    current = update(current, Message.ClickedFoldDot({ nodeId: "C" })).model;
    expect(shownView(current).nodes.map((n) => n.id)).not.toContain("C1");
    expect(shownView(current).openness["C"]?.state).toBe("folded");

    current = update(current, Message.ChangedSnapshot({ snapshot: { ...initial, round: initial.round + 1, currentTopic: intermediateTopic } })).model;
    current = update(current, Message.ChangedSnapshot({ snapshot: { ...initial, round: initial.round + 2, currentTopic: "B" } })).model;
    const final = shownView(current);
    if (intermediateTopic === "C") {
      expect(final.nodes.map((n) => n.id)).toContain("C1");
      expect(final.openness["C"]).toEqual({ state: "open", byHuman: false });
    } else {
      expect(final.nodes.map((n) => n.id)).not.toContain("C1");
      expect(final.openness["C"]?.state).toBe("folded");
    }
  });
});

describe("mapSurface の update: 縁の点の click（reduceViewing の edgeDot）", () => {
  const paused: ViewingState = { ...INITIAL_VIEWING, selection: Option.some({ id: "A", byKey: false }) };

  it("見えているノードの縁の点を押すと、reduceViewing の edgeDot の結果になる（止めたまま、今の議題を覚え直す。重ねる状態は残る）", () => {
    story(
      update,
      given(measuredModel(single(), "live", paused, { mode: "manual", topic: "A" })),
      clickEdgeDot("root"),
      model((m) => {
        expect(m.viewing).toEqual({ ...INITIAL_VIEWING, selection: Option.some({ id: "A", byKey: false }) });
        expect(m.camera.mode).toBe("manual");
        expect(m.camera.topic).toBe("B");
      }),
    );
  });

  it("viewing に渡したうえで、そのノードへ寄る（今の倍率のまま、目標の位置と高さで測ったノードの中心が画面の中央に来る）。補間も SelectedNode も起こさない", () => {
    const start = measuredModel(single(), "live", paused, { mode: "manual", topic: "A" });
    const shown = foldView(single(), undefined, null).nodes;
    const expected = nodeFocusViewport(nodeRect("root", layout(shown, HEIGHTS), { root: { height: HEIGHTS.root } }), start.camera.viewport.zoom, { width: 800, height: 600 });
    expect(expected).not.toEqual(start.camera.viewport);
    story(
      update,
      given(start),
      clickEdgeDot("root"),
      model((m) => {
        expect(m.camera.viewport.x).toBeCloseTo(expected.x, 6);
        expect(m.camera.viewport.y).toBeCloseTo(expected.y, 6);
        expect(m.camera.viewport.zoom).toBeCloseTo(expected.zoom, 6);
        expect(Option.isNone(m.motion)).toBe(true);
      }),
      expectNoOutMessage(),
    );
  });

  it("畳まれて見えていないノード・知らない ID の縁の点は、何もしない", () => {
    for (const id of ["A1", "nope"]) {
      story(
        update,
        given(measuredModel(single(), "live", paused, { mode: "manual", topic: "A" })),
        clickEdgeDot(id),
        model((m) => {
          expect(m.viewing).toEqual(paused);
          expect(m.camera.viewport).toEqual(measuredModel(single(), "live", paused, { mode: "manual", topic: "A" }).camera.viewport);
        }),
      );
    }
  });
});
