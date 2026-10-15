import { getBezierPath, getViewportForBounds, Position } from "./fixtures/xyflowReference.ts";
import { HashMap, Option } from "effect";
import { attr, expect as expectScene, findAll, given, Mount, scene, selector, Subscription, tap, textContent } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init, Model, update, view } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { CLICK_ZOOM_FACTOR, focusViewport, nodeRect, pinchZoomFactor, zoomAtPoint } from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { KIND_COLOR } from "../src/kinds.ts";
import { layout, NODE_WIDTH } from "../src/layout.ts";
import { interpolate, startPositions } from "../src/motion.ts";

// マップの表示面（Issue #814）の Scene。描いた view から入り、Mount を resolve して、ノードとエッジが今の画面（React Flow）と同じ位置に出ることを見る。
// 比べる相手は layout が返す位置・@xyflow の getBezierPath・getViewportForBounds（fitView の式）。位置を Model に持たないので、view が毎回導く値を外から確かめる

type MapSurfaceModel = typeof Model.Type;
type VNode = Parameters<typeof textContent>[0];
const app = { update, view };

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"], text_: string, extra: Partial<SnapshotNode> = {}): SnapshotNode => ({
  id,
  parent,
  kind,
  text: text_,
  evidence: parent ? ["r1"] : [],
  ...extra,
});
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 3, changes: [], remarks: [], ...extra });

// 会議 root > 議題 A > (論点 P, 案 D)。親子の色が全部違うので、エッジは線の色で見分けられる
const nodes = (): SnapshotNode[] => [
  node("root", null, "会議", "定例"),
  node("A", "root", "議題", "予算"),
  node("P", "A", "論点", "上限をどうするか", { pointStatus: "未決" }),
  node("D", "A", "案", "月額制", { planStatus: "却下" }),
];
const HEIGHTS = { root: 40, A: 64, P: 88, D: 52 };
const SIZE = { width: 800, height: 600 };

const modelOf = (snapshot: Snapshot, mode: MapSurfaceModel["mode"]): MapSurfaceModel => init(snapshot, mode, false);
const measured = (nodeHeights: Record<string, number>, size = SIZE) => Mount.resolve(ObserveMapSurface, Message.MeasuredMapSurface({ ...size, nodeHeights }));

// エッジの端点。出る側は親の右端から 3px 外、入る側は子の左端から 3px 外（@xyflow の .react-flow__handle の位置。実際のブラウザで測った値）
const HANDLE_OUTSET = 3;
const numbers = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
const expectNumbers = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 6));
};
const edgePath = (positions: ReturnType<typeof layout>, heights: Record<string, number>, parent: SnapshotNode, child: SnapshotNode): string =>
  getBezierPath({
    sourceX: positions[parent.id]!.x + NODE_WIDTH + HANDLE_OUTSET,
    sourceY: positions[parent.id]!.y + (heights[parent.id] ?? 40) / 2,
    sourcePosition: Position.Right,
    targetX: positions[child.id]!.x - HANDLE_OUTSET,
    targetY: positions[child.id]!.y + (heights[child.id] ?? 40) / 2,
    targetPosition: Position.Left,
  })[0];

const descendants = (vnode: VNode): VNode[] => [vnode, ...(vnode.children ?? []).flatMap((c) => (typeof c === "string" ? [] : descendants(c)))];
const styleOf = (vnode: VNode, name: string): string | undefined => (vnode.data?.style as Record<string, string> | undefined)?.[name];

// ノードの外側の要素の transform（translate(x px, y px)）
const nodeTranslate = (html: VNode, id: string): number[] => {
  const wrapper = descendants(html).find((v) => (v.data?.attrs as Record<string, unknown> | undefined)?.["data-node-id"] === id);
  expect(wrapper, `node ${id}`).toBeDefined();
  return numbers(styleOf(wrapper!, "transform") ?? "");
};
// ビューポートは scale() の付く transform を持つ要素 1 つだけ（translate(x px, y px) scale(zoom)）
const viewportTransform = (html: VNode): number[] => {
  const viewports = descendants(html).filter((v) => styleOf(v, "transform")?.includes("scale(") === true);
  expect(viewports).toHaveLength(1);
  return numbers(styleOf(viewports[0]!, "transform")!);
};
const edges = (html: VNode) =>
  descendants(html)
    .filter((v) => v.sel?.startsWith("path") === true)
    .map((v) => ({ d: Option.getOrElse(attr(v, "d"), () => ""), stroke: Option.getOrUndefined(attr(v, "stroke")), strokeWidth: Option.getOrUndefined(attr(v, "stroke-width")) }));

