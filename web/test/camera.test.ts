import { describe, expect, it } from "vitest";
import type { ChangeEntry, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import {
  OVERVIEW_MIN_ZOOM,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  cameraFocus,
  clampUserZoom,
  focusViewport,
  nodeRect,
  overviewViewport,
  panViewport,
  shouldMoveCamera,
  zoomAroundCenter,
} from "../src/camera.ts";
import { NODE_WIDTH } from "../src/layout.ts";

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題"): SnapshotNode => ({
  id,
  parent,
  kind,
  text: id,
  evidence: parent ? ["r1"] : [],
});

const change = (n: string, round: number): ChangeEntry => ({ change: "追加", node: n, round, at: round }) as ChangeEntry;

// root > A(議題) > B(議題) > C(議題) > D(議題: 今の議題) > D1(論点) > D2(案)。A の下に論点 P、root の下に別の議題 Z
const nodes = (): SnapshotNode[] => [
  node("root", null, "会議"),
  node("A", "root"),
  node("P", "A", "論点"),
  node("B", "A"),
  node("C", "B"),
  node("D", "C"),
  node("D1", "D", "論点"),
  node("D2", "D1", "案"),
  node("Z", "root"),
];

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  nodes: nodes(),
  round: 1,
  changes: [],
  remarks: [],
  currentTopic: "D",
  ...over,
});

describe("cameraFocus: 寄せ先", () => {
  it("今の議題・入れ子の深さに関係なく全ての祖先の議題・今の議題の子孫が入る", () => {
    const focus = cameraFocus(snap())!;
    expect(new Set(focus.ids)).toEqual(new Set(["A", "B", "C", "D", "D1", "D2"]));
  });

  it("ルートと、祖先の議題以外のノード（祖先の論点の兄弟・別の議題）は入らない", () => {
    const ids = cameraFocus(snap())!.ids;
    expect(ids).not.toContain("root");
    expect(ids).not.toContain("P");
    expect(ids).not.toContain("Z");
  });

  it("今の議題が無い、またはノードに無いときは null", () => {
    const { currentTopic: _omit, ...without } = snap();
    expect(cameraFocus(without as Snapshot)).toBeNull();
    expect(cameraFocus(snap({ currentTopic: "gone" }))).toBeNull();
  });

  it("中心は、今の反映で最後に変わったノード（lastChanged）。寄せ先の中でも外でもよい。無ければ今の議題", () => {
    expect(cameraFocus(snap({ lastChanged: "D1" }))!.center).toBe("D1");
    expect(cameraFocus(snap({ lastChanged: "Z" }))!.center).toBe("Z");
    expect(cameraFocus(snap())!.center).toBe("D");
  });

  it("寄せ先が下限でも収まらないとき、寄せ先の外の最後に変わったノードが 0.75 倍で画面の中央に来る", () => {
    const target: Record<string, { x: number; y: number }> = {
      A: { x: 0, y: 0 }, B: { x: 0, y: 0 }, C: { x: 0, y: 0 }, D: { x: 0, y: 0 }, D1: { x: 0, y: 0 }, D2: { x: 8000, y: 5000 },
      Z: { x: 3000, y: 2000 },
    };
    const focus = cameraFocus(snap({ lastChanged: "Z" }))!;
    const rects = focus.ids.map((id) => nodeRect(id, target, {}));
    const v = focusViewport(rects, nodeRect(focus.center, target, {}), size);
    const z = nodeRect("Z", target, {});
    expect(v.zoom).toBeCloseTo(0.75);
    expect((z.x + z.width / 2) * v.zoom + v.x).toBeCloseTo(size.width / 2);
    expect((z.y + z.height / 2) * v.zoom + v.y).toBeCloseTo(size.height / 2);
  });
});

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const size = { width: 1920, height: 1080 };

// ビューポートの変換で、矩形が画面に収まっているか
const fits = (r: ReturnType<typeof rect>, v: { x: number; y: number; zoom: number }) =>
  r.x * v.zoom + v.x >= 0 &&
  r.y * v.zoom + v.y >= 0 &&
  (r.x + r.width) * v.zoom + v.x <= size.width &&
  (r.y + r.height) * v.zoom + v.y <= size.height;

