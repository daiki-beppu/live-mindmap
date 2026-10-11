import { HashMap, Option } from "effect";
import { expect as expectScene, given, Mount, scene, selector, tap } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init, type Model, makeUpdate, makeView, snapshotOf } from "../src/app/review/main.ts";
import { foldView } from "../src/folding.ts";

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
      Mount.expectExact(ObserveMapSurface),
      tap((simulation) => expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(10).sort())),
      measuredAll(10),
      expectScene(selector(`[data-node-id="${expectedIds(10)[0]}"]`)).not.toHaveStyle("visibility", "hidden"),
    );
  });

  it("時刻 30 のマップは、時刻 10 より多くのノードを描く（時刻に追従する）", () => {
    expect(expectedIds(30).length).toBeGreaterThan(expectedIds(10).length);
    scene(
      app,
      given(at(30)),
      tap((simulation) => expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(30).sort())),
      measuredAll(30),
    );
  });

  it("表示面の Model は時刻の Snapshot を持たない（Model の欄に Snapshot が無い）", () => {
    const m = init(context);
    // 表示面の状態のうち、実測（size・nodeHeights）とパンの状態（#815）だけを持ち、導く mode・snapshot は持たない
    expect(Object.keys(m.mapSurface).sort()).toEqual(["isMac", "nodeHeights", "nodePress", "pan", "pointer", "scrollAxisLock", "size"]);
    expect(Option.isNone(m.mapSurface.size)).toBe(true);
    expect(HashMap.size(m.mapSurface.nodeHeights)).toBe(0);
  });
});