const fitBounds = (rects: Array<{ x: number; y: number; width: number; height: number }>) => {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  return { x: left, y: top, width: Math.max(...rects.map((r) => r.x + r.width)) - left, height: Math.max(...rects.map((r) => r.y + r.height)) - top };
};

const wrapperOf = (id: string) => selector(`[data-node-id="${id}"]`);
const mapNodeOf = (id: string) => selector(`[data-node-id="${id}"] .map-node`);

describe("mapSurface の Scene: Mount（実測と画面の大きさ）", () => {
  it("Mount は表示面の要素に 1 つだけ付き、resolve するまでは、ノードは見せず、エッジも描かない", () => {
    scene(
      app,
      given(modelOf(snap(nodes()), "still")),
      Mount.expectExact(ObserveMapSurface),
      expectScene(wrapperOf("A")).toHaveStyle("visibility", "hidden"),
      expectScene(wrapperOf("root")).toHaveStyle("visibility", "hidden"),
      tap((simulation) => expect(edges(simulation.html)).toEqual([])),
      measured(HEIGHTS),
    );
  });

  it("resolve すると、測れたノードが見え、エッジが描かれる", () => {
    scene(
      app,
      given(modelOf(snap(nodes()), "still")),
      measured(HEIGHTS),
      expectScene(wrapperOf("A")).not.toHaveStyle("visibility", "hidden"),
      expectScene(wrapperOf("P")).not.toHaveStyle("visibility", "hidden"),
      tap((simulation) => expect(edges(simulation.html)).toHaveLength(3)),
    );
  });

  it("測れたノードだけ見える。エッジは、両端が測れたものだけ描く（測れていない子へのエッジは出ない）", () => {
    const all = nodes();
    scene(
      app,
      given(modelOf(snap(all), "still")),
      measured({ root: HEIGHTS.root, A: HEIGHTS.A }),
      expectScene(wrapperOf("root")).not.toHaveStyle("visibility", "hidden"),
      expectScene(wrapperOf("A")).not.toHaveStyle("visibility", "hidden"),
      expectScene(wrapperOf("P")).toHaveStyle("visibility", "hidden"),
      expectScene(wrapperOf("D")).toHaveStyle("visibility", "hidden"),
      tap((simulation) => {
        const drawn = edges(simulation.html);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]!.stroke).toBe(KIND_COLOR["議題"]);
      }),
    );
  });
});

describe("mapSurface の Scene: ノードとエッジの位置は layout の値と同じ", () => {
  it("ノードの外側の要素の transform が、実測の高さで layout した位置になる（x・y とも）", () => {
    const all = nodes();
    const positions = layout(all, HEIGHTS);
    scene(
      app,
      given(modelOf(snap(all), "still")),
      measured(HEIGHTS),
      tap((simulation) => {
        for (const n of all) expectNumbers(nodeTranslate(simulation.html, n.id), [positions[n.id]!.x, positions[n.id]!.y]);
      }),
    );
  });

  it("位置は実測の高さに従う。測った高さが違えば、同じ Snapshot でも位置が変わる", () => {
    const all = nodes();
    const tall = { ...HEIGHTS, P: 300 };
    const positions = layout(all, tall);
    expect(positions["D"]!.y).not.toBe(layout(all, HEIGHTS)["D"]!.y);
    scene(
      app,
      given(modelOf(snap(all), "still")),
      measured(tall),
      tap((simulation) => {
        for (const n of all) expectNumbers(nodeTranslate(simulation.html, n.id), [positions[n.id]!.x, positions[n.id]!.y]);
      }),
    );
  });

  it("測れていないノードの位置は、仮の高さで layout した位置になる", () => {
    const all = nodes();
    const partial = { root: HEIGHTS.root, A: HEIGHTS.A };
    const positions = layout(all, partial);
    scene(
      app,
      given(modelOf(snap(all), "still")),
      measured(partial),
      tap((simulation) => {
        for (const n of all) expectNumbers(nodeTranslate(simulation.html, n.id), [positions[n.id]!.x, positions[n.id]!.y]);
      }),
    );
  });

  it("エッジは親から子へ、@xyflow の既定のベジェ（曲率 0.25）と同じ形で、端が layout の位置にある。線の色は子の種別の色、太さは 2", () => {
    const all = nodes();
    const positions = layout(all, HEIGHTS);
    const byId = new Map(all.map((n) => [n.id, n]));
    scene(
      app,
      given(modelOf(snap(all), "still")),
      measured(HEIGHTS),
      tap((simulation) => {
        const drawn = edges(simulation.html);
        expect(drawn).toHaveLength(3);
        for (const child of all.filter((n) => n.parent !== null)) {
          const edge = drawn.find((e) => e.stroke === KIND_COLOR[child.kind]);
          expect(edge, `edge to ${child.id}`).toBeDefined();
          expectNumbers(numbers(edge!.d), numbers(edgePath(positions, HEIGHTS, byId.get(child.parent!)!, child)));
          expect(edge!.strokeWidth).toBe("2");
        }
      }),
    );
  });
});