describe("focusViewport: 倍率と中心", () => {
  it("小さな寄せ先は上限 1.1 倍で、画面の中央に映る", () => {
    const r = rect(100, 100, 200, 100);
    const v = focusViewport([r], r, size);
    expect(v.zoom).toBeCloseTo(1.1);
    expect((r.x + r.width / 2) * v.zoom + v.x).toBeCloseTo(size.width / 2);
    expect((r.y + r.height / 2) * v.zoom + v.y).toBeCloseTo(size.height / 2);
  });

  it("上限と下限の間では全体が収まる倍率になる（0.75〜1.1）", () => {
    const r = rect(0, 0, 2200, 800); // 幅 1920 に余白込みで収めると 0.75 より大きく 1.1 より小さい
    const v = focusViewport([r], r, size);
    expect(v.zoom).toBeGreaterThan(0.75);
    expect(v.zoom).toBeLessThan(1.1);
    expect(fits(r, v)).toBe(true);
  });

  it("下限 0.75 でも収まらないときは 0.75 倍で、中心のノードが画面の中央に来る", () => {
    const rects = [rect(0, 0, 200, 40), rect(5000, 3000, 200, 40)];
    const center = rects[1]!;
    const v = focusViewport(rects, center, size);
    expect(v.zoom).toBeCloseTo(0.75);
    expect((center.x + center.width / 2) * v.zoom + v.x).toBeCloseTo(size.width / 2);
    expect((center.y + center.height / 2) * v.zoom + v.y).toBeCloseTo(size.height / 2);
  });
});

describe("shouldMoveCamera: 何も変わらない反映ではカメラを動かさない", () => {
  it("まだ寄せていない（null）ときは動かす", () => {
    expect(shouldMoveCamera(snap({ round: 1, changes: [change("D1", 1)] }), null)).toBe(true);
  });

  it("同じ寄せ済みの状態を保ったまま、変更のある round → 変更の無い次の round → 同じ round の測り直し、と続ける", () => {
    let placed: number | null = null;
    const step = (s: Snapshot) => {
      const move = shouldMoveCamera(s, placed);
      if (move) placed = s.round;
      return move;
    };
    const changed = [change("D1", 1)];
    expect(step(snap({ round: 1, changes: changed }))).toBe(true); // 変更のある round: 寄せる
    expect(step(snap({ round: 1, changes: changed }))).toBe(true); // 同じ round で実寸を測り直し: 寄せ直す
    expect(step(snap({ round: 2, changes: changed }))).toBe(false); // 何も変わらない round: 動かさない
    expect(step(snap({ round: 3, changes: changed }))).toBe(false); // さらに続けても動かさない
    expect(step(snap({ round: 3, changes: [...changed, change("D2", 3)] }))).toBe(true); // 変更のある round: 寄せる
  });

  it("changes に載らない変更（lastChanged のみ）でも、次の round ではカメラを動かす", () => {
    const changes = [change("D1", 1)];
    expect(shouldMoveCamera(snap({ round: 2, changes, lastChanged: "D2" }), 1)).toBe(true);
    expect(shouldMoveCamera(snap({ round: 2, changes }), 1)).toBe(false);
  });
});

describe("clampUserZoom: 人の倍率は 0.5〜2 倍", () => {
  it("範囲の外は端に収め、中は変えない", () => {
    expect(USER_MIN_ZOOM).toBe(0.5);
    expect(USER_MAX_ZOOM).toBe(2);
    expect(clampUserZoom(2 * 1.25)).toBe(2);
    expect(clampUserZoom(0.5 / 1.25)).toBe(0.5);
    expect(clampUserZoom(0.02 * 1.25)).toBe(0.5);
    expect(clampUserZoom(1.25)).toBe(1.25);
  });
});

// 画面中心のワールド座標
const centerOf = (v: { x: number; y: number; zoom: number }) => ({ x: (size.width / 2 - v.x) / v.zoom, y: (size.height / 2 - v.y) / v.zoom });

