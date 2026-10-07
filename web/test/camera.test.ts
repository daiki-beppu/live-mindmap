import { describe, expect, it } from "vitest";
import type { ChangeEntry, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import {
  CLICK_ZOOM_FACTOR,
  OVERVIEW_MIN_ZOOM,
  SCROLL_AXIS_RESET_MS,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  cameraFocus,
  clampUserZoom,
  edgeDots,
  focusViewport,
  nodeFocusViewport,
  nodeRect,
  overviewViewport,
  panViewport,
  scrollAlongAxis,
  scrollAxis,
  shiftIntoView,
  shouldMoveCamera,
  zoomAroundCenter,
  zoomAtPoint,
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

// 画面上の点が指すワールド座標
const worldAt = (v: { x: number; y: number; zoom: number }, p: { x: number; y: number }) => ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom });

describe("zoomAtPoint: 押した点を中心に倍率を変える", () => {
  const point = { x: 640, y: 210 };

  it("クリックの倍率は 1.5 倍", () => {
    expect(CLICK_ZOOM_FACTOR).toBe(1.5);
  });

  it("拡大でも縮小でも、押した点のワールド座標は画面上の同じ位置に残り、倍率は factor 倍になる", () => {
    const before = { x: -300, y: 120, zoom: 0.8 };
    for (const factor of [CLICK_ZOOM_FACTOR, 1 / CLICK_ZOOM_FACTOR]) {
      const after = zoomAtPoint(before, point, factor);
      expect(after.zoom).toBeCloseTo(0.8 * factor);
      expect(worldAt(after, point).x).toBeCloseTo(worldAt(before, point).x);
      expect(worldAt(after, point).y).toBeCloseTo(worldAt(before, point).y);
    }
  });

  it("上限を超える拡大は 2 倍に収め、そのときも押した点は動かない", () => {
    const before = { x: 50, y: -40, zoom: 1.5 };
    const after = zoomAtPoint(before, point, 1.5);
    expect(after.zoom).toBe(USER_MAX_ZOOM);
    expect(worldAt(after, point).x).toBeCloseTo(worldAt(before, point).x);
    expect(worldAt(after, point).y).toBeCloseTo(worldAt(before, point).y);
  });

  it("下限を超える縮小は 0.5 倍に収め、そのときも押した点は動かない", () => {
    const before = { x: 50, y: -40, zoom: 0.6 };
    const after = zoomAtPoint(before, point, 1 / 1.5);
    expect(after.zoom).toBe(USER_MIN_ZOOM);
    expect(worldAt(after, point).x).toBeCloseTo(worldAt(before, point).x);
    expect(worldAt(after, point).y).toBeCloseTo(worldAt(before, point).y);
  });

  it("すでに端の倍率なら、さらに拡大・縮小しても全体が動かない", () => {
    const max = { x: 10, y: 20, zoom: USER_MAX_ZOOM };
    expect(zoomAtPoint(max, point, 1.5)).toEqual(max);
    const min = { x: 10, y: 20, zoom: USER_MIN_ZOOM };
    expect(zoomAtPoint(min, point, 1 / 1.5)).toEqual(min);
  });

  it("全体を見ている倍率（0.5 未満）からの拡大は、0.5 倍以上に収まり、押した点は動かない", () => {
    const before = { x: 5, y: 5, zoom: 0.1 };
    const after = zoomAtPoint(before, point, 1.5);
    expect(after.zoom).toBe(USER_MIN_ZOOM);
    expect(worldAt(after, point).x).toBeCloseTo(worldAt(before, point).x);
  });
});