describe("mapSurface の Scene: 全体を収める（fitView の式）", () => {
  const rectsOf = (shown: SnapshotNode[], heights: Record<string, number>) => {
    const positions = layout(shown, heights);
    return shown.map((n) => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  };

  it("画面の大きさが分かるまでは、倍率 1・位置 (0, 0)", () => {
    scene(
      app,
      given(modelOf(snap(nodes()), "still")),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), [0, 0, 1])),
      measured(HEIGHTS),
    );
  });

  it("測れたノードの外接箱を、padding 0.1 で画面に収める", () => {
    const all = nodes();
    const expected = getViewportForBounds(fitBounds(rectsOf(all, HEIGHTS)), SIZE.width, SIZE.height, 0.02, 2, 0.1);
    scene(
      app,
      given(modelOf(snap(all), "still")),
      measured(HEIGHTS),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), [expected.x, expected.y, expected.zoom])),
    );
  });

  it("収める箱には、測れたノードだけを使う", () => {
    const all = nodes();
    const partial = { root: HEIGHTS.root, A: HEIGHTS.A };
    // 位置は測れていないノードも含めた木全体の layout（React 版と同じ）。収める箱だけが、測れたノードに限られる
    const positions = layout(all, partial);
    const rects = all.slice(0, 2).map((n) => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: partial[n.id as "root" | "A"] }));
    const expected = getViewportForBounds(fitBounds(rects), SIZE.width, SIZE.height, 0.02, 2, 0.1);
    scene(
      app,
      given(modelOf(snap(all), "still")),
      measured(partial),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), [expected.x, expected.y, expected.zoom])),
    );
  });

  it("測れたノードが無いうちは、画面の大きさがあっても倍率 1・位置 (0, 0)", () => {
    scene(
      app,
      given(modelOf(snap(nodes()), "still")),
      measured({}),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), [0, 0, 1])),
    );
  });

  describe("収める倍率の下限（撮影は 0.02、ふだんは 0.5）", () => {
    const tallNodes = (): SnapshotNode[] => [node("root", null, "会議", "定例"), node("A", "root", "議題", "予算")];
    const tallHeights = { root: 40, A: 5000 };

    it("撮影（still）は、画面に収まるまで縮める", () => {
      const expected = getViewportForBounds(fitBounds(rectsOf(tallNodes(), tallHeights)), SIZE.width, SIZE.height, 0.02, 2, 0.1);
      expect(expected.zoom).toBeLessThan(0.5);
      scene(
        app,
        given(modelOf(snap(tallNodes()), "still")),
        measured(tallHeights),
        tap((simulation) => expectNumbers(viewportTransform(simulation.html), [expected.x, expected.y, expected.zoom])),
      );
    });

    it("ふだん（live）は 0.5 で止める", () => {
      const expected = getViewportForBounds(fitBounds(rectsOf(tallNodes(), tallHeights)), SIZE.width, SIZE.height, 0.5, 2, 0.1);
      expect(expected.zoom).toBe(0.5);
      scene(
        app,
        given(modelOf(snap(tallNodes()), "live")),
        measured(tallHeights),
        tap((simulation) => expectNumbers(viewportTransform(simulation.html), [expected.x, expected.y, expected.zoom])),
      );
    });
  });
});

