import { HashMap, Option } from "effect";
import { expect as expectScene, given, Mount, scene, selector, tap } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { SlideCaptions } from "../src/app/sessionLayout/mount.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init, type Model, makeUpdate, makeView, snapshotOf } from "../src/app/review/main.ts";
import { foldView } from "../src/folding.ts";
import { layout } from "../src/layout.ts";
import { Message as ReviewMessage } from "../src/app/review/message.ts";
import { ObserveSeekPointer } from "../src/app/review/mount.ts";
import { settle, TOOLTIPS_PLAIN, tooltipMounts } from "./reviewHarness.ts";

// 見返しの Foldkit プログラム（Issue #823）の Scene。描いた view から入り、その時刻の Snapshot のノードが表示面に出ることを見る。
// 比べる相手は、既存の純粋な関数 foldView が、その時刻の Snapshot から返すノード（live の表示面と同じ畳み方）

const remark = (id: string, end: number, text: string) => ({ at: "x", type: "remark", remark: { id, track: "相手", start: end - 5, end, text } });
const add = (ref: string, parent: string, kind: string, text: string, evidence: string[]) => ({ op: "add", ref, parent, kind, text, evidence });
const diff = (fresh: string[], ops: unknown[]) => ({ at: "x", type: "diff", input: { recent: [], fresh, nodeCount: 0 }, ops, dropped: [] });
const events = [
  { at: "a", type: "start", title: "定例" },
  remark("r1", 10, "採用の話をします。"),
  diff(["r1"], [add("t1", "root", "議題", "採用", ["r1"])]),
  remark("r2", 30, "予算です。"),
  diff(["r2"], [add("t2", "root", "議題", "予算", ["r2"]), add("p1", "t2", "論点", "上限をどうするか", ["r2"])]),
];

const context = makeContext(events);
const app = { update: makeUpdate(context), view: makeView(context) };
const at = (time: number): Model => {
  const start = init(context);
  return { ...start, playback: { ...start.playback, time } };
};
const expectedIds = (time: number): string[] => foldView(snapshotOf(context, at(time)), new Set(), null, new Set(), new Set()).nodes.map((n) => n.id);
const measuredAll = (time: number) => Mount.resolve(ObserveMapSurface, MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: Object.fromEntries(expectedIds(time).map((id) => [id, 40])) }));
const renderedIds = (html: { children?: unknown }): string[] => {
  type V = { data?: { attrs?: Record<string, unknown> }; children?: Array<V | string> };
  const walk = (v: V): string[] => [...(typeof v.data?.attrs?.["data-node-id"] === "string" ? [v.data.attrs["data-node-id"] as string] : []), ...(v.children ?? []).flatMap((c) => (typeof c === "string" ? [] : walk(c)))];
  return walk(html as V);
};

describe("見返しの Scene: 時刻のマップが表示面に出る", () => {
  it("時刻 10 のマップのノードだけが描かれ、測ると見える", () => {
    expect(expectedIds(10).length).toBeGreaterThan(0);
    scene(
      app,
      given(at(10)),
      // 操作の行（#825）の Mount: シークバーのポインタと、ボタンごとのツールチップ
      Mount.expectExact(ObserveMapSurface, SlideCaptions, ObserveSeekPointer, ...tooltipMounts(TOOLTIPS_PLAIN)),
      tap((simulation) => expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(10).sort())),
      measuredAll(10),
      expectScene(selector(`[data-node-id="${expectedIds(10)[0]}"]`)).not.toHaveStyle("visibility", "hidden"),
      settle,
    );
  });

  it("時刻 30 のマップは、時刻 10 より多くのノードを描く（時刻に追従する）", () => {
    expect(expectedIds(30).length).toBeGreaterThan(expectedIds(10).length);
    scene(
      app,
      given(at(30)),
      tap((simulation) => expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(30).sort())),
      measuredAll(30),
      settle,
    );
  });

  it("表示面の Model は時刻の Snapshot を持たない（Model の欄に Snapshot が無い）", () => {
    const m = init(context);
    // 表示面の状態のうち、実測（size・nodeHeights）とパンの状態（#815）と見る状態（viewing。#818）とカメラの欄（#819）だけを持ち、導く mode・snapshot は持たない
    expect(Object.keys(m.mapSurface).sort()).toEqual([
      "gestureScale",
      "idleStamp",
      "isMac",
      "keepAnchor",
      "motion",
      "nodeHeights",
      "nodePress",
      "pendingShift",
      "placedRound",
      "pointer",
      "scrollAxisLock",
      "size",
      "viewing",
      "viewport",
    ]);
    expect(Option.isNone(m.mapSurface.size)).toBe(true);
    expect(HashMap.size(m.mapSurface.nodeHeights)).toBe(0);
  });

  it("測定済みの後に目標の位置が変わる高さを再測定すると補間が始まり、Tick 500 の後に描く位置は新しい高さの layout になる", () => {
    const ids = expectedIds(30);
    const nodes = foldView(snapshotOf(context, at(30)), new Set(), null, new Set(), new Set()).nodes;
    const base = Object.fromEntries(ids.map((id) => [id, 40]));
    const changed = { ...base, [ids[1]!]: 160 };
    const before = layout(nodes, base);
    const after = layout(nodes, changed);
    expect(ids.some((id) => before[id]!.y !== after[id]!.y)).toBe(true);
    const measure = (m: Model, nodeHeights: Record<string, number>): Model =>
      app.update(m, ReviewMessage.GotMapSurfaceMessage({ message: MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights }) })).model;
    const remeasured = measure(measure(at(30), base), changed);
    expect(Option.isSome(remeasured.mapSurface.motion)).toBe(true);
    const settledModel = app.update(remeasured, ReviewMessage.GotMapSurfaceMessage({ message: MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 500 }) })).model;
    expect(Option.isNone(settledModel.mapSurface.motion)).toBe(true);
    type V = { data?: { attrs?: Record<string, unknown>; style?: Record<string, string> }; children?: Array<V | string> };
    const wrappers = (v: V): V[] => [...(typeof v.data?.attrs?.["data-node-id"] === "string" ? [v] : []), ...(v.children ?? []).flatMap((c) => (typeof c === "string" ? [] : wrappers(c)))];
    scene(
      app,
      given(settledModel),
      Mount.resolve(ObserveMapSurface, MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: changed })),
      tap((simulation) => {
        for (const w of wrappers(simulation.html as V)) {
          const id = w.data!.attrs!["data-node-id"] as string;
          const [x, y] = (w.data?.style?.transform ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
          expect([x, y]).toEqual([after[id]!.x, after[id]!.y]);
        }
      }),
      settle,
    );
  });
});
