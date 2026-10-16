import { HashMap, Option } from "effect";
import { attr, click, expect as expectScene, findAll, given, Mount, scene, selector, tap, textContent } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init, Model, update, view } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { edgeDots, nodeFocusViewport, nodeRect } from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { layout } from "../src/layout.ts";
import { INITIAL_VIEWING, type ViewingState } from "../src/viewing.ts";

// マップの表示面の「見る状態」（Issue #818）の Scene。描いた view から入り、選ぶ・畳む・開く・縁の点が、今の画面（MapNode.tsx・MapView.tsx）と同じ DOM になることを見る。
// 比べる相手は既存の純粋な関数（foldView・layout・edgeDots）。Scene は Model を見せないので、押した後の viewing の値そのものは Story（mapSurfaceViewing.story.test.ts）で見る

type MapSurfaceModel = typeof Model.Type;
type VNode = Parameters<typeof textContent>[0];
const app = { update, view };

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題", extra: Partial<SnapshotNode> = {}): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [], ...extra });
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 3, changes: [], remarks: [], ...extra });

// 済みの議題 A（論点 A1 を持つ）は畳まれ、話し中の今の議題 B は畳まれない
const single = (extra: Partial<Snapshot> = {}): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("B", "root", "議題")], { currentTopic: "B", now: 100, ...extra });
// 済みの議題 A・A2 が続き、「議題 2 件」（run:A）にまとめられる
const bundled = (): Snapshot =>
  snap([node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点", { pointStatus: "未決" }), node("A2", "root", "議題", { talkStatus: "済み" }), node("B", "root", "議題")], {
    currentTopic: "B",
    now: 100,
  });
const HEIGHTS = { root: 40, A: 50, A1: 60, A2: 50, B: 70, "run:A": 50 };
const SIZE = { width: 800, height: 600 };
const NONE: ReadonlySet<string> = new Set();

const measuredModel = (snapshot: Snapshot, mode: MapSurfaceModel["mode"] = "live", viewing: ViewingState = INITIAL_VIEWING): MapSurfaceModel => ({
  ...init(snapshot, mode, false),
  size: Option.some(SIZE),
  nodeHeights: HashMap.make(...Object.entries(HEIGHTS)),
  viewing,
});
// 表示面の要素の Mount は毎回 resolve する。結果は大きさだけの測定（目標の位置は変わらない）
const mounted = Mount.resolve(ObserveMapSurface, Message.MeasuredMapSurface({ ...SIZE, nodeHeights: {} }));
const clickedNode = (nodeId: string) => Mount.resolve(ObserveMapSurface, Message.ClickedNodeButton({ nodeId, clientX: 0, clientY: 0 }));

const mapNodeOf = (id: string) => selector(`[data-node-id="${id}"] .map-node`);
const wrapperOf = (id: string) => selector(`[data-node-id="${id}"]`);
const bodyButtonOf = (id: string) => selector(`[data-node-id="${id}"] button.map-node__button`);
const countOf = (id: string) => selector(`[data-node-id="${id}"] .map-node__count`);
const pressableCountOf = (id: string) => selector(`[data-node-id="${id}"] button.map-node__count.map-node__count--pressable`);
const foldDotOf = (id: string) => selector(`[data-node-id="${id}"] button.map-node__fold-dot`);
const EDGE_DOT = selector("button.edge-dot");

const numbers = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
const styleOf = (vnode: VNode, name: string): string | undefined => (vnode.data?.style as Record<string, string> | undefined)?.[name];
const descendants = (vnode: VNode): VNode[] => [vnode, ...(vnode.children ?? []).flatMap((c) => (typeof c === "string" ? [] : descendants(c)))];
const viewportTransform = (html: VNode): number[] => {
  const viewports = descendants(html).filter((v) => styleOf(v, "transform")?.includes("scale(") === true);
  expect(viewports).toHaveLength(1);
  return numbers(styleOf(viewports[0]!, "transform")!);
};
const renderedIds = (html: VNode): string[] =>
  descendants(html).flatMap((v) => {
    const id = (v.data?.attrs as Record<string, unknown> | undefined)?.["data-node-id"];
    return typeof id === "string" ? [id] : [];
  });
