import { describe, expect, it } from "vitest";
import type { ChangeEntry, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { cameraFocus, focusViewport, nodeRect, shouldMoveCamera } from "../src/camera.ts";

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