describe("mapSurface の Scene: 畳み（foldView）は live だけ", () => {
  // 済みの議題 A（論点 A1 を持つ）と、話し中の今の議題 B
  const foldNodes = (): SnapshotNode[] => [
    node("root", null, "会議", "定例"),
    node("A", "root", "議題", "採用", { talkStatus: "済み" }),
    node("A1", "A", "論点", "人数", { pointStatus: "未決" }),
    node("B", "root", "議題", "予算"),
  ];
  const foldHeights = { root: 40, A: 50, A1: 60, B: 70 };
  const foldSnap = () => snap(foldNodes(), { currentTopic: "B", now: 100 });
  const NONE: ReadonlySet<string> = new Set();

  it("live: 済みの議題の子は描かず、その議題は畳んだ見た目（隠れた数と手がかり）になる。位置は畳んだ後の木を layout した値", () => {
    const view_ = foldView(foldSnap(), NONE, null, NONE, NONE);
    const positions = layout(view_.nodes, foldHeights);
    scene(
      app,
      given(modelOf(foldSnap(), "live")),
      measured(foldHeights),
      expectScene(wrapperOf("A1")).toBeAbsent(),
      expectScene(mapNodeOf("A")).toHaveClass("map-node--folded"),
      expectScene(selector('[data-node-id="A"] .map-node__count')).toHaveText(String(view_.folds["A"]!.hidden)),
      expectScene(selector('[data-node-id="A"] .map-node__hint')).toHaveText(view_.folds["A"]!.hint!),
      expectScene(mapNodeOf("B")).not.toHaveClass("map-node--folded"),
      tap((simulation) => {
        for (const n of view_.nodes) expectNumbers(nodeTranslate(simulation.html, n.id), [positions[n.id]!.x, positions[n.id]!.y]);
        expect(edges(simulation.html)).toHaveLength(view_.nodes.filter((n) => n.parent !== null).length);
      }),
    );
  });

  it("still: 同じ Snapshot でも畳まず、全ノードを描く", () => {
    const positions = layout(foldNodes(), foldHeights);
    scene(
      app,
      given(modelOf(foldSnap(), "still")),
      measured(foldHeights),
      expectScene(wrapperOf("A1")).toExist(),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--folded"),
      tap((simulation) => {
        expect(findAll(simulation.html, ".map-node__count")).toHaveLength(0);
        for (const n of foldNodes()) expectNumbers(nodeTranslate(simulation.html, n.id), [positions[n.id]!.x, positions[n.id]!.y]);
      }),
    );
  });
});