const classOf = (vnode: VNode): string[] => Object.keys((vnode.data?.class as Record<string, boolean> | undefined) ?? {});

describe("mapSurface の Scene: ノード本体の click で選ぶ", () => {
  it("click する前は誰も選ばれていない（aria-pressed=false・map-node--selected なし）", () => {
    scene(
      app,
      given(measuredModel(single())),
      expectScene(mapNodeOf("B")).not.toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("B")).toHaveAttr("aria-pressed", "false"),
      mounted,
    );
  });

  it("click したノードだけが map-node--selected・aria-pressed=true になる", () => {
    scene(
      app,
      given(measuredModel(single())),
      clickedNode("B"),
      expectScene(mapNodeOf("B")).toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("B")).toHaveAttr("aria-pressed", "true"),
      expectScene(mapNodeOf("root")).not.toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("root")).toHaveAttr("aria-pressed", "false"),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("A")).toHaveAttr("aria-pressed", "false"),
    );
  });

  it("選んだ状態は viewing から描く: 選択を持つ Model では、その選択のノードだけが選ばれた見た目になる（選んだ畳んだ議題も選ばれた見た目）", () => {
    scene(
      app,
      given(measuredModel(single(), "live", { mode: "auto", selection: { id: "A", byKey: false } })),
      expectScene(mapNodeOf("A")).toHaveClass("map-node--selected"),
      expectScene(mapNodeOf("A")).toHaveClass("map-node--folded"),
      expectScene(bodyButtonOf("A")).toHaveAttr("aria-pressed", "true"),
      expectScene(mapNodeOf("B")).not.toHaveClass("map-node--selected"),
      mounted,
    );
  });

  it("まとめのノード（run:）は選べない: click しても選ばれた見た目にならない", () => {
    scene(
      app,
      given(measuredModel(bundled())),
      clickedNode("run:A"),
      expectScene(mapNodeOf("run:A")).not.toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("run:A")).toHaveAttr("aria-pressed", "false"),
      expectScene(mapNodeOf("B")).not.toHaveClass("map-node--selected"),
    );
  });

  it("選んだノードの祖先は畳まない: 畳んだ議題の子を選んでいる間は、その議題が開いて子が見える（foldView に選択を渡した木と同じノード・位置）", () => {
    const shown = foldView(single(), NONE, "A1", NONE, NONE);
    expect(shown.nodes.map((n) => n.id)).toContain("A1");
    const positions = layout(shown.nodes, HEIGHTS);
    scene(
      app,
      given(measuredModel(single(), "live", { mode: "auto", selection: { id: "A1", byKey: false } })),
      expectScene(wrapperOf("A1")).toExist(),
      expectScene(mapNodeOf("A1")).toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("A1")).toHaveAttr("aria-pressed", "true"),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--folded"),
      expectScene(countOf("A")).toBeAbsent(),
      // 選んだだけでは人が開いたことにならないので、畳む小さな丸は付かない
      expectScene(foldDotOf("A")).toBeAbsent(),
      tap((simulation) => {
        expect(renderedIds(simulation.html).sort()).toEqual(shown.nodes.map((n) => n.id).sort());
        for (const n of shown.nodes) {
          const wrapper = findAll(simulation.html, `[data-node-id="${n.id}"]`)[0]!;
          const [x, y] = numbers(styleOf(wrapper, "transform") ?? "");
          expect([x, y]).toEqual([positions[n.id]!.x, positions[n.id]!.y]);
        }
      }),
      mounted,
    );
  });

  it("still は選択を描かない（viewing に選択があっても、選ばれた見た目にならない）", () => {
    scene(
      app,
      given(measuredModel(single(), "still", { mode: "auto", selection: { id: "B", byKey: false } })),
      expectScene(mapNodeOf("B")).not.toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("B")).toHaveAttr("aria-pressed", "false"),
      mounted,
    );
  });
});