describe("zoomAroundCenter: 画面の中心を保って倍率を変える", () => {
  it("拡大・縮小・倍率 1.0 のどれでも、変える前と同じワールド座標が画面の中心に残る", () => {
    const before = { x: -300, y: 120, zoom: 0.8 };
    for (const zoom of [1, 1.25, 0.64]) {
      const after = zoomAroundCenter(before, zoom, size);
      expect(after.zoom).toBeCloseTo(zoom);
      expect(centerOf(after).x).toBeCloseTo(centerOf(before).x);
      expect(centerOf(after).y).toBeCloseTo(centerOf(before).y);
    }
  });
});

describe("panViewport: 画面の 1/3 ずつ移動する", () => {
  const v = { x: 100, y: 50, zoom: 1.3 };

  it("→ なら右側が見えてくるよう x が width/3 減る。y と zoom は変わらない", () => {
    expect(panViewport(v, { dx: 1, dy: 0 }, size)).toEqual({ x: 100 - size.width / 3, y: 50, zoom: 1.3 });
  });

  it("← は x が width/3 増える", () => {
    expect(panViewport(v, { dx: -1, dy: 0 }, size)).toEqual({ x: 100 + size.width / 3, y: 50, zoom: 1.3 });
  });

  it("↓ なら下側が見えてくるよう y が height/3 減り、↑ は増える", () => {
    expect(panViewport(v, { dx: 0, dy: 1 }, size)).toEqual({ x: 100, y: 50 - size.height / 3, zoom: 1.3 });
    expect(panViewport(v, { dx: 0, dy: -1 }, size)).toEqual({ x: 100, y: 50 + size.height / 3, zoom: 1.3 });
  });
});

describe("overviewViewport: 全体を目標の位置で収める", () => {
  const dims = { a: { height: 40 }, b: { height: 40 } };

  it("渡した目標の位置の外接箱が画面に収まり、箱の中心が画面の中央に来る", () => {
    const target = { a: { x: 0, y: 0 }, b: { x: 3000, y: 1600 } };
    const v = overviewViewport(["a", "b"], target, dims, size)!;
    const left = 0, top = 0, right = 3000 + NODE_WIDTH, bottom = 1600 + 40;
    expect(fits(rect(left, top, right - left, bottom - top), v)).toBe(true);
    expect(v.zoom).toBeLessThan(1);
    expect(((left + right) / 2) * v.zoom + v.x).toBeCloseTo(size.width / 2);
    expect(((top + bottom) / 2) * v.zoom + v.y).toBeCloseTo(size.height / 2);
  });

  it("補間中の位置ではなく、渡した目標の位置で測る（目標だけが違う入力で結果が違う）", () => {
    const near = overviewViewport(["a", "b"], { a: { x: 0, y: 0 }, b: { x: 400, y: 200 } }, dims, size)!;
    const far = overviewViewport(["a", "b"], { a: { x: 0, y: 0 }, b: { x: 4000, y: 2400 } }, dims, size)!;
    expect(far.zoom).toBeLessThan(near.zoom);
  });

  it("人の下限 0.5 を守らず、全体が収まるまで縮める（下限は 0.02）", () => {
    const target = { a: { x: 0, y: 0 }, b: { x: 20000, y: 12000 } };
    const v = overviewViewport(["a", "b"], target, dims, size)!;
    expect(OVERVIEW_MIN_ZOOM).toBe(0.02);
    expect(v.zoom).toBeLessThan(USER_MIN_ZOOM);
    expect(v.zoom).toBeGreaterThanOrEqual(OVERVIEW_MIN_ZOOM);
    expect(fits(rect(0, 0, 20000 + NODE_WIDTH, 12040), v)).toBe(true);
  });

  it("小さな全体でも人の上限 2 倍を超えない", () => {
    const v = overviewViewport(["a"], { a: { x: 10, y: 10 } }, dims, size)!;
    expect(v.zoom).toBeLessThanOrEqual(USER_MAX_ZOOM);
  });

  it("見せる id だけで測る（targets にある別のノードは含めない）", () => {
    const target = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, far: { x: 30000, y: 20000 } };
    const only = overviewViewport(["a", "b"], target, dims, size)!;
    const withFar = overviewViewport(["a", "b", "far"], target, dims, size)!;
    expect(only.zoom).toBeGreaterThan(withFar.zoom);
  });

  it("見せるノードがなければ null", () => {
    expect(overviewViewport([], {}, {}, size)).toBeNull();
  });
});
