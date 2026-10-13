import { getViewportForBounds } from "./fixtures/xyflowReference.ts";
import { findAll, given, Mount, scene, tap } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import { CAPTURE_OVERFLOW_ATTRIBUTE, CAPTURE_READY_ATTRIBUTE } from "../../server/src/core/capture.ts";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init, update, view } from "../src/app/capture/main.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { layout, NODE_WIDTH } from "../src/layout.ts";
import type { VNode } from "./sceneTree.ts";

// 撮影（map.png）の Foldkit プログラム（Issue #827）の Scene。描いた view から入り、表示面を実測で解いて、ready / overflow の属性と、静止した 1 枚の中身を見る。
// 比べる相手は @xyflow の getViewportForBounds（全体を収める式。撮影の下限 0.02）と、server が共有する属性名（server/src/core/capture.ts）


const node = (id: string, parent: string | null, kind: SnapshotNode["kind"], text: string, extra: Partial<SnapshotNode> = {}): SnapshotNode => ({
  id,
  parent,
  kind,
  text,
  evidence: parent ? ["r1"] : [],
  ...extra,
});
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 3, changes: [], remarks: [], ...extra });

const nodes = (): SnapshotNode[] => [
  node("root", null, "会議", "定例"),
  node("A", "root", "議題", "予算"),
  node("P", "A", "論点", "上限をどうするか", { pointStatus: "未決" }),
  node("D", "A", "案", "月額制", { planStatus: "却下" }),
];
const HEIGHTS = { root: 40, A: 64, P: 88, D: 52 };
const SIZE = { width: 800, height: 600 };

const app = { update, view };
const measured = (nodeHeights: Record<string, number>, size = SIZE) => Mount.resolve(ObserveMapSurface, MapSurfaceMessage.MeasuredMapSurface({ ...size, nodeHeights }));

const attributeCount = (html: VNode, name: string): number => findAll(html, `[${name}]`).length;
const expectNoCaptureAttribute = (html: VNode) => {
  expect(attributeCount(html, CAPTURE_READY_ATTRIBUTE)).toBe(0);
  expect(attributeCount(html, CAPTURE_OVERFLOW_ATTRIBUTE)).toBe(0);
};
const viewportTransforms = (html: VNode): number[][] =>
  findAll(html, ".map-viewport").map((v) => ((v.data?.style as Record<string, string> | undefined)?.transform ?? "").match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)?.map(Number) ?? []);