describe("mapSurface の Scene: ノードの DOM は MapNode.tsx と同じ形・class", () => {
  it("map-node の中に button.map-node__button（aria-pressed=false）。印・文・nopan・種別の色が付く", () => {
    scene(
      app,
      given(modelOf(snap(nodes()), "still")),
      measured(HEIGHTS),
      expectScene(mapNodeOf("A")).toHaveClass("nopan"),
      expectScene(mapNodeOf("A")).toHaveStyle("--kind-color", KIND_COLOR["議題"]),
      expectScene(mapNodeOf("P")).toHaveStyle("--kind-color", KIND_COLOR["論点"]),
      expectScene(selector('[data-node-id="A"] button.map-node__button')).toHaveAttr("aria-pressed", "false"),
      expectScene(selector('[data-node-id="A"] button.map-node__button .map-node__text')).toHaveText("予算"),
      expectScene(selector('[data-node-id="A"] .map-node__mark')).toBeAbsent(),
      expectScene(selector('[data-node-id="P"] button.map-node__button .map-node__mark')).toHaveText("?"),
      expectScene(selector('[data-node-id="P"] button.map-node__button .map-node__text')).toHaveText("上限をどうするか"),
    );
  });

  // Issue #1023: 案は本文の後ろに「— 出した人」、TODO は「→ 担当者 · 期限」を薄く小さな文字で出す。色やバッジでは話者を分けない
  describe("案の出した人と TODO の担当者", () => {
    const people = () => snap([
      node("root", null, "会議", "定例"),
      node("A", "root", "議題", "予算", { proposer: "相手 A", assigneeSpeaker: "相手 A" }),
      node("P", "A", "論点", "上限をどうするか", { pointStatus: "未決", proposer: "相手 A" }),
      node("D1", "P", "案", "月額制", { proposer: "相手 A" }),
      node("D2", "P", "案", "年額制", { proposer: "自分" }),
      node("D3", "P", "案", "従量制", { proposer: "相手" }),
      node("D4", "P", "案", "旧ログの案"),
      node("T1", "A", "TODO", "見積もりを出す", { assigneeSpeaker: "自分", due: "10/15" }),
      node("T2", "A", "TODO", "契約書を直す", { assignee: "田中", due: "来週" }),
      node("T3", "A", "TODO", "担当なし"),
      node("K", "A", "課題", "課題", { assignee: "田中", proposer: "相手 B" }),
    ]);
    const heights = { root: 40, A: 64, P: 88, D1: 52, D2: 52, D3: 52, D4: 52, T1: 52, T2: 52, T3: 52, K: 52 };
    const person = (id: string) => selector(`[data-node-id="${id}"] .map-node__person`);
    // ノードの中で、本文（map-node__text）と人の行（map-node__person）が出る順
    const order = (html: VNode, id: string): string[] => {
      const wrapper = descendants(html).find((v) => (v.data?.attrs as Record<string, unknown> | undefined)?.["data-node-id"] === id)!;
      return descendants(wrapper).flatMap((v) => (Option.getOrElse(attr(v, "class"), () => "").match(/map-node__(?:text|person)\b/g) ?? []));
    };

    it("案は「— 相手 A」「— 自分」を、本文の後ろに出す", () => {
      scene(
        app,
        given(modelOf(people(), "still")),
        measured(heights),
        expectScene(person("D1")).toHaveText("— 相手 A"),
        expectScene(person("D2")).toHaveText("— 自分"),
        tap((simulation) => expect(order(simulation.html, "D1")).toEqual(["map-node__text", "map-node__person"])),
      );
    });

    it("話者なしの相手の案と、出した人の無い案には出ない", () => {
      scene(
        app,
        given(modelOf(people(), "still")),
        measured(heights),
        expectScene(person("D3")).toBeAbsent(),
        expectScene(person("D4")).toBeAbsent(),
        tap((simulation) => expect(order(simulation.html, "D4")).toEqual(["map-node__text"])),
      );
    });

    it("TODO は「→ 自分 · 10/15」「→ 田中 · 来週」。担当者も期限も無ければ出ない", () => {
      scene(
        app,
        given(modelOf(people(), "still")),
        measured(heights),
        expectScene(person("T1")).toHaveText("→ 自分 · 10/15"),
        expectScene(person("T2")).toHaveText("→ 田中 · 来週"),
        tap((simulation) => expect(order(simulation.html, "T1")).toEqual(["map-node__text", "map-node__person"])),
        expectScene(person("T3")).toBeAbsent(),
      );
    });

    it("議題・論点・課題には人が出ない", () => {
      scene(
        app,
        given(modelOf(people(), "still")),
        measured(heights),
        expectScene(person("A")).toBeAbsent(),
        expectScene(person("P")).toBeAbsent(),
        expectScene(person("K")).toBeAbsent(),
      );
    });

    it("live でも出る（選択や畳みの有無に関わらない）", () => {
      scene(
        app,
        given(modelOf(people(), "live")),
        measured(heights),
        expectScene(person("D1")).toHaveText("— 相手 A"),
        expectScene(person("T1")).toHaveText("→ 自分 · 10/15"),
      );
    });
  });

  it("却下の案だけ map-node--rejected。選択・点滅の class は、この Scene では付かない", () => {
    scene(
      app,
      given(modelOf(snap(nodes()), "still")),
      measured(HEIGHTS),
      expectScene(mapNodeOf("D")).toHaveClass("map-node--rejected"),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--rejected"),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--selected"),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--blink"),
    );
  });

  it("live: 今回の反映で変わったノードに map-node--blink が付く。still では付かない", () => {
    const changed = snap(nodes(), { round: 3, changes: [{ change: "追加", node: "P", kind: "論点", text: "上限をどうするか", round: 3, at: 0 } as Snapshot["changes"][number]] });
    scene(
      app,
      given(modelOf(changed, "live")),
      measured(HEIGHTS),
      expectScene(mapNodeOf("P")).toHaveClass("map-node--blink"),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--blink"),
    );
    scene(app, given(modelOf(changed, "still")), measured(HEIGHTS), expectScene(mapNodeOf("P")).not.toHaveClass("map-node--blink"));
  });
});

