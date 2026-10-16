import { HashMap, Option, Schema } from "effect";
import { expectNoOutMessage, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { displayedPositions, init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message, OutMessage } from "../src/app/mapSurface/message.ts";
import { nodeFocusViewport, nodeRect } from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { layout } from "../src/layout.ts";
import { INITIAL_VIEWING, reduceViewing, ViewingState, type VisibleTree } from "../src/viewing.ts";

// マップの表示面の「見る状態」（Issue #818）の update。選ぶ・畳む・開く・縁の点を押した事実が、Model.viewing を
// 既存の純粋な関数（reduceViewing・foldToggle・foldView）が決めたとおりに変えることを見る。期待値は、その純粋な関数を直接呼んだ値と、手で書いた値

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題", extra: Partial<SnapshotNode> = {}): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [], ...extra });
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 3, changes: [], remarks: [], ...extra });

// 済みの議題 A（論点 A1 を持つ）と、話し中の今の議題 B。A は畳まれ、隠れた数の丸を持つ
const single = (): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("B", "root", "議題")], { currentTopic: "B", now: 100 });
// 済みの議題 A・A2 が続く。2 つは「議題 2 件」（run:A）にまとめられる
const bundled = (): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("A2", "root", "議題", { talkStatus: "済み" }), node("B", "root", "議題")], {
    currentTopic: "B",
    now: 100,
  });
const HEIGHTS = { root: 40, A: 50, A1: 60, A2: 50, B: 70, "run:A": 50 };
const NONE: ReadonlySet<string> = new Set();

const measuredModel = (snapshot: Snapshot, mode: MapSurfaceModel["mode"] = "live", viewing: ViewingState = INITIAL_VIEWING): MapSurfaceModel => ({
  ...init(snapshot, mode, false),
  size: Option.some({ width: 800, height: 600 }),
  nodeHeights: HashMap.make(...Object.entries(HEIGHTS)),
  viewing,
});
const clickNode = (nodeId: string) => message(Message.ClickedNodeButton({ nodeId, clientX: 0, clientY: 0 }));
const clickFoldDot = (nodeId: string) => message(Message.ClickedFoldDot({ nodeId }));
const clickEdgeDot = (nodeId: string) => message(Message.ClickedEdgeDot({ nodeId }));
const tick = (deltaMs: number) => message(Message.TickedAnimationFrame({ deltaMs }));
const positionsOf = (m: MapSurfaceModel) => displayedPositions(m);

// select は木に依らないので、空の木で純粋な関数を呼んだ値と比べる
const EMPTY_TREE: VisibleTree = { ids: [], targets: {}, parents: {}, foldState: {}, runs: {}, changed: [], currentTopic: undefined };
const selectedBy = (state: ViewingState, id: string): ViewingState => reduceViewing(state, { type: "select", id }, EMPTY_TREE).state;

describe("ViewingState の Schema（Schema.declare で素通しにしない）", () => {
  const is = Schema.is(ViewingState);

  it("本物の見る状態は通る（カメラの 4 つの mode・重ねる状態・Set の集合）", () => {
    expect(is({ mode: "auto" })).toBe(true);
    expect(is({ mode: "manual", topic: "B" })).toBe(true);
    expect(is({ mode: "manual", topic: undefined })).toBe(true);
    expect(is({ mode: "overview", topic: "B" })).toBe(true);
    expect(is({ mode: "diff", topic: "B" })).toBe(true);
    expect(is({ mode: "diff", topic: undefined })).toBe(true);
    expect(
      is({
        mode: "manual",
        topic: "B",
        keyList: true,
        sideHidden: true,
        captionsHidden: true,
        selection: { id: "A", byKey: true },
        humanOpened: new Set(["A"]),
        humanFolded: new Set(["B"]),
        humanUnbundled: new Set(["A2"]),
      }),
    ).toBe(true);
    expect(is(INITIAL_VIEWING)).toBe(true);
  });

  it("集合を配列で書いたもの・知らない mode・形の崩れた選択は通らない", () => {
    expect(is({ mode: "auto", humanOpened: ["A"] })).toBe(false);
    expect(is({ mode: "auto", humanFolded: ["A"] })).toBe(false);
    expect(is({ mode: "auto", humanUnbundled: ["A"] })).toBe(false);
    expect(is({ mode: "auto", humanOpened: new Set([1]) })).toBe(false);
    expect(is({ mode: "zoom" })).toBe(false);
    expect(is({ mode: "auto", selection: { id: "A" } })).toBe(false);
    expect(is({ mode: "auto", selection: { id: 1, byKey: false } })).toBe(false);
    expect(is({ mode: "diff" })).toBe(false);
    expect(is({ mode: "diff", topic: 1 })).toBe(false);
  });
});