describe("mapSurface の Scene: 隠れた数の丸で開く・小さな丸で畳む", () => {
  it("畳んだ議題の隠れた数の丸は「開く」の button（map-node__count--pressable）で、隠れた数が書かれている。子は見えない", () => {
    const hidden = foldView(single(), NONE, null, NONE, NONE).folds["A"]!.hidden;
    scene(
      app,
      given(measuredModel(single())),
      expectScene(pressableCountOf("A")).toHaveAttr("aria-label", "開く"),
      expectScene(pressableCountOf("A")).toHaveText(String(hidden)),
      expectScene(wrapperOf("A1")).toBeAbsent(),
      // 畳んでいないノードに丸は無い
      expectScene(countOf("B")).toBeAbsent(),
      expectScene(foldDotOf("A")).toBeAbsent(),
      mounted,
    );
  });

  it("丸の要素は、ノード本体のボタンの後ろに並ぶ", () => {
    scene(
      app,
      given(measuredModel(single())),
      tap((simulation) => {
        const body = findAll(simulation.html, '[data-node-id="A"] .map-node')[0]!;
        const kids = (body.children ?? []).flatMap((c) => (typeof c === "string" ? [] : [c]));
        expect(kids.map((k) => k.sel)).toEqual(["button", "button"]);
        expect(classOf(kids[0]!)).toContain("map-node__button");
        expect(classOf(kids[1]!)).toContain("map-node__count--pressable");
      }),
      mounted,
    );
  });

  it("「開く」を押すと子が見え、A は畳んだ見た目でなくなり、隠れた数の丸の代わりに「畳む」の小さな丸が付く。「畳む」を押すと元の畳んだ見た目に戻る", () => {
    const hidden = foldView(single(), NONE, null, NONE, NONE).folds["A"]!.hidden;
    scene(
      app,
      given(measuredModel(single())),
      mounted,
      click(pressableCountOf("A")),
      expectScene(wrapperOf("A1")).toExist(),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--folded"),
      expectScene(countOf("A")).toBeAbsent(),
      expectScene(foldDotOf("A")).toHaveAttr("aria-label", "畳む"),
      // 本体の click と違い、丸を押しても A は選ばれない
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--selected"),
      click(foldDotOf("A")),
      expectScene(wrapperOf("A1")).toBeAbsent(),
      expectScene(mapNodeOf("A")).toHaveClass("map-node--folded"),
      expectScene(foldDotOf("A")).toBeAbsent(),
      expectScene(pressableCountOf("A")).toHaveText(String(hidden)),
    );
  });

  it("人が開いたノードにだけ「畳む」の小さな丸が付く。今の議題とその祖先・議題でも論点でもないノードには付かない", () => {
    scene(
      app,
      given(measuredModel(single(), "live", { mode: "auto", humanOpened: new Set(["A", "B", "root"]) })),
      expectScene(foldDotOf("A")).toExist(),
      expectScene(foldDotOf("B")).toBeAbsent(),
      expectScene(foldDotOf("root")).toBeAbsent(),
      expectScene(wrapperOf("A1")).toExist(),
      expectScene(foldDotOf("A1")).toBeAbsent(),
      mounted,
    );
  });

  it("人が開いていないノードに「畳む」の小さな丸は無い（開いているだけでは付かない）", () => {
    scene(
      app,
      given(measuredModel(single(), "live", { mode: "auto", humanOpened: new Set(["A"]) })),
      expectScene(foldDotOf("B")).toBeAbsent(),
      expectScene(foldDotOf("A1")).toBeAbsent(),
      mounted,
    );
  });

  it("人が畳んだ集合に入れた議題は、済みでなくても畳んだ見た目になり、「開く」の丸が付く", () => {
    scene(
      app,
      given(
        measuredModel(
          snap([node("root", null, "会議"), node("T", "root", "議題"), node("T1", "T", "論点", { pointStatus: "未決" }), node("B", "root", "議題")], { currentTopic: "B", now: 100 }),
          "live",
          { mode: "auto", humanFolded: new Set(["T"]) },
        ),
      ),
      expectScene(mapNodeOf("T")).toHaveClass("map-node--folded"),
      expectScene(pressableCountOf("T")).toHaveAttr("aria-label", "開く"),
      expectScene(wrapperOf("T1")).toBeAbsent(),
      mounted,
    );
  });

  it("still は畳まないので、丸は付かない（viewing に人が開いた集合があっても）", () => {
    scene(
      app,
      given(measuredModel(single(), "still", { mode: "auto", humanOpened: new Set(["A"]) })),
      expectScene(wrapperOf("A1")).toExist(),
      tap((simulation) => {
        expect(findAll(simulation.html, "button.map-node__count--pressable")).toHaveLength(0);
        expect(findAll(simulation.html, "button.map-node__fold-dot")).toHaveLength(0);
        expect(findAll(simulation.html, ".map-node__count")).toHaveLength(0);
      }),
      mounted,
    );
  });
});