describe("mapSurface の Scene: パン（ビューポートの transform が、全体を収める位置から画面上で動いた分だけずれる）", () => {
  // Mount は 1 つの要素に 1 つで、resolve できるのは 1 回。実測は update で given の Model に入れ（自動のカメラが全体を収める）、パンの Message を resolve する 1 回に使う
  const measuredModel = (mode: MapSurfaceModel["mode"]): MapSurfaceModel => update(modelOf(snap(nodes()), mode), Message.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS })).model;
  const fitOf = (mode: MapSurfaceModel["mode"]) => {
    const positions = layout(nodes(), HEIGHTS);
    const rects = nodes().map((n) => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: HEIGHTS[n.id as keyof typeof HEIGHTS] }));
    return getViewportForBounds(fitBounds(rects), SIZE.width, SIZE.height, mode === "still" ? 0.02 : 0.5, 2, 0.1);
  };
  const at = (mode: MapSurfaceModel["mode"], dx: number, dy: number) => {
    const fit = fitOf(mode);
    return [fit.x + dx, fit.y + dy, fit.zoom];
  };
  const wheel = (over: Partial<typeof Message.WheeledMapSurface.Type> = {}) =>
    Message.WheeledMapSurface({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0, x: 0, y: 0, ...over });
  const press = (over: Partial<typeof Message.PressedMapSurface.Type> = {}) => Message.PressedMapSurface({ clientX: 100, clientY: 100, button: 0, ctrlKey: false, insideNoPan: false, ...over });
  const moved = (clientX: number, clientY: number) => Message.MovedPointer({ clientX, clientY, buttons: 1 });

  it("全体を収める倍率は 1 でない（パンが倍率に左右されないことを、この倍率で見る）", () => {
    expect(fitOf("live").zoom).not.toBe(1);
  });

  it("live: スクロールで、transform の x・y が delta × 0.5 だけ逆向きに動く。倍率は変わらない", () => {
    scene(
      app,
      given(measuredModel("live")),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("live", 0, 0))),
      Mount.resolve(ObserveMapSurface, wheel({ deltaX: 40, deltaY: 100 })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("live", -20, -50))),
    );
  });

  it("live: ⌘＋Shift＋スクロールで、大きい方の軸だけが raw の量で動く", () => {
    scene(
      app,
      given(measuredModel("live")),
      Mount.resolve(ObserveMapSurface, wheel({ deltaX: 30, deltaY: 5, shiftKey: true, metaKey: true, timeStamp: 1000 })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("live", -30, 0))),
    );
  });

  it("live: 空いたところを押して動かすと、動いた分だけ transform がずれ、離した後の移動では動かない", () => {
    scene(
      app,
      given(measuredModel("live")),
      Mount.resolve(ObserveMapSurface, press({ clientX: 100, clientY: 100 })),
      Subscription.emit(moved(130, 90)),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("live", 30, -10))),
      Subscription.emit(moved(140, 95)),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("live", 40, -5))),
      Subscription.emit(Message.ReleasedPointer({ ctrlKey: false, metaKey: false })),
      Subscription.emit(moved(300, 300)),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("live", 40, -5))),
    );
  });

  it("live: ノード（.nopan）の上で始めたドラッグでは、transform は動かない", () => {
    scene(
      app,
      given(measuredModel("live")),
      Mount.resolve(ObserveMapSurface, press({ insideNoPan: true })),
      Subscription.emit(moved(130, 90)),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("live", 0, 0))),
    );
  });

  it("still: ドラッグしても transform は動かない", () => {
    scene(
      app,
      given(measuredModel("still")),
      Mount.resolve(ObserveMapSurface, press()),
      Subscription.emit(moved(130, 90)),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("still", 0, 0))),
    );
  });

  it("still: スクロールしても、軸固定でも、transform は動かない", () => {
    scene(
      app,
      given(measuredModel("still")),
      Mount.resolve(ObserveMapSurface, wheel({ deltaX: 40, deltaY: 100 })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("still", 0, 0))),
    );
    scene(
      app,
      given(measuredModel("still")),
      Mount.resolve(ObserveMapSurface, wheel({ deltaX: 30, deltaY: 5, shiftKey: true, metaKey: true, timeStamp: 1000 })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), at("still", 0, 0))),
    );
  });
});

