import { HashMap, Option, Schema } from "effect";
import { expectNoOutMessage, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message, OutMessage } from "../src/app/mapSurface/message.ts";

// マップの表示面（Issue #814）の update。Mount が出す Message 1 つで、画面の大きさとノードの実測を受ける。
// Model に持つのは見せ方（mode）・Snapshot・画面の大きさ・ノードの実測と、パンの状態（isMac・pan・pointer・nodePress・scrollAxisLock）だけで、配置・畳んだ後の木・viewport は持たない（view が毎回導く）

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題"): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [] });
const snapshot: Snapshot = { nodes: [node("root", null, "会議"), node("A", "root"), node("P", "A", "論点")], round: 1, changes: [], remarks: [] };

const initial = (mode: MapSurfaceModel["mode"] = "still", isMac = false): MapSurfaceModel => init(snapshot, mode, isMac);
const MODEL_FIELDS = ["isMac", "mode", "nodeHeights", "nodePress", "pan", "pointer", "scrollAxisLock", "size", "snapshot"];
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

  it("update の後も Model の欄は決まった 9 つだけ（配置・畳んだ後の木・viewport を足さない）", () => {
    story(
      update,
      given(initial()),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40 } })),
      model((m) => {
        expect(Object.keys(m).sort()).toEqual(MODEL_FIELDS);
      }),
    );
  });
});

describe("mapSurface の Model: 本物の Schema", () => {
  it("欄は mode・snapshot・size・nodeHeights と、パンの isMac・pan・pointer・nodePress・scrollAxisLock の 9 つだけ", () => {
    expect(Object.keys(Model.fields).sort()).toEqual(MODEL_FIELDS);
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

describe("mapSurface の Model: パンの欄", () => {
  const is = Schema.is(Model);

  it("初期は pan (0, 0)・pointer と nodePress と scrollAxisLock は None。isMac は init の引数のまま", () => {
    const m = initial("live", true);
    expect(m.pan).toEqual({ x: 0, y: 0 });
    expect(Option.isNone(m.pointer)).toBe(true);
    expect(Option.isNone(m.nodePress)).toBe(true);
    expect(Option.isNone(m.scrollAxisLock)).toBe(true);
    expect(m.isMac).toBe(true);
    expect(initial("live", false).isMac).toBe(false);
  });

  it("本物の Schema: 「無い」を null で書いた欄・形の違う値は通らない", () => {
    expect(is(initial())).toBe(true);
    expect(is({ ...initial(), pointer: null })).toBe(false);
    expect(is({ ...initial(), nodePress: null })).toBe(false);
    expect(is({ ...initial(), scrollAxisLock: null })).toBe(false);
    expect(is({ ...initial(), isMac: "yes" })).toBe(false);
    expect(is({ ...initial(), pan: { x: "1", y: 0 } })).toBe(false);
    expect(is({ ...initial(), pan: { x: Number.NaN, y: 0 } })).toBe(false);
  });

  it("pointer は PanningPane か HoldingNode だけ。nodePress は nodeId・x・y・dragged、scrollAxisLock は軸 x か y と時刻", () => {
    expect(is({ ...initial(), pointer: Option.some({ _tag: "PanningPane", x: 1, y: 2, button: 0 }) })).toBe(true);
    expect(is({ ...initial(), pointer: Option.some({ _tag: "PanningPane", x: 1, y: 2 }) })).toBe(false);
    expect(is({ ...initial(), pointer: Option.some({ _tag: "HoldingNode" }) })).toBe(true);
    expect(is({ ...initial(), pointer: Option.some({ _tag: "Dragging" }) })).toBe(false);
    expect(is({ ...initial(), pointer: Option.some({ _tag: "PanningPane", x: "1", y: 2, button: 0 }) })).toBe(false);
    expect(is({ ...initial(), nodePress: Option.some({ nodeId: "A", x: 1, y: 2, dragged: false }) })).toBe(true);
    expect(is({ ...initial(), nodePress: Option.some({ nodeId: "A", x: 1, y: 2, dragged: "no" }) })).toBe(false);
    expect(is({ ...initial(), scrollAxisLock: Option.some({ axis: "x", at: 10 }) })).toBe(true);
    expect(is({ ...initial(), scrollAxisLock: Option.some({ axis: "z", at: 10 }) })).toBe(false);
  });
});

// 画面上の移動量の比較。-0 と 0 は区別しない
const expectPan = (m: MapSurfaceModel, x: number, y: number) => {
  expect(m.pan.x).toBeCloseTo(x, 9);
  expect(m.pan.y).toBeCloseTo(y, 9);
};

const wheel = (over: Partial<typeof Message.WheeledMapSurface.Type> = {}) =>
  Message.WheeledMapSurface({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0, ...over });
const pressPane = (over: Partial<typeof Message.PressedMapSurface.Type> = {}) => Message.PressedMapSurface({ clientX: 100, clientY: 100, button: 0, ctrlKey: false, insideNoPan: false, ...over });
const movePointer = (clientX: number, clientY: number, buttons = 1) => Message.MovedPointer({ clientX, clientY, buttons });
const release = (over: Partial<typeof Message.ReleasedPointer.Type> = {}) => Message.ReleasedPointer({ ctrlKey: false, metaKey: false, ...over });

describe("mapSurface の update: 二本指スクロールでパン（live）", () => {
  it("pixel 単位は、画面が delta × 0.5 だけ逆向きに動く。deltaX 40・deltaY 100 で pan (-20, -50)", () => {
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 40, deltaY: 100 })),
      model((m) => expectPan(m, -20, -50)),
    );
  });

  it("続けるほど足し上がる", () => {
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 40, deltaY: 100 })),
      message(wheel({ deltaX: -10, deltaY: 20 })),
      model((m) => expectPan(m, -15, -60)),
    );
  });

  it("行単位（deltaMode 1）は 20 倍になる", () => {
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 3, deltaY: 2, deltaMode: 1 })),
      model((m) => expectPan(m, -30, -20)),
    );
  });

  it("Mac でなく Shift 付きなら、縦の量が横に使われ、縦は動かない", () => {
    story(
      update,
      given(initial("live", false)),
      message(wheel({ deltaX: 40, deltaY: 100, shiftKey: true })),
      model((m) => expectPan(m, -50, 0)),
    );
  });

  it("Mac で Shift 付きなら、入れ替えない", () => {
    story(
      update,
      given(initial("live", true)),
      message(wheel({ deltaX: 40, deltaY: 100, shiftKey: true })),
      model((m) => expectPan(m, -20, -50)),
    );
  });

  it("パンは Snapshot・mode・測った結果を変えない", () => {
    story(
      update,
      given(initial("live")),
      message(Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40 } })),
      message(wheel({ deltaX: 40, deltaY: 100 })),
      model((m) => {
        expect(m.mode).toBe("live");
        expect(m.snapshot).toEqual(snapshot);
        expect(m.size).toEqual(Option.some({ width: 800, height: 600 }));
        expect(heightsOf(m)).toEqual({ root: 40 });
      }),
    );
  });

  it("ズームの経路（Ctrl 付きのピンチ、Mac の ⌘ だけ）では、パンしない", () => {
    story(
      update,
      given(initial("live", true)),
      message(wheel({ deltaX: 40, deltaY: 100, ctrlKey: true })),
      message(wheel({ deltaX: 40, deltaY: 100, metaKey: true })),
      model((m) => expectPan(m, 0, 0)),
    );
  });
});