describe("mapSurface の Model: 見る状態の欄", () => {
  it("init は INITIAL_VIEWING（自動のカメラ・選択なし・人の開閉なし）で始まる", () => {
    expect(init(single(), "live", false).viewing).toEqual(INITIAL_VIEWING);
    expect(init(single(), "still", false).viewing).toEqual(INITIAL_VIEWING);
  });

  it("本物の見る状態を持つ Model は通り、集合を配列で書いた viewing は通らない", () => {
    const is = Schema.is(Model);
    const viewing: ViewingState = { mode: "manual", topic: "B", selection: { id: "A", byKey: false }, humanOpened: new Set(["A"]) };
    expect(is({ ...init(single(), "live", false), viewing })).toBe(true);
    expect(is({ ...init(single(), "live", false), viewing: { mode: "auto", humanOpened: ["A"] } })).toBe(false);
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
        expect(m.viewing).toEqual(selectedBy(INITIAL_VIEWING, "B"));
        expect(m.viewing).toEqual({ mode: "auto", selection: { id: "B", byKey: false } });
      }),
      expectOutMessage(OutMessage.SelectedNode({ nodeId: "B" })),
    );
  });

  it("別のノードを click すると選択が移る。人の開閉などの他の状態はそのまま残る", () => {
    const before: ViewingState = { mode: "manual", topic: "B", selection: { id: "B", byKey: true }, humanOpened: new Set(["A"]), keyList: true };
    story(
      update,
      given(measuredModel(single(), "live", before)),
      clickNode("root"),
      model((m) => {
        expect(m.viewing).toEqual(selectedBy(before, "root"));
        expect(m.viewing.mode).toBe("manual");
        expect(m.viewing.humanOpened).toEqual(new Set(["A"]));
        expect(m.viewing.keyList).toBe(true);
        expect(m.viewing.selection).toEqual({ id: "root", byKey: false });
      }),
    );
  });

  it("still でも選べる（viewing が変わり、SelectedNode が出る）", () => {
    story(
      update,
      given(measuredModel(single(), "still")),
      clickNode("A"),
      model((m) => expect(m.viewing).toEqual(selectedBy(INITIAL_VIEWING, "A"))),
      expectOutMessage(OutMessage.SelectedNode({ nodeId: "A" })),
    );
  });

  it("ドラッグ（押した位置から離れた click）では選ばない。viewing は変わらず、SelectedNode も出ない", () => {
    story(
      update,
      given(measuredModel(single())),
      message(Message.PressedNodeButton({ nodeId: "B", clientX: 50, clientY: 50 })),
      message(Message.MovedPointer({ clientX: 80, clientY: 50, buttons: 1 })),
      message(Message.ReleasedPointer({ ctrlKey: false, metaKey: false })),
      message(Message.ClickedNodeButton({ nodeId: "B", clientX: 80, clientY: 50 })),
      model((m) => expect(m.viewing).toEqual(INITIAL_VIEWING)),
      expectNoOutMessage(),
    );
  });

  it("押した記録の無い click（キーボード）は選ぶ", () => {
    story(
      update,
      given(measuredModel(single())),
      clickNode("B"),
      model((m) => expect(m.viewing.selection).toEqual({ id: "B", byKey: false })),
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
      message(Message.ReleasedPointer({ ctrlKey: false, metaKey: false })),
      message(Message.ClickedNodeButton({ nodeId: "run:A", clientX: 50, clientY: 50 })),
      model((m) => expect(Option.isNone(m.nodePress)).toBe(true)),
      expectNoOutMessage(),
      clickNode("B"),
      model((m) => expect(m.viewing.selection).toEqual({ id: "B", byKey: false })),
    );
  });
});