describe("scrollAxis: スクロールで動かす軸は、動かし始めの大きい方で決める", () => {
  it("最初は、大きい方の軸になる", () => {
    expect(scrollAxis(null, 1000, { x: 30, y: 5 }).axis).toBe("x");
    expect(scrollAxis(null, 1000, { x: 5, y: -30 }).axis).toBe("y");
    expect(scrollAxis(null, 1000, { x: -30, y: 5 }).axis).toBe("x");
  });

  it("前回から 250ms 未満なら、反対の軸の量が大きくなっても軸を保つ。250ms 以上空くと決め直す", () => {
    expect(SCROLL_AXIS_RESET_MS).toBe(250);
    let lock = scrollAxis(null, 1000, { x: 2, y: 20 });
    expect(lock.axis).toBe("y");
    lock = scrollAxis(lock, 1100, { x: 50, y: 1 });
    expect(lock.axis).toBe("y");
    lock = scrollAxis(lock, 1100 + SCROLL_AXIS_RESET_MS - 1, { x: 50, y: 1 });
    expect(lock.axis).toBe("y");
    lock = scrollAxis(lock, 1100 + 2 * SCROLL_AXIS_RESET_MS - 1 + 1, { x: 50, y: 1 });
    expect(lock.axis).toBe("x");
  });

  it("間隔は、最初の入力ではなく前回の入力から測る（続けて動かしている間は決め直さない）", () => {
    let lock = scrollAxis(null, 0, { x: 0, y: 10 });
    for (const at of [200, 400, 600, 800]) lock = scrollAxis(lock, at, { x: 40, y: 0 });
    expect(lock.axis).toBe("y");
    expect(lock.at).toBe(800);
  });

  it("ちょうど 250ms 空いたら決め直す。249ms なら保つ", () => {
    const lock = scrollAxis(null, 0, { x: 0, y: 10 });
    expect(scrollAxis(lock, 249, { x: 40, y: 0 }).axis).toBe("y");
    expect(scrollAxis(lock, 250, { x: 40, y: 0 }).axis).toBe("x");
  });

  it("決め直しでは、そのときの大きい方の軸になる（x から y へも）", () => {
    const lock = scrollAxis(null, 0, { x: 10, y: 0 });
    expect(scrollAxis(lock, 500, { x: 1, y: 40 }).axis).toBe("y");
  });
});

describe("scrollAlongAxis: 決まった軸だけを動かす", () => {
  const v = { x: 100, y: 50, zoom: 1.3 };

  it("x 軸なら x だけが動き、y と zoom は変わらない（正の量で右側が見えてくる）", () => {
    expect(scrollAlongAxis(v, "x", { x: 30, y: 4 })).toEqual({ x: 70, y: 50, zoom: 1.3 });
  });

  it("y 軸なら y だけが動き、x と zoom は変わらない（正の量で下側が見えてくる）", () => {
    expect(scrollAlongAxis(v, "y", { x: 4, y: 30 })).toEqual({ x: 100, y: 20, zoom: 1.3 });
    expect(scrollAlongAxis(v, "y", { x: 4, y: -30 })).toEqual({ x: 100, y: 80, zoom: 1.3 });
  });

  it("量は deltaX・deltaY の大きい方を使う（Shift で deltaX に入れ替わった縦ホイールでも動く）", () => {
    expect(scrollAlongAxis(v, "y", { x: 40, y: 0 })).toEqual({ x: 100, y: 10, zoom: 1.3 });
    expect(scrollAlongAxis(v, "x", { x: 0, y: -40 })).toEqual({ x: 140, y: 50, zoom: 1.3 });
  });
});

const IDENTITY = { x: 0, y: 0, zoom: 1 };
const at = (x: number, y: number) => ({ n: { x, y } });
const centerScreen = { x: size.width / 2, y: size.height / 2 };