describe("mapSurface の update: ⌘/Ctrl＋Shift＋スクロールの軸固定（live）", () => {
  it("最初の入力で大きい方の軸だけが動く。量は delta の生の値（0.5 倍も 20 倍もしない）", () => {
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 30, deltaY: 5, shiftKey: true, metaKey: true, timeStamp: 1000 })),
      model((m) => expectPan(m, -30, 0)),
    );
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 5, deltaY: -30, shiftKey: true, ctrlKey: true, timeStamp: 1000 })),
      model((m) => expectPan(m, 0, 30)),
    );
  });

  it("deltaMode が 1 でも量は raw のまま", () => {
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: true, metaKey: true, timeStamp: 1000 })),
      model((m) => expectPan(m, 0, -3)),
    );
  });

  it("250ms 未満の間は前の軸を保つ（反対の軸の量が大きくても、その量が保った軸に使われる）。250ms 以上空くと決め直す", () => {
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 2, deltaY: 20, shiftKey: true, metaKey: true, timeStamp: 1000 })),
      message(wheel({ deltaX: 50, deltaY: 1, shiftKey: true, metaKey: true, timeStamp: 1100 })),
      model((m) => expectPan(m, 0, -70)),
      message(wheel({ deltaX: 50, deltaY: 1, shiftKey: true, metaKey: true, timeStamp: 1350 })),
      model((m) => expectPan(m, -50, -70)),
    );
  });

  it("前回から 249ms なら保ち、250ms なら決め直す", () => {
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 0, deltaY: 10, shiftKey: true, metaKey: true, timeStamp: 0 })),
      message(wheel({ deltaX: 40, deltaY: 0, shiftKey: true, metaKey: true, timeStamp: 249 })),
      model((m) => expectPan(m, 0, -50)),
    );
    story(
      update,
      given(initial("live")),
      message(wheel({ deltaX: 0, deltaY: 10, shiftKey: true, metaKey: true, timeStamp: 0 })),
      message(wheel({ deltaX: 40, deltaY: 0, shiftKey: true, metaKey: true, timeStamp: 250 })),
      model((m) => expectPan(m, -40, -10)),
    );
  });

  it("Shift だけ・⌘/Ctrl だけでは軸固定にならない（Shift だけは通常のスクロールの式）", () => {
    story(
      update,
      given(initial("live", true)),
      message(wheel({ deltaX: 30, deltaY: 5, shiftKey: true, timeStamp: 1000 })),
      model((m) => expectPan(m, -15, -2.5)),
    );
  });
});