describe("mapSurface の Scene: まとめのノード（議題 N 件）の丸で解く", () => {
  it("まとめのノードの丸は「開く」の button。押すと、まとめが解けて中の議題が畳んだまま並び、最初の議題が選ばれる", () => {
    scene(
      app,
      given(measuredModel(bundled())),
      mounted,
      expectScene(pressableCountOf("run:A")).toHaveAttr("aria-label", "開く"),
      expectScene(wrapperOf("A")).toBeAbsent(),
      click(pressableCountOf("run:A")),
      expectScene(wrapperOf("run:A")).toBeAbsent(),
      expectScene(wrapperOf("A")).toExist(),
      expectScene(wrapperOf("A2")).toExist(),
      // 中身は畳んだまま
      expectScene(mapNodeOf("A")).toHaveClass("map-node--folded"),
      expectScene(mapNodeOf("A2")).toHaveClass("map-node--folded"),
      expectScene(wrapperOf("A1")).toBeAbsent(),
      expectScene(mapNodeOf("A")).toHaveClass("map-node--selected"),
      expectScene(bodyButtonOf("A")).toHaveAttr("aria-pressed", "true"),
      expectScene(mapNodeOf("A2")).not.toHaveClass("map-node--selected"),
    );
  });
});

describe("mapSurface の Scene: 縁の点（画面の外で変わったノード）", () => {
  // A は畳まれ、中の論点 A1 が今回変わった → 点滅するのは見せている A。画面の外へパンして、A を画面の外に出す
  const changed = (): Snapshot => single({ changes: [{ change: "追加", node: "A1", kind: "論点", text: "A1", round: 3, at: 0 } as Snapshot["changes"][number]] });
  const panned = (viewing: ViewingState, mode: MapSurfaceModel["mode"] = "live", size = true): MapSurfaceModel => ({
    ...measuredModel(changed(), mode, viewing),
    viewport: { x: -3000, y: 0, zoom: 1 },
    ...(size ? {} : { size: Option.none<{ width: number; height: number }>() }),
  });
  const MANUAL: ViewingState = { mode: "manual", topic: "B" };
  const dotsOf = (html: VNode) => findAll(html, "button.edge-dot");

  // 期待する点: 画面に映っている viewport（DOM の transform）と、目標の位置・高さから、edgeDots が返す値
  const expectedDots = (html: VNode) => {
    const [x, y, zoom] = viewportTransform(html) as [number, number, number];
    const shown = foldView(changed(), NONE, null, NONE, NONE);
    const ids = shown.nodes.map((n) => n.id).filter((id) => shown.blink.has(id));
    expect(ids).toEqual(["A"]);
    return edgeDots(ids, layout(shown.nodes, HEIGHTS), { A: { height: HEIGHTS.A } }, { x, y, zoom }, SIZE);
  };

  it("自動のカメラのときは出ない", () => {
    scene(
      app,
      given(panned(INITIAL_VIEWING)),
      tap((simulation) => expect(dotsOf(simulation.html)).toHaveLength(0)),
      mounted,
    );
  });

  it("止めている（manual）間は、画面の外で変わったノードの点が出る。位置（left・top）と名前は edgeDots の値と同じ", () => {
    scene(
      app,
      given(panned(MANUAL)),
      tap((simulation) => {
        const expected = expectedDots(simulation.html);
        expect(expected.length).toBeGreaterThan(0);
        const dots = dotsOf(simulation.html);
        expect(dots).toHaveLength(expected.length);
        dots.forEach((dot, i) => {
          expect(numbers(styleOf(dot, "left") ?? "")).toEqual([expected[i]!.x]);
          expect(numbers(styleOf(dot, "top") ?? "")).toEqual([expected[i]!.y]);
          expect(Option.getOrUndefined(attr(dot, "aria-label"))).toBe(`画面の外で変わったノードへ寄る（${expected[i]!.ids.length} 件）`);
        });
      }),
      expectScene(EDGE_DOT).toHaveClass("nopan"),
      expectScene(EDGE_DOT).toHaveClass("nowheel"),
      mounted,
    );
  });

  it("全体を見ている（overview）間も出る", () => {
    scene(
      app,
      given(panned({ mode: "overview", topic: "B" })),
      tap((simulation) => expect(dotsOf(simulation.html)).toHaveLength(expectedDots(simulation.html).length)),
      mounted,
    );
  });

  it("画面に映っているノードの点は出ない（パンしていなければ、変わった A は画面の中）", () => {
    scene(
      app,
      given({ ...panned(MANUAL), viewport: { x: 0, y: 0, zoom: 1 } }),
      tap((simulation) => expect(dotsOf(simulation.html)).toHaveLength(0)),
      mounted,
    );
  });

  it("still は点を描かない（viewing が manual でも）", () => {
    scene(
      app,
      given(panned(MANUAL, "still")),
      tap((simulation) => expect(dotsOf(simulation.html)).toHaveLength(0)),
      mounted,
    );
  });

  it("画面の大きさが分かるまでは描かない", () => {
    scene(
      app,
      given(panned(MANUAL, "live", false)),
      tap((simulation) => expect(dotsOf(simulation.html)).toHaveLength(0)),
      mounted,
    );
  });

  it("点を押すと、そのノードへ寄る（今の倍率のまま、ノードの中心が画面の中央に来る viewport の transform になる）。畳んだ A を開くことはない（丸とは別の操作）", () => {
    // 寄せ先は、目標の位置と高さで測った A。倍率は押す前のまま（1）
    const shown = foldView(changed(), NONE, null, NONE, NONE);
    const expected = nodeFocusViewport(nodeRect("A", layout(shown.nodes, HEIGHTS), { A: { height: HEIGHTS.A } }), 1, SIZE);
    let before: number[] = [];
    scene(
      app,
      given(panned(MANUAL)),
      mounted,
      tap((simulation) => {
        before = viewportTransform(simulation.html);
      }),
      click(EDGE_DOT),
      tap((simulation) => {
        expect(viewportTransform(simulation.html)).not.toEqual(before);
        const [x, y, zoom] = viewportTransform(simulation.html);
        expect(x).toBeCloseTo(expected.x, 6);
        expect(y).toBeCloseTo(expected.y, 6);
        expect(zoom).toBeCloseTo(expected.zoom, 6);
        // 寄せた先では A が画面に映るので、点はもう出ない
        expect(dotsOf(simulation.html)).toHaveLength(0);
      }),
      expectScene(wrapperOf("A1")).toBeAbsent(),
      expectScene(mapNodeOf("A")).toHaveClass("map-node--folded"),
      expectScene(mapNodeOf("A")).not.toHaveClass("map-node--selected"),
    );
  });
});