describe("mapSurface の Scene: ズーム（ビューポートの transform が、今と同じ式で変わる）", () => {
  // Mount は 1 つの要素に 1 つで、resolve できるのは 1 回。実測は given の Model に入れ、ズームの Message を resolve する 1 回に使う
  const measuredModel = (mode: MapSurfaceModel["mode"]): MapSurfaceModel => update(modelOf(snap(nodes()), mode), Message.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS })).model;
  const fitOf = (minZoom: number): { x: number; y: number; zoom: number } => {
    const positions = layout(nodes(), HEIGHTS);
    const rects = nodes().map((n) => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: HEIGHTS[n.id as keyof typeof HEIGHTS] }));
    return getViewportForBounds(fitBounds(rects), SIZE.width, SIZE.height, minZoom, 2, 0.1);
  };
  const POINT = { x: 300, y: 200 };
  const transformOf = (v: { x: number; y: number; zoom: number }) => [v.x, v.y, v.zoom];
  const zoomedLive = (factor: number) => transformOf(zoomAtPoint(fitOf(0.5), POINT, factor));
  const wheel = (over: Partial<typeof Message.WheeledMapSurface.Type> = {}) =>
    Message.WheeledMapSurface({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0, ...POINT, ...over });
  const click = (over: Partial<typeof Message.ClickedMapSurfaceWithModifier.Type> = {}) =>
    Message.ClickedMapSurfaceWithModifier({ ...POINT, ctrlKey: false, metaKey: false, altKey: false, ...over });

  it("live: Ctrl＋ホイールで、ポインタの位置を中心に pinchZoomFactor の倍率だけ transform が変わる", () => {
    const factor = pinchZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: true }, false);
    expect(factor).not.toBe(1);
    scene(
      app,
      given(measuredModel("live")),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), transformOf(fitOf(0.5)))),
      Mount.resolve(ObserveMapSurface, wheel({ ctrlKey: true, deltaY: -100 })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), zoomedLive(factor))),
    );
  });

  it("live: ⌘＋クリックで 1.5 倍、Ctrl＋Alt＋クリックで 1/1.5 倍", () => {
    scene(
      app,
      given(measuredModel("live")),
      Mount.resolve(ObserveMapSurface, click({ metaKey: true })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), zoomedLive(CLICK_ZOOM_FACTOR))),
    );
    scene(
      app,
      given(measuredModel("live")),
      Mount.resolve(ObserveMapSurface, click({ ctrlKey: true, altKey: true })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), zoomedLive(1 / CLICK_ZOOM_FACTOR))),
    );
  });

  it("live: Safari の gesture の scale の変化で、点を中心にその比だけ transform が変わる", () => {
    scene(
      app,
      given(measuredModel("live")),
      Mount.resolve(ObserveMapSurface, Message.ChangedMapSurfaceGesture({ scale: 1.25, ...POINT })),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), zoomedLive(1.25))),
    );
  });

  it("live: gesture の開始の Message 自体は transform を動かさない", () => {
    scene(
      app,
      given(measuredModel("live")),
      Mount.resolve(ObserveMapSurface, Message.StartedMapSurfaceGesture()),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), transformOf(fitOf(0.5)))),
    );
  });

  it("still: Ctrl＋ホイール・⌘＋クリック・gesture のどれでも transform は動かない", () => {
    for (const message of [wheel({ ctrlKey: true, deltaY: -100 }), click({ metaKey: true }), Message.ChangedMapSurfaceGesture({ scale: 1.5, ...POINT })]) {
      scene(
        app,
        given(measuredModel("still")),
        Mount.resolve(ObserveMapSurface, message),
        tap((simulation) => expectNumbers(viewportTransform(simulation.html), transformOf(fitOf(0.02)))),
      );
    }
  });
});