describe("mapSurface の update: 空いたところのドラッグでパン（live）", () => {
  it("押して (100, 100) から (130, 90) へ動かすと、ポインタが動いた分だけ pan (30, -10)。続けて動かすと差が積み上がる", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane({ clientX: 100, clientY: 100 })),
      message(movePointer(130, 90)),
      model((m) => expectPan(m, 30, -10)),
      message(movePointer(140, 95)),
      model((m) => expectPan(m, 40, -5)),
    );
  });

  it("中ボタン（button:1、移動時の buttons:4）で押して動かしても pan (30, -10)、続けて (40, -5)", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane({ button: 1 })),
      message(movePointer(130, 90, 4)),
      model((m) => expectPan(m, 30, -10)),
      message(movePointer(140, 95, 4)),
      model((m) => expectPan(m, 40, -5)),
    );
  });

  it("中ボタンのパン中に離す・キャンセルした後の移動では動かない", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane({ button: 1 })),
      message(movePointer(130, 90, 4)),
      message(release()),
      message(movePointer(300, 300, 4)),
      model((m) => expectPan(m, 30, -10)),
    );
    story(
      update,
      given(initial("live")),
      message(pressPane({ button: 1 })),
      message(movePointer(130, 90, 4)),
      message(Message.CanceledPointer()),
      message(movePointer(300, 300, 4)),
      model((m) => expectPan(m, 30, -10)),
    );
  });

  it("中ボタンのビットが消えた buttons:0 の移動でパンを終え、その差分は足さない", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane({ button: 1 })),
      message(movePointer(130, 90, 4)),
      message(movePointer(150, 90, 0)),
      message(movePointer(200, 90, 4)),
      model((m) => expectPan(m, 30, -10)),
    );
  });

  it("開始したボタンとは別のビットだけの移動ではパンしない（中ボタン開始は buttons:1、主ボタン開始は buttons:4）", () => {
    story(update, given(initial("live")), message(pressPane({ button: 1 })), message(movePointer(130, 90, 1)), model((m) => expectPan(m, 0, 0)));
    story(update, given(initial("live")), message(pressPane({ button: 0 })), message(movePointer(130, 90, 4)), model((m) => expectPan(m, 0, 0)));
  });

  it("押しただけでは動かない", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane()),
      model((m) => expectPan(m, 0, 0)),
    );
  });

  it("離した後の移動では動かない", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane()),
      message(movePointer(130, 90)),
      message(release()),
      message(movePointer(300, 300)),
      model((m) => expectPan(m, 30, -10)),
    );
  });

  it("キャンセルした後の移動では動かない", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane()),
      message(movePointer(130, 90)),
      message(Message.CanceledPointer()),
      message(movePointer(300, 300)),
      model((m) => expectPan(m, 30, -10)),
    );
  });

  it("押していないときの移動では動かない", () => {
    story(
      update,
      given(initial("live")),
      message(movePointer(130, 90)),
      model((m) => expectPan(m, 0, 0)),
    );
  });

  it("次のドラッグは、前のドラッグの終わりではなく新しく押した位置から測る", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane({ clientX: 100, clientY: 100 })),
      message(movePointer(130, 90)),
      message(release()),
      message(pressPane({ clientX: 500, clientY: 500 })),
      message(movePointer(510, 520)),
      model((m) => expectPan(m, 40, 10)),
    );
  });

  it("押したまま離したことを取りこぼしても（buttons が 0 の移動）、そこでパンを終える", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane()),
      message(movePointer(130, 90)),
      message(movePointer(150, 90, 0)),
      message(movePointer(200, 90)),
      model((m) => expectPan(m, 30, -10)),
    );
  });

  it(".nopan（ノードの上）で始めたドラッグでは動かない", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane({ insideNoPan: true })),
      message(movePointer(130, 90)),
      model((m) => expectPan(m, 0, 0)),
    );
  });

  it("主ボタン以外（右ボタン）・Ctrl 付きの押下では動かない（@xyflow のフィルタと同じ）", () => {
    story(
      update,
      given(initial("live")),
      message(pressPane({ button: 2 })),
      message(movePointer(130, 90)),
      model((m) => expectPan(m, 0, 0)),
    );
    story(
      update,
      given(initial("live")),
      message(pressPane({ ctrlKey: true })),
      message(movePointer(130, 90)),
      model((m) => expectPan(m, 0, 0)),
    );
  });

  it("ノードのボタンを押して動かしても、画面は動かない", () => {
    story(
      update,
      given(initial("live")),
      message(Message.PressedNodeButton({ nodeId: "A", clientX: 50, clientY: 50 })),
      message(movePointer(90, 80)),
      model((m) => expectPan(m, 0, 0)),
    );
  });
});