describe("撮影の Scene: ready / overflow の属性", () => {
  it("属性の名前は server と共有する名前そのもの（data-capture-ready / data-capture-overflow）", () => {
    expect(CAPTURE_READY_ATTRIBUTE).toBe("data-capture-ready");
    expect(CAPTURE_OVERFLOW_ATTRIBUTE).toBe("data-capture-overflow");
  });

  it("実測の前は、ready も overflow も付かない", () => {
    scene(
      app,
      given(init(snap(nodes()))),
      Mount.expectExact(ObserveMapSurface),
      tap((simulation) => expectNoCaptureAttribute(simulation.html)),
      measured(HEIGHTS),
    );
  });

  it("画面の大きさだけ分かって、ノードが 1 つも測れていない間は、付かない", () => {
    scene(
      app,
      given(init(snap(nodes()))),
      measured({}),
      tap((simulation) => expectNoCaptureAttribute(simulation.html)),
    );
  });

  it("一部のノードしか測れていない間は、付かない（全ノードが測られるまで待つ）", () => {
    scene(
      app,
      given(init(snap(nodes()))),
      measured({ root: HEIGHTS.root, A: HEIGHTS.A }),
      tap((simulation) => expectNoCaptureAttribute(simulation.html)),
    );
  });

  it("全ノードが測られて全体が画面に入れば、ready だけが付く", () => {
    scene(
      app,
      given(init(snap(nodes()))),
      measured(HEIGHTS),
      tap((simulation) => {
        expect(attributeCount(simulation.html, CAPTURE_READY_ATTRIBUTE)).toBe(1);
        expect(attributeCount(simulation.html, CAPTURE_OVERFLOW_ATTRIBUTE)).toBe(0);
      }),
    );
  });

  it("ready のときの viewport は、全体を下限 0.02 で収めた値（getViewportForBounds）と一致する", () => {
    const all = nodes();
    const positions = layout(all, HEIGHTS);
    const rects = all.map((n) => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: HEIGHTS[n.id as keyof typeof HEIGHTS] }));
    const left = Math.min(...rects.map((r) => r.x));
    const top = Math.min(...rects.map((r) => r.y));
    const bounds = { x: left, y: top, width: Math.max(...rects.map((r) => r.x + r.width)) - left, height: Math.max(...rects.map((r) => r.y + r.height)) - top };
    const expected = getViewportForBounds(bounds, SIZE.width, SIZE.height, 0.02, 2, 0.1);
    scene(
      app,
      given(init(snap(all))),
      measured(HEIGHTS),
      tap((simulation) => {
        const transforms = viewportTransforms(simulation.html);
        expect(transforms).toHaveLength(1);
        [expected.x, expected.y, expected.zoom].forEach((value, i) => expect(transforms[0]![i]).toBeCloseTo(value, 6));
      }),
    );
  });

  it("下限 0.02 まで縮めても全体が入らないときは、ready ではなく overflow だけが付く", () => {
    const tall = [node("root", null, "会議", "定例"), node("A", "root", "議題", "予算")];
    scene(
      app,
      given(init(snap(tall))),
      measured({ root: 40, A: 100000 }),
      tap((simulation) => {
        expect(attributeCount(simulation.html, CAPTURE_OVERFLOW_ATTRIBUTE)).toBe(1);
        expect(attributeCount(simulation.html, CAPTURE_READY_ATTRIBUTE)).toBe(0);
      }),
    );
  });

  it("ノードが 0 件のスナップショットは、画面の大きさが分かれば ready になる", () => {
    scene(
      app,
      given(init(snap([]))),
      measured({}),
      tap((simulation) => {
        expect(attributeCount(simulation.html, CAPTURE_READY_ATTRIBUTE)).toBe(1);
        expect(attributeCount(simulation.html, CAPTURE_OVERFLOW_ATTRIBUTE)).toBe(0);
      }),
    );
  });
});

describe("撮影の Scene: 静止した 1 枚（強調・丸・選択を描かない）", () => {
  const changed = (): Snapshot =>
    snap(
      [
        node("root", null, "会議", "定例"),
        node("A", "root", "議題", "予算", { talkStatus: "済み" }),
        node("A1", "A", "論点", "済みの議題の中の論点", { pointStatus: "未決" }),
        node("P", "A", "論点", "上限をどうするか", { pointStatus: "未決" }),
        node("D", "A", "案", "月額制", { planStatus: "却下" }),
      ],
      { currentTopic: "A", changes: [{ round: 3, at: 30, change: "追加", node: "P", kind: "論点", text: "上限をどうするか" }] },
    );
  const HEIGHTS_CHANGED = { root: 40, A: 64, A1: 60, P: 88, D: 52 };

  it("最新の反映で変わったノードがあっても、点滅のクラスは付かず、済みの議題も畳まずに全ノードを描く", () => {
    scene(
      app,
      given(init(changed())),
      measured(HEIGHTS_CHANGED),
      tap((simulation) => {
        expect(findAll(simulation.html, ".map-node--blink")).toHaveLength(0);
        expect(findAll(simulation.html, ".map-node--folded")).toHaveLength(0);
        expect(findAll(simulation.html, ".map-node--selected")).toHaveLength(0);
        expect(findAll(simulation.html, ".map-node__count")).toHaveLength(0);
        expect(findAll(simulation.html, ".map-node-slot")).toHaveLength(5);
        for (const id of Object.keys(HEIGHTS_CHANGED)) expect(findAll(simulation.html, `[data-node-id="${id}"]`)).toHaveLength(1);
        expect(attributeCount(simulation.html, CAPTURE_READY_ATTRIBUTE)).toBe(1);
      }),
    );
  });

  it("仮のノード・右の列・待機の表示は描かない", () => {
    scene(
      app,
      given(init(changed())),
      measured(HEIGHTS_CHANGED),
      tap((simulation) => {
        for (const selector of [".draft-node", ".side", ".waiting", ".map-node__fold-dot"]) expect(findAll(simulation.html, selector), selector).toHaveLength(0);
        expect(findAll(simulation.html, ".capture")).toHaveLength(1);
        expect(findAll(simulation.html, ".map-surface")).toHaveLength(1);
      }),
    );
  });
});