describe("edgeDots: 画面の外で変わったノードを、その方向の縁に点で出す", () => {
  it("右・左・下・上の外にあるノードは、それぞれの縁の側に出る", () => {
    const cases = [
      ["right", at(3000, 500)],
      ["left", at(-3000, 500)],
      ["bottom", at(900, 3000)],
      ["top", at(900, -3000)],
    ] as const;
    for (const [side, target] of cases) {
      const dots = edgeDots(["n"], target, {}, IDENTITY, size);
      expect(dots).toHaveLength(1);
      expect(dots[0]!.side).toBe(side);
      expect(dots[0]!.id).toBe("n");
      expect(dots[0]!.ids).toEqual(["n"]);
    }
  });

  it("点は縁の近く（画面の内側）にあり、画面の中心からノードの中心へ向かう線の上にある", () => {
    const [dot] = edgeDots(["n"], at(3000, 500), {}, IDENTITY, size);
    expect(dot!.x).toBeLessThanOrEqual(size.width);
    expect(dot!.x).toBeGreaterThan(size.width - 40);
    const nodeCenter = { x: 3000 + NODE_WIDTH / 2, y: 500 + 20 };
    const slope = (nodeCenter.y - centerScreen.y) / (nodeCenter.x - centerScreen.x);
    expect((dot!.y - centerScreen.y) / (dot!.x - centerScreen.x)).toBeCloseTo(slope, 5);

    const [top] = edgeDots(["n"], at(900, -3000), {}, IDENTITY, size);
    expect(top!.y).toBeGreaterThanOrEqual(0);
    expect(top!.y).toBeLessThan(40);
  });

  it("画面と少しでも重なるノードには点を出さない。外へ動かすと出る（対照）", () => {
    expect(edgeDots(["n"], at(100, 100), {}, IDENTITY, size)).toEqual([]);
    // 右の端が 2000 で、画面の右端 1920 をまたぐ
    expect(edgeDots(["n"], at(1800, 500), {}, IDENTITY, size)).toEqual([]);
    expect(edgeDots(["n"], at(1930, 500), {}, IDENTITY, size)).toHaveLength(1);
    // 中心は左の外（-50）だが、右の端 50 が見えている
    expect(edgeDots(["n"], at(-150, 500), {}, IDENTITY, size)).toEqual([]);
    expect(edgeDots(["n"], at(-250, 500), {}, IDENTITY, size)).toHaveLength(1);
  });

  it("ids が空なら点は無い", () => {
    expect(edgeDots([], at(3000, 500), {}, IDENTITY, size)).toEqual([]);
  });

  it("近い 2 つのノードは 1 つの点にまとまり、ids に両方が入る。点の id は画面の中心に近い方", () => {
    const target = { far: { x: 3010, y: 500 }, near: { x: 3000, y: 500 } };
    const dots = edgeDots(["far", "near"], target, {}, IDENTITY, size);
    expect(dots).toHaveLength(1);
    expect([...dots[0]!.ids].sort()).toEqual(["far", "near"]);
    expect(dots[0]!.id).toBe("near");
  });

  it("離れた 2 つのノードは 2 つの点になる（同じ縁でも、別の縁でも）", () => {
    const sameSide = edgeDots(["a", "b"], { a: { x: 3000, y: 100 }, b: { x: 3000, y: 1000 } }, {}, IDENTITY, size);
    expect(sameSide).toHaveLength(2);
    expect(sameSide.every((d) => d.ids.length === 1)).toBe(true);
    const otherSide = edgeDots(["a", "b"], { a: { x: 3000, y: 500 }, b: { x: -3000, y: 500 } }, {}, IDENTITY, size);
    expect(otherSide.map((d) => d.side).sort()).toEqual(["left", "right"]);
  });

  it("同じ入力なら同じ結果で、ids の並びに依らない", () => {
    const target = { a: { x: 3000, y: 100 }, b: { x: 3010, y: 100 }, c: { x: -3000, y: 100 } };
    expect(edgeDots(["a", "b", "c"], target, {}, IDENTITY, size)).toEqual(edgeDots(["c", "b", "a"], target, {}, IDENTITY, size));
  });

  it("ビューポートだけを変えると、点の有無と位置が変わる", () => {
    const target = at(3000, 500);
    const base = edgeDots(["n"], target, {}, IDENTITY, size);
    expect(base[0]!.side).toBe("right");
    // 右へ動かすとノードが画面の中へ来る
    expect(edgeDots(["n"], target, {}, { x: -2500, y: 0, zoom: 1 }, size)).toEqual([]);
    // 縮小しても画面の中へ来る（3000 × 0.5 = 1500）
    expect(edgeDots(["n"], target, {}, { x: 0, y: 0, zoom: 0.5 }, size)).toEqual([]);
    // 上へ動かすと、点が上へ寄る
    const up = edgeDots(["n"], target, {}, { x: 0, y: -400, zoom: 1 }, size);
    expect(up[0]!.side).toBe("right");
    expect(up[0]!.y).toBeLessThan(base[0]!.y);
    // さらに右へ動かして左の外へ出すと、左の縁になる
    expect(edgeDots(["n"], target, {}, { x: -5000, y: 0, zoom: 1 }, size)[0]!.side).toBe("left");
  });

  it("目標の大きさ（dims の高さ）で、画面の中かどうかが変わる", () => {
    const target = at(900, -100);
    expect(edgeDots(["n"], target, {}, IDENTITY, size)[0]!.side).toBe("top");
    expect(edgeDots(["n"], target, { n: { height: 200 } }, IDENTITY, size)).toEqual([]);
  });
});

describe("nodeFocusViewport: 点を押したノードへ、今の倍率のまま寄る（0.75 倍未満なら 0.75 倍）", () => {
  const r = rect(1000, 500, NODE_WIDTH, 40);
  const mid = { x: r.x + r.width / 2, y: r.y + r.height / 2 };

  it("0.75 倍以上なら今の倍率のまま、ノードの中心が画面の中央に来る", () => {
    for (const zoom of [0.75, 1, 1.3, 2]) {
      const v = nodeFocusViewport(r, zoom, size);
      expect(v.zoom).toBe(zoom);
      expect(centerOf(v).x).toBeCloseTo(mid.x, 6);
      expect(centerOf(v).y).toBeCloseTo(mid.y, 6);
    }
  });

  it("0.75 倍未満なら 0.75 倍にする。ノードの中心は画面の中央に来る", () => {
    for (const zoom of [0.5, 0.3, 0.02]) {
      const v = nodeFocusViewport(r, zoom, size);
      expect(v.zoom).toBe(0.75);
      expect(centerOf(v).x).toBeCloseTo(mid.x, 6);
      expect(centerOf(v).y).toBeCloseTo(mid.y, 6);
    }
  });
});