describe("mapSurface の update: 丸の click で開く・畳む（reduceViewing の foldDot）", () => {
  const opened = (): ViewingState => ({ mode: "auto", humanOpened: new Set(["A"]) });

  it("畳んだ議題の丸を押すと、人が開いた集合に入る。カメラの mode と選択は変わらない", () => {
    story(
      update,
      given(measuredModel(single())),
      clickFoldDot("A"),
      model((m) => {
        expect(m.viewing).toEqual(opened());
        expect(m.viewing.humanFolded).toBeUndefined();
      }),
    );
  });

  it("開いた後は子が見える。位置は人が開いた集合で foldView が返す木を layout した値になる", () => {
    const shown = foldView(single(), new Set(["A"]), null, NONE, NONE).nodes;
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
        // 開く前から見えていたノードは、始まりの位置が開く前の位置
        for (const id of Object.keys(from)) expect(Object.fromEntries(HashMap.toEntries(motion.start))[id]).toEqual(from[id]);
      }),
    );
  });

  it("開いたノードの丸をもう一度押すと畳む（人が畳んだ集合に入り、開いた集合からは外れる）", () => {
    story(
      update,
      given(measuredModel(single())),
      clickFoldDot("A"),
      clickFoldDot("A"),
      model((m) => {
        expect(m.viewing).toEqual({ mode: "auto", humanFolded: new Set(["A"]) });
        expect(m.viewing.humanOpened).toBeUndefined();
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
    // A を開いて A1 を選び、A を畳む → 隠れる選択が A へ移る（reduceViewing の foldDot の規則）
    story(
      update,
      given(measuredModel(single())),
      clickFoldDot("A"),
      clickNode("A1"),
      clickFoldDot("A"),
      model((m) => {
        expect(m.viewing.humanFolded).toEqual(new Set(["A"]));
        expect(m.viewing.selection).toEqual({ id: "A", byKey: false });
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

  it("まとめのノードの丸を押すと解く: 入っていた議題が人が解いた集合に入り、選択がまとめの最初の議題へ移る。中身は畳んだまま", () => {
    story(
      update,
      given(measuredModel(bundled())),
      clickFoldDot("run:A"),
      model((m) => {
        expect(m.viewing.humanUnbundled).toEqual(new Set(["A", "A2"]));
        expect(m.viewing.selection).toEqual({ id: "A", byKey: false });
        expect(m.viewing.humanOpened).toBeUndefined();
        // 解いた後の位置は、解いた集合で foldView が返す木の layout
        const shown = foldView(bundled(), NONE, "A", NONE, new Set(["A", "A2"])).nodes;
        expect(shown.map((n) => n.id)).not.toContain("run:A");
        expect(shown.map((n) => n.id)).toContain("A2");
        expect(Object.keys(positionsOf(m)).sort()).toEqual(shown.map((n) => n.id).sort());
      }),
    );
  });
});

describe("mapSurface の update: 縁の点の click（reduceViewing の edgeDot）", () => {
  const paused: ViewingState = { mode: "manual", topic: "A", selection: { id: "A", byKey: false } };

  it("見えているノードの縁の点を押すと、reduceViewing の edgeDot の結果になる（止めたまま、今の議題を覚え直す。重ねる状態は残る）", () => {
    story(
      update,
      given(measuredModel(single(), "live", paused)),
      clickEdgeDot("root"),
      model((m) => {
        expect(m.viewing).toEqual({ mode: "manual", topic: "B", selection: { id: "A", byKey: false } });
      }),
    );
  });

  it("viewing に渡したうえで、そのノードへ寄る（今の倍率のまま、目標の位置と高さで測ったノードの中心が画面の中央に来る）。補間も SelectedNode も起こさない", () => {
    const start = measuredModel(single(), "live", paused);
    const shown = foldView(single(), NONE, null, NONE, NONE).nodes;
    const expected = nodeFocusViewport(nodeRect("root", layout(shown, HEIGHTS), { root: { height: HEIGHTS.root } }), start.viewport.zoom, { width: 800, height: 600 });
    expect(expected).not.toEqual(start.viewport);
    story(
      update,
      given(start),
      clickEdgeDot("root"),
      model((m) => {
        expect(m.viewport.x).toBeCloseTo(expected.x, 6);
        expect(m.viewport.y).toBeCloseTo(expected.y, 6);
        expect(m.viewport.zoom).toBeCloseTo(expected.zoom, 6);
        expect(Option.isNone(m.motion)).toBe(true);
      }),
      expectNoOutMessage(),
    );
  });

  it("畳まれて見えていないノード・知らない ID の縁の点は、何もしない", () => {
    for (const id of ["A1", "nope"]) {
      story(
        update,
        given(measuredModel(single(), "live", paused)),
        clickEdgeDot(id),
        model((m) => {
          expect(m.viewing).toEqual(paused);
          expect(m.viewport).toEqual(measuredModel(single(), "live", paused).viewport);
        }),
      );
    }
  });
});
