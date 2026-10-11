import { HashMap, Option, Schema } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import { Model, update } from "../src/app/mapSurface/main.ts";

// マップの表示面（Issue #814）の update。Mount が出す Message 1 つで、画面の大きさとノードの実測を受ける。
// Model に持つのは見せ方（mode）・Snapshot・画面の大きさ・ノードの実測だけで、配置・畳んだ後の木・viewport は持たない（view が毎回導く）

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題"): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [] });
const snapshot: Snapshot = { nodes: [node("root", null, "会議"), node("A", "root"), node("P", "A", "論点")], round: 1, changes: [], remarks: [] };

const initial = (mode: MapSurfaceModel["mode"] = "still"): MapSurfaceModel => ({ mode, snapshot, size: Option.none(), nodeHeights: HashMap.empty() });
const heightsOf = (m: MapSurfaceModel) => Object.fromEntries(HashMap.toEntries(m.nodeHeights));

describe("mapSurface の update: Mount の Message を受ける", () => {
  it("MeasuredMapSurface 1 つで、画面の大きさ（Some）とノードの高さが入る", () => {
    story(
      update,
      given(initial()),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, A: 64 } })),
      model((m) => {
        expect(m.size).toEqual(Option.some({ width: 800, height: 600 }));
        expect(heightsOf(m)).toEqual({ root: 40, A: 64 });
      }),
    );
  });

  it("測っていない間は、画面の大きさは None で、高さは 1 つも持たない（null や空のオブジェクトで表さない）", () => {
    const m = initial();
    expect(Option.isNone(m.size)).toBe(true);
    expect(HashMap.size(m.nodeHeights)).toBe(0);
  });

  it("高さは足されていく。同じノードは上書きされ、今回触れなかったノードは捨てない", () => {
    story(
      update,
      given(initial()),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, A: 64 } })),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { A: 90, P: 52 } })),
      model((m) => {
        expect(heightsOf(m)).toEqual({ root: 40, A: 90, P: 52 });
      }),
    );
  });

  it("画面の大きさだけが変わったとき（高さは空）は、大きさを置き換え、高さは残す", () => {
    story(
      update,
      given(initial()),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40 } })),
      message(Message.MeasuredMapSurface({ width: 1024, height: 500, nodeHeights: {} })),
      model((m) => {
        expect(m.size).toEqual(Option.some({ width: 1024, height: 500 }));
        expect(heightsOf(m)).toEqual({ root: 40 });
      }),
    );
  });

  it("mode と Snapshot は測った結果で変わらない", () => {
    story(
      update,
      given(initial("live")),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40 } })),
      model((m) => {
        expect(m.mode).toBe("live");
        expect(m.snapshot).toEqual(snapshot);
      }),
    );
  });

  it("update の後も Model の欄は 4 つだけ（配置・畳んだ後の木・viewport を足さない）", () => {
    story(
      update,
      given(initial()),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40 } })),
      model((m) => {
        expect(Object.keys(m).sort()).toEqual(["mode", "nodeHeights", "size", "snapshot"]);
      }),
    );
  });
});

describe("mapSurface の Model: 本物の Schema", () => {
  it("欄は mode・snapshot・size・nodeHeights の 4 つだけ", () => {
    expect(Object.keys(Model.fields).sort()).toEqual(["mode", "nodeHeights", "size", "snapshot"]);
  });

  it("本物の Model は通り、「無い」を null で書いた Model・知らない mode は通らない", () => {
    const is = Schema.is(Model);
    expect(is(initial("still"))).toBe(true);
    expect(is(initial("live"))).toBe(true);
    expect(is({ ...initial(), size: null })).toBe(false);
    expect(is({ ...initial(), mode: "review" })).toBe(false);
  });

  it("Snapshot の中身も検査する（Schema.declare で素通しにしていない）", () => {
    const is = Schema.is(Model);
    expect(is({ ...initial(), snapshot: { nodes: "x" } })).toBe(false);
    expect(is({ ...initial(), snapshot: { ...snapshot, nodes: [{ id: "A" }] } })).toBe(false);
  });

  it("nodeHeights は HashMap で、高さに文字列は入らない", () => {
    const is = Schema.is(Model);
    expect(is({ ...initial(), nodeHeights: { A: 40 } })).toBe(false);
    expect(is({ ...initial(), nodeHeights: HashMap.make(["A", "tall"]) })).toBe(false);
    expect(is({ ...initial(), nodeHeights: HashMap.make(["A", 40]) })).toBe(true);
  });
});