describe("shiftIntoView: 列を出して今の議題が端で切れるときだけ、その分を横にずらす", () => {
  const screen = { width: 1000, height: 600 };
  const v = (x: number, y: number, zoom: number) => ({ x, y, zoom });

  it("切れていなければずらさない（同じ位置・倍率）", () => {
    expect(shiftIntoView(v(0, 0, 1), [rect(100, 50, 200, 40)], screen)).toEqual(v(0, 0, 1));
    expect(shiftIntoView(v(0, 0, 1), [rect(800, 50, 200, 40)], screen)).toEqual(v(0, 0, 1)); // ちょうど右端に接する
    expect(shiftIntoView(v(0, 0, 1), [rect(0, 50, 200, 40)], screen)).toEqual(v(0, 0, 1)); // ちょうど左端に接する
  });

  it("右が切れていれば、切れた分だけ左へずらす", () => {
    // 右端が 1100。画面は 1000 幅なので 100 切れている
    expect(shiftIntoView(v(0, 0, 1), [rect(900, 50, 200, 40)], screen)).toEqual(v(-100, 0, 1));
  });

  it("左が切れていれば、切れた分だけ右へずらす", () => {
    expect(shiftIntoView(v(0, 0, 1), [rect(-50, 50, 200, 40)], screen)).toEqual(v(50, 0, 1));
  });

  it("倍率と現在の位置を考慮した画面の座標で測る（倍率は変えない）", () => {
    // zoom 2・x=-300: 箱 400〜600 は画面で 500〜900 → 切れない
    expect(shiftIntoView(v(-300, 10, 2), [rect(400, 0, 200, 40)], screen)).toEqual(v(-300, 10, 2));
    // zoom 2・x=-100: 画面で 700〜1100 → 100 切れる
    expect(shiftIntoView(v(-100, 10, 2), [rect(400, 0, 200, 40)], screen)).toEqual(v(-200, 10, 2));
    // zoom 0.5・x=50: 左端が画面で 50 + 0.5 × -300 = -100 → 100 切れる
    expect(shiftIntoView(v(50, 10, 0.5), [rect(-300, 0, 200, 40)], screen)).toEqual(v(150, 10, 0.5));
  });

  it("縦（y）と倍率は変えない", () => {
    for (const rects of [[rect(900, 700, 200, 40)], [rect(-50, -90, 200, 40)], [rect(100, 100, 200, 40)]]) {
      const out = shiftIntoView(v(12, 34, 1.5), rects, screen);
      expect(out.y).toBe(34);
      expect(out.zoom).toBe(1.5);
    }
  });

  it("複数の箱は外接箱で測る。片端だけ切れていれば、その分ずらす", () => {
    const rects = [rect(100, 0, 200, 40), rect(850, 200, 200, 40)]; // 外接箱は 100〜1050（右が 50 切れる）
    expect(shiftIntoView(v(0, 0, 1), rects, screen)).toEqual(v(-50, 0, 1));
  });

  it("ずらしで反対側を新たに切らない: 右が切れ、動かせるのが左の余白までのとき、その分だけずらす", () => {
    // 外接箱 100〜1300（画面より広い）。左端が 0 に来るまでの 100 だけずらす
    expect(shiftIntoView(v(0, 0, 1), [rect(100, 0, 1200, 40)], screen)).toEqual(v(-100, 0, 1));
    // 左が切れ、右の余白が 100 のとき（-100〜900 を、右へ 100 まで）
    expect(shiftIntoView(v(0, 0, 1), [rect(-100, 0, 1000, 40)], screen)).toEqual(v(100, 0, 1));
  });

  it("両端とも切れている（画面より広い）ときは、ずらさない", () => {
    expect(shiftIntoView(v(0, 0, 1), [rect(-50, 0, 1200, 40)], screen)).toEqual(v(0, 0, 1));
  });

  it("箱がなければ何もしない", () => {
    expect(shiftIntoView(v(5, 6, 1.2), [], screen)).toEqual(v(5, 6, 1.2));
  });

  it("入力の位置を書き換えない", () => {
    const viewport = Object.freeze(v(0, 0, 1));
    const out = shiftIntoView(viewport, [rect(900, 50, 200, 40)], screen);
    expect(out).not.toBe(viewport);
    expect(viewport).toEqual(v(0, 0, 1));
  });
});