describe("mapSurface の Scene: カメラ（Issue #819。ビューポートの transform は Model の viewport を描く）", () => {
  it("live で今の議題があると、測れた後の transform は、今の議題（と子孫）を寄せ先にした focusViewport の値で、全体を収めた値ではない", () => {
    const all = nodes();
    const topic = snap(all, { currentTopic: "A" });
    const target = layout(all, HEIGHTS);
    const dims = Object.fromEntries(Object.entries(HEIGHTS).map(([id, height]) => [id, { height }]));
    const expected = focusViewport(["A", "P", "D"].map((id) => nodeRect(id, target, dims)), nodeRect("A", target, dims), SIZE);
    const rects = all.map((n) => ({ x: target[n.id]!.x, y: target[n.id]!.y, width: NODE_WIDTH, height: HEIGHTS[n.id as keyof typeof HEIGHTS] }));
    const fit = getViewportForBounds(fitBounds(rects), SIZE.width, SIZE.height, 0.5, 2, 0.1);
    expect([expected.x, expected.y, expected.zoom]).not.toEqual([fit.x, fit.y, fit.zoom]);
    scene(
      app,
      given(modelOf(topic, "live")),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), [0, 0, 1])),
      measured(HEIGHTS),
      tap((simulation) => expectNumbers(viewportTransform(simulation.html), [expected.x, expected.y, expected.zoom])),
    );
  });
});

describe("mapSurface の Scene: 動き（補間中の位置でノードとエッジを描く）", () => {
  const before = snap(nodes());
  const after = snap([...nodes(), node("N", "A", "案", "新しい案")], { round: 4 });
  const shownOf = (snapshot: Snapshot) => foldView(snapshot, new Set(), null, new Set(), new Set()).nodes;
  const measuredLive: MapSurfaceModel = { ...modelOf(before, "live"), size: Option.some(SIZE), nodeHeights: HashMap.make(...Object.entries(HEIGHTS)) };
  // 反映の直後（補間の経過 0）の Model。update を通して作る
  const changedModel = (): MapSurfaceModel => update(measuredLive, Message.ChangedSnapshot({ snapshot: after })).model;
  const tick = (deltaMs: number) => Message.TickedAnimationFrame({ deltaMs });
  // Mount の結果は大きさだけの測定（目標は変わらず、補間の経過も戻らない）
  const mounted = Mount.resolve(ObserveMapSurface, Message.MeasuredMapSurface({ ...SIZE, nodeHeights: {} }));

  it("反映の直後は今までの位置、フレームを進めると途中の位置、終わると目標の位置の transform とエッジになる", () => {
    const from = layout(shownOf(before), HEIGHTS);
    const to = layout(shownOf(after), HEIGHTS);
    const start = startPositions(shownOf(after), from, to);
    const mid = interpolate(start, to, 0.5);
    expect(start["A"]).not.toEqual(to["A"]);
    const parent = shownOf(after).find((n) => n.id === "A")!;
    const child = shownOf(after).find((n) => n.id === "P")!;
    const expectAt = (html: VNode, positions: ReturnType<typeof layout>) => {
      for (const n of shownOf(after)) expectNumbers(nodeTranslate(html, n.id), [positions[n.id]!.x, positions[n.id]!.y]);
      const edge = edges(html).find((e) => e.stroke === KIND_COLOR[child.kind])!;
      expectNumbers(numbers(edge.d), numbers(edgePath(positions, HEIGHTS, parent, child)));
    };
    scene(
      app,
      given(changedModel()),
      mounted,
      tap((simulation) => expectAt(simulation.html, start)),
      Subscription.emit(tick(250)),
      tap((simulation) => expectAt(simulation.html, mid)),
      Subscription.emit(tick(250)),
      tap((simulation) => expectAt(simulation.html, to)),
    );
  });

  it("still: 反映の直後から目標の位置で描く（補間しない）", () => {
    const stillMeasured: MapSurfaceModel = { ...measuredLive, mode: "still" };
    const changed = update(stillMeasured, Message.ChangedSnapshot({ snapshot: after })).model;
    const to = layout(after.nodes, HEIGHTS);
    scene(
      app,
      given(changed),
      mounted,
      tap((simulation) => {
        for (const n of after.nodes) expectNumbers(nodeTranslate(simulation.html, n.id), [to[n.id]!.x, to[n.id]!.y]);
      }),
    );
  });
});