describe("mapSurface の update: still ではパンしない", () => {
  it("スクロール・軸固定・ドラッグのどれでも pan は変わらない", () => {
    story(
      update,
      given(initial("still")),
      message(wheel({ deltaX: 40, deltaY: 100 })),
      message(wheel({ deltaX: 30, deltaY: 5, shiftKey: true, metaKey: true, timeStamp: 1000 })),
      message(pressPane()),
      message(movePointer(130, 90)),
      model((m) => expectPan(m, 0, 0)),
    );
  });
});

describe("mapSurface の update: クリックとドラッグの見分け（MapNode.tsx と同じ規則）", () => {
  const pressNode = (nodeId: string, clientX: number, clientY: number) => message(Message.PressedNodeButton({ nodeId, clientX, clientY }));
  const clickNode = (nodeId: string, clientX: number, clientY: number) => message(Message.ClickedNodeButton({ nodeId, clientX, clientY }));
  const selected = (nodeId: string) => expectOutMessage(OutMessage.SelectedNode({ nodeId }));

  it("① 押して 3px 動かして離した click は、ノードを選ぶ", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(53, 50)), message(release()), clickNode("A", 53, 50), selected("A"));
  });

  it("しきい値は 4px ちょうどまでクリック（超えたらドラッグ）", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(54, 50)), message(release()), clickNode("A", 54, 50), selected("A"));
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(55, 50)), message(release()), clickNode("A", 55, 50), expectNoOutMessage());
  });

  it("② 途中で 4px を超えたら、押した点に戻って離しても、ドラッグ扱いで選ばない", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(55, 50)), message(movePointer(50, 50)), message(release()), clickNode("A", 50, 50), expectNoOutMessage());
  });

  it("④ 移動の Message が無くても、押した点から 4px を超えて離れた点での click は選ばない", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), message(release()), clickNode("A", 55, 50), expectNoOutMessage());
  });

  it("⑤ 押した記録の無い click（キーボード）は選ぶ", () => {
    story(update, given(initial("live")), clickNode("A", 0, 0), selected("A"));
  });

  it("③ ⌘ か Ctrl 付きで離したら記録を消すので、後のキーボードの click は選ぶ。付いていなければ記録が残るので選ばない", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(80, 50)), message(release({ metaKey: true })), clickNode("A", 0, 0), selected("A"));
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(80, 50)), message(release({ ctrlKey: true })), clickNode("A", 0, 0), selected("A"));
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(80, 50)), message(release()), clickNode("A", 0, 0), expectNoOutMessage());
  });

  it("click は記録を使い切る。続く 2 回目の click は記録が無いので選ぶ", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), message(movePointer(80, 50)), message(release()), clickNode("A", 80, 50), expectNoOutMessage(), clickNode("A", 80, 50), selected("A"));
  });

  it("別のノードの click は、押したノードの記録に影響されず選ぶ。押したノードの記録は残る", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), message(release()), clickNode("B", 200, 200), selected("B"), clickNode("A", 200, 200), expectNoOutMessage());
  });

  it("mode に関係なく記録する（still でも選べる・見分けも同じ）", () => {
    story(update, given(initial("still")), pressNode("A", 50, 50), message(release()), clickNode("A", 50, 50), selected("A"));
    story(update, given(initial("still")), pressNode("A", 50, 50), message(release()), clickNode("A", 60, 50), expectNoOutMessage());
  });

  it("Message を受けるだけでは OutMessage は出ない（押した・動いた・離した）", () => {
    story(update, given(initial("live")), pressNode("A", 50, 50), expectNoOutMessage(), message(movePointer(53, 50)), expectNoOutMessage(), message(release()), expectNoOutMessage());
  });
});
