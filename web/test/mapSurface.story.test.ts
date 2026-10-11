import { HashMap, Option, Schema } from "effect";
import { expectNoOutMessage, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { displayedPositions, init, Model, update, viewportOf } from "../src/app/mapSurface/main.ts";
import { Message, OutMessage } from "../src/app/mapSurface/message.ts";
import { CLICK_ZOOM_FACTOR, pinchZoomFactor, USER_MAX_ZOOM, USER_MIN_ZOOM, zoomAtPoint } from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { layout } from "../src/layout.ts";
import { interpolate, startPositions } from "../src/motion.ts";

// マップの表示面（Issue #814）の update。Mount が出す Message 1 つで、画面の大きさとノードの実測を受ける。
// Model に持つのは見せ方（mode）・Snapshot・画面の大きさ・ノードの実測と、パンの状態（isMac・pan・pointer・nodePress・scrollAxisLock）だけで、配置・畳んだ後の木・viewport は持たない（view が毎回導く）

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題"): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [] });
const snapshot: Snapshot = { nodes: [node("root", null, "会議"), node("A", "root"), node("P", "A", "論点")], round: 1, changes: [], remarks: [] };

const initial = (mode: MapSurfaceModel["mode"] = "still", isMac = false): MapSurfaceModel => init(snapshot, mode, isMac);
const MODEL_FIELDS = ["camera", "gestureScale", "isMac", "mode", "motion", "nodeHeights", "nodePress", "pan", "pointer", "scrollAxisLock", "size", "snapshot", "viewing", "zoomScale"];
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

  it("update の後も Model の欄は決まった 14 個だけ（配置・畳んだ後の木・viewport を足さない。camera は見る状態が返したカメラへの指示）", () => {
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
  it("欄は mode・snapshot・size・nodeHeights と、パンの isMac・pan・pointer・nodePress・scrollAxisLock と、補間の motion と、見る状態の viewing と、その出来事が返したカメラへの指示 camera と、ズームの zoomScale・gestureScale の 14 個だけ", () => {
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
  Message.WheeledMapSurface({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0, x: 0, y: 0, ...over });
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

  it("Mac の ⌘ だけの wheel は、パンもズームもしない（この issue の範囲外）", () => {
    story(
      update,
      given(measuredLive(true)),
      message(wheel({ deltaX: 40, deltaY: 100, metaKey: true, x: 300, y: 200 })),
      model((m) => {
        expectPan(m, 0, 0);
        expect(m.zoomScale).toBe(1);
      }),
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

// マップの動き（Issue #817）: 差分更新の反映で、表示位置が今の位置から新しい目標へ 500ms で補間される。
// Model に持つのは補間の始まりの位置（start）と経過 ms（elapsedMs）だけ。表示する位置は displayedPositions が毎回導く
describe("mapSurface の update: 差分更新の反映で位置が補間される", () => {
  const HEIGHTS = { root: 40, A: 64, P: 88 };
  const next: Snapshot = { ...snapshot, round: 2, nodes: [...snapshot.nodes, node("D", "A", "案")] };
  const NO_IDS: ReadonlySet<string> = new Set();
  const shownOf = (m: MapSurfaceModel): SnapshotNode[] => (m.mode === "live" ? foldView(m.snapshot, NO_IDS, null, NO_IDS, NO_IDS).nodes : m.snapshot.nodes);
  const heightsRecord = (m: MapSurfaceModel) => heightsOf(m);
  const targetOf = (m: MapSurfaceModel) => layout(shownOf(m), heightsRecord(m));
  const measure = (nodeHeights: Record<string, number>) => Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights });
  const tick = (deltaMs: number) => Message.TickedAnimationFrame({ deltaMs });
  const startOf = (m: MapSurfaceModel) => (Option.isSome(m.motion) ? Object.fromEntries(HashMap.toEntries(m.motion.value.start)) : {});
  const expectPositions = (actual: Record<string, { x: number; y: number }>, expected: Record<string, { x: number; y: number }>) => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, p] of Object.entries(expected)) {
      expect(actual[id]!.x).toBeCloseTo(p.x, 6);
      expect(actual[id]!.y).toBeCloseTo(p.y, 6);
    }
  };

  it("初期は motion が None（null や空のオブジェクトで表さない）", () => {
    expect(Option.isNone(initial("live").motion)).toBe(true);
  });

  it("live: 測った後に ChangedSnapshot を受けると、直後は今までの位置（新しいノードは祖先の位置）、250ms で interpolate の 0.5、500ms で目標になる", () => {
    story(
      update,
      given(initial("live")),
      message(measure(HEIGHTS)),
      model((m) => {
        // 最初の測定では補間を始めない
        expect(Option.isNone(m.motion)).toBe(true);
      }),
      message(Message.ChangedSnapshot({ snapshot: next })),
      model((m) => {
        const before = layout(shownOf(initial("live")), HEIGHTS);
        const target = targetOf(m);
        expect(Object.keys(target).sort()).toEqual(["A", "D", "P", "root"]);
        const expectedStart = startPositions(shownOf(m), before, target);
        // この入力は、既存ノードも動き、新しいノードも出るものでなければ検証にならない
        expect(expectedStart["root"]).not.toEqual(target["root"]);
        expect(expectedStart["D"]).toEqual(before["A"]);
        expect(Option.isSome(m.motion)).toBe(true);
        expect(m.snapshot).toEqual(next);
        expectPositions(startOf(m), expectedStart);
        expectPositions(displayedPositions(m), expectedStart);
      }),
      message(tick(100)),
      message(tick(150)),
      model((m) => {
        const target = targetOf(m);
        const expectedStart = startPositions(shownOf(m), layout(shownOf(initial("live")), HEIGHTS), target);
        expectPositions(displayedPositions(m), interpolate(expectedStart, target, 0.5));
        // 各座標は 始まり + (目標 − 始まり) × 0.875
        expect(displayedPositions(m)["root"]!.y).toBeCloseTo(expectedStart["root"]!.y + (target["root"]!.y - expectedStart["root"]!.y) * 0.875, 6);
      }),
      message(tick(250)),
      model((m) => {
        expectPositions(displayedPositions(m), targetOf(m));
        expect(Option.isNone(m.motion)).toBe(true);
      }),
    );
  });

  it("500ms を超えて進めても目標で止まる。補間が終わった後の tick は Model を変えない", () => {
    story(
      update,
      given(initial("live")),
      message(measure(HEIGHTS)),
      message(Message.ChangedSnapshot({ snapshot: next })),
      message(tick(900)),
      model((m) => {
        expectPositions(displayedPositions(m), targetOf(m));
        expect(Option.isNone(m.motion)).toBe(true);
      }),
      message(tick(16)),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        expectPositions(displayedPositions(m), targetOf(m));
      }),
    );
  });

  it("補間の途中で次の ChangedSnapshot が来たら、そのとき見せていた位置から始め直す（経過は 0）", () => {
    const third: Snapshot = { ...next, round: 3, nodes: [...next.nodes, node("E", "A", "案")] };
    let shownMid: Record<string, { x: number; y: number }> = {};
    story(
      update,
      given(initial("live")),
      message(measure(HEIGHTS)),
      message(Message.ChangedSnapshot({ snapshot: next })),
      message(tick(100)),
      model((m) => {
        shownMid = displayedPositions(m);
        expect(Option.isSome(m.motion) && m.motion.value.elapsedMs).toBe(100);
      }),
      message(Message.ChangedSnapshot({ snapshot: third })),
      model((m) => {
        expect(Option.isSome(m.motion) && m.motion.value.elapsedMs).toBe(0);
        const expectedStart = startPositions(shownOf(m), shownMid, targetOf(m));
        expectPositions(startOf(m), expectedStart);
        expectPositions(displayedPositions(m), expectedStart);
        // 途中の位置は始まり（前の始まり）とも目標とも違う
        expect(shownMid["root"]).not.toEqual(layout(shownOf(initial("live")), HEIGHTS)["root"]);
      }),
      message(tick(500)),
      model((m) => {
        expectPositions(displayedPositions(m), targetOf(m));
        expect(Option.isNone(m.motion)).toBe(true);
      }),
    );
  });

  it("まだ何も測っていない live の ChangedSnapshot では補間しない", () => {
    story(
      update,
      given(initial("live")),
      message(Message.ChangedSnapshot({ snapshot: next })),
      model((m) => {
        expect(m.snapshot).toEqual(next);
        expect(Option.isNone(m.motion)).toBe(true);
      }),
    );
  });

  it("still: ChangedSnapshot の直後から目標の位置で、motion は None のまま", () => {
    story(
      update,
      given(initial("still")),
      message(measure(HEIGHTS)),
      message(Message.ChangedSnapshot({ snapshot: next })),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        expectPositions(displayedPositions(m), targetOf(m));
      }),
    );
  });

  it("live: 測り済みのノードの高さが変わって目標が動いたときも補間する。今の位置から始まる", () => {
    story(
      update,
      given(initial("live")),
      message(measure(HEIGHTS)),
      message(measure({ P: 140 })),
      model((m) => {
        const before = layout(shownOf(initial("live")), HEIGHTS);
        const target = targetOf(m);
        expect(JSON.stringify(target)).not.toEqual(JSON.stringify(before));
        expect(Option.isSome(m.motion)).toBe(true);
        expectPositions(startOf(m), startPositions(shownOf(m), before, target));
        expectPositions(displayedPositions(m), before);
      }),
      message(tick(500)),
      model((m) => {
        expectPositions(displayedPositions(m), targetOf(m));
        expect(Option.isNone(m.motion)).toBe(true);
      }),
    );
  });

  it("目標が変わらない測定（同じ高さ）・大きさだけの測定では補間を始めない", () => {
    story(
      update,
      given(initial("live")),
      message(measure(HEIGHTS)),
      message(measure({ P: 88 })),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
      }),
      message(measure({})),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
      }),
    );
  });

  it("補間中に大きさだけの測定が来ても、経過を戻さず、始まりも変えない", () => {
    let startBefore: Record<string, { x: number; y: number }> = {};
    story(
      update,
      given(initial("live")),
      message(measure(HEIGHTS)),
      message(Message.ChangedSnapshot({ snapshot: next })),
      message(tick(120)),
      model((m) => {
        startBefore = startOf(m);
      }),
      message(measure({})),
      model((m) => {
        expect(Option.isSome(m.motion) && m.motion.value.elapsedMs).toBe(120);
        expectPositions(startOf(m), startBefore);
      }),
    );
  });

  it("補間中でないとき TickedAnimationFrame を受けても motion は None のまま", () => {
    story(
      update,
      given(initial("live")),
      message(tick(16)),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
      }),
    );
  });
});

describe("mapSurface の Model: motion の欄", () => {
  const is = Schema.is(Model);
  const motion = (over: object = {}) => Option.some({ start: HashMap.make(["A", { x: 1, y: 2 }]), elapsedMs: 10, ...over });

  it("補間中の Model は通り、「無い」を null で書いたもの・start がただのオブジェクトのもの・経過が有限でないものは通らない", () => {
    expect(is({ ...initial("live"), motion: motion() })).toBe(true);
    expect(is({ ...initial("live"), motion: null })).toBe(false);
    expect(is({ ...initial("live"), motion: Option.some({ start: { A: { x: 1, y: 2 } }, elapsedMs: 10 }) })).toBe(false);
    expect(is({ ...initial("live"), motion: motion({ elapsedMs: Number.POSITIVE_INFINITY }) })).toBe(false);
  });
});

// ズーム（Issue #816）。ビューポートは viewportOf（全体を収める位置 × zoomScale ＋ pan）で、見せる値と update が使う値は同じ。結果は zoomAtPoint と同じ（今の @xyflow／MapView と同じだけ変わる）
const measuredLive = (isMac = false): MapSurfaceModel => ({
  ...initial("live", isMac),
  size: Option.some({ width: 800, height: 600 }),
  nodeHeights: HashMap.make(["root", 40], ["A", 64], ["P", 88]),
});
const POINT = { x: 300, y: 200 };
const expectViewport = (actual: { x: number; y: number; zoom: number }, expected: { x: number; y: number; zoom: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 6);
};
const clickWith = (over: Partial<typeof Message.ClickedMapSurfaceWithModifier.Type> = {}) =>
  Message.ClickedMapSurfaceWithModifier({ ...POINT, ctrlKey: false, metaKey: false, altKey: false, ...over });

describe("mapSurface の update: Ctrl＋ホイール（ピンチ）でズーム（live）", () => {
  it("測っただけなら zoomScale は 1 で、viewportOf は全体を収める位置のまま（倍率は 1 でない）", () => {
    const m = measuredLive();
    expect(m.zoomScale).toBe(1);
    expect(Option.isNone(m.gestureScale)).toBe(true);
    expect(viewportOf(m).zoom).not.toBe(1);
  });

  it("ポインタの位置を中心に、pinchZoomFactor の倍率で変わる。結果は zoomAtPoint と同じ", () => {
    const before = viewportOf(measuredLive());
    const factor = pinchZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: true }, false);
    expect(factor).toBeGreaterThan(1);
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, deltaY: -100, ...POINT })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, factor))),
    );
  });

  it("縮小（deltaY が正）も同じ式", () => {
    const before = viewportOf(measuredLive());
    const factor = pinchZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: true }, false);
    expect(factor).toBeLessThan(1);
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, deltaY: 100, ...POINT })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, factor))),
    );
  });

  it("Mac の Ctrl 付きは 10 倍、行単位は 0.05 倍で効く", () => {
    const before = viewportOf(measuredLive(true));
    const factor = pinchZoomFactor({ deltaY: -3, deltaMode: 1, ctrlKey: true }, true);
    story(
      update,
      given(measuredLive(true)),
      message(wheel({ ctrlKey: true, deltaY: -3, deltaMode: 1, ...POINT })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, factor))),
    );
  });

  it("続けるほど足し上がり（倍率が掛かる）、点の下のワールド座標は動かない", () => {
    const before = viewportOf(measuredLive());
    const f1 = pinchZoomFactor({ deltaY: -50, deltaMode: 0, ctrlKey: true }, false);
    const f2 = pinchZoomFactor({ deltaY: -30, deltaMode: 0, ctrlKey: true }, false);
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, deltaY: -50, ...POINT })),
      message(wheel({ ctrlKey: true, deltaY: -30, ...POINT })),
      model((m) => {
        expectViewport(viewportOf(m), zoomAtPoint(zoomAtPoint(before, POINT, f1), POINT, f2));
        const v = viewportOf(m);
        expect((POINT.x - v.x) / v.zoom).toBeCloseTo((POINT.x - before.x) / before.zoom, 6);
      }),
    );
  });

  it("倍率は 0.5〜2 に収まる", () => {
    story(
      update,
      given(measuredLive()),
      ...Array.from({ length: 20 }, () => message(wheel({ ctrlKey: true, deltaY: -500, ...POINT }))),
      model((m) => expect(viewportOf(m).zoom).toBeCloseTo(USER_MAX_ZOOM, 9)),
    );
    story(
      update,
      given(measuredLive()),
      ...Array.from({ length: 20 }, () => message(wheel({ ctrlKey: true, deltaY: 500, ...POINT }))),
      model((m) => expect(viewportOf(m).zoom).toBeCloseTo(USER_MIN_ZOOM, 9)),
    );
  });

  it("ズームしてからパンすると、パンの量だけ平行移動し、倍率は変わらない", () => {
    const zoomedModel = update(measuredLive(), wheel({ ctrlKey: true, deltaY: -100, ...POINT })).model;
    const zoomed = viewportOf(zoomedModel);
    expect(zoomed.zoom).not.toBe(viewportOf(measuredLive()).zoom);
    story(
      update,
      given(zoomedModel),
      message(wheel({ deltaX: 40, deltaY: 100 })),
      model((m) => expectViewport(viewportOf(m), { x: zoomed.x - 20, y: zoomed.y - 50, zoom: zoomed.zoom })),
    );
  });

  it("Snapshot・mode・測った結果を変えない", () => {
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, deltaY: -100, ...POINT })),
      model((m) => {
        expect(m.mode).toBe("live");
        expect(m.snapshot).toEqual(snapshot);
        expect(m.size).toEqual(Option.some({ width: 800, height: 600 }));
        expect(heightsOf(m)).toEqual({ root: 40, A: 64, P: 88 });
      }),
    );
  });

  it("still ではズームしない", () => {
    story(
      update,
      given({ ...measuredLive(), mode: "still" as const }),
      message(wheel({ ctrlKey: true, deltaY: -100, ...POINT })),
      model((m) => {
        expect(m.zoomScale).toBe(1);
        expectPan(m, 0, 0);
      }),
    );
  });

  it("⌘/Ctrl＋Shift の軸固定は先に働き、ズームしない", () => {
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, shiftKey: true, deltaX: 30, deltaY: 5, timeStamp: 1000, ...POINT })),
      model((m) => {
        expect(m.zoomScale).toBe(1);
        expectPan(m, -30, 0);
      }),
    );
  });
});

// zoomScale は操作した時点のフィット倍率との比。画面サイズの再測定でフィット倍率が変わっても、見せる倍率は 0.5〜2 に収まる
describe("mapSurface の update: フィット倍率が変わっても倍率は 0.5〜2（live）", () => {
  const SMALL = { width: 300, height: 200 };
  const LARGE = { width: 4000, height: 3000 };
  const measuredAt = (size: { width: number; height: number }): MapSurfaceModel => ({ ...measuredLive(), size: Option.some(size) });
  const resizeTo = (m: MapSurfaceModel, size: { width: number; height: number }): MapSurfaceModel =>
    update(m, Message.MeasuredMapSurface({ ...size, nodeHeights: {} })).model;
  const clickTimes = (m: MapSurfaceModel, n: number, over: Partial<typeof Message.ClickedMapSurfaceWithModifier.Type>): MapSurfaceModel =>
    Array.from({ length: n }).reduce<MapSurfaceModel>((acc) => update(acc, clickWith(over)).model, m);

  it("拡大した後に画面を大きくしても、倍率は 2 以下", () => {
    const small = measuredAt(SMALL);
    const largeFit = viewportOf(measuredAt(LARGE)).zoom;
    expect(viewportOf(small).zoom).toBeLessThan(largeFit);
    const zoomedIn = clickTimes(small, 8, { ctrlKey: true });
    expect(viewportOf(zoomedIn).zoom).toBeCloseTo(USER_MAX_ZOOM, 6);
    expect(zoomedIn.zoomScale * largeFit).toBeGreaterThan(USER_MAX_ZOOM);
    expect(viewportOf(resizeTo(zoomedIn, LARGE)).zoom).toBeLessThanOrEqual(USER_MAX_ZOOM + 1e-9);
  });

  it("縮小した後に画面を小さくしても、倍率は 0.5 以上", () => {
    const large = measuredAt(LARGE);
    const smallFit = viewportOf(measuredAt(SMALL)).zoom;
    const zoomedOut = clickTimes(large, 8, { ctrlKey: true, altKey: true });
    expect(viewportOf(zoomedOut).zoom).toBeCloseTo(USER_MIN_ZOOM, 6);
    expect(zoomedOut.zoomScale * smallFit).toBeLessThan(USER_MIN_ZOOM);
    expect(viewportOf(resizeTo(zoomedOut, SMALL)).zoom).toBeGreaterThanOrEqual(USER_MIN_ZOOM - 1e-9);
  });

  it("倍率を制限した状態からの次のズームは、見せていたビューポートからの zoomAtPoint と一致する", () => {
    const zoomedIn = clickTimes(measuredAt(SMALL), 8, { ctrlKey: true });
    const resized = resizeTo(zoomedIn, LARGE);
    const before = viewportOf(resized);
    const after = update(resized, clickWith({ ctrlKey: true, altKey: true })).model;
    expectViewport(viewportOf(after), zoomAtPoint(before, POINT, 1 / CLICK_ZOOM_FACTOR));
  });
});

describe("mapSurface の update: ⌘/Ctrl＋クリックでズーム（live）", () => {
  it("Ctrl＋クリックで、押した点を中心に CLICK_ZOOM_FACTOR（1.5）倍", () => {
    const before = viewportOf(measuredLive());
    story(
      update,
      given(measuredLive()),
      message(clickWith({ ctrlKey: true })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, CLICK_ZOOM_FACTOR))),
    );
  });

  it("⌘＋クリックも同じ", () => {
    const before = viewportOf(measuredLive());
    story(
      update,
      given(measuredLive()),
      message(clickWith({ metaKey: true })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, CLICK_ZOOM_FACTOR))),
    );
  });

  it("Alt 付きなら縮小（1.5 で割る）", () => {
    const before = viewportOf(measuredLive());
    story(
      update,
      given(measuredLive()),
      message(clickWith({ metaKey: true, altKey: true })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, 1 / CLICK_ZOOM_FACTOR))),
    );
  });

  it("ノードの選択（OutMessage）は出さない", () => {
    story(update, given(measuredLive()), message(clickWith({ ctrlKey: true })), expectNoOutMessage());
  });

  it("still ではズームしない", () => {
    story(
      update,
      given({ ...measuredLive(), mode: "still" as const }),
      message(clickWith({ ctrlKey: true })),
      model((m) => expect(m.zoomScale).toBe(1)),
    );
  });
});

describe("mapSurface の update: Safari の gesture でズーム（live）", () => {
  it("開始の後、scale の変化の比で、点を中心にズームする。scale は開始からの累積なので、1.2 → 1.5 は 1.2 倍 → 1.25 倍", () => {
    const before = viewportOf(measuredLive());
    const step1 = zoomAtPoint(before, POINT, 1.2);
    const step2 = zoomAtPoint(step1, POINT, 1.5 / 1.2);
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.2, ...POINT })),
      model((m) => expectViewport(viewportOf(m), step1)),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.5, ...POINT })),
      model((m) => expectViewport(viewportOf(m), step2)),
    );
  });

  it("縮小（scale < 1）も同じ式", () => {
    const before = viewportOf(measuredLive());
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 0.8, ...POINT })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, 0.8))),
    );
  });

  it("新しく始めると、scale は 1 から数え直す", () => {
    const before = viewportOf(measuredLive());
    const step1 = zoomAtPoint(before, POINT, 1.5);
    const step2 = zoomAtPoint(step1, POINT, 1.2);
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.5, ...POINT })),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.2, ...POINT })),
      model((m) => expectViewport(viewportOf(m), step2)),
    );
  });

  it("開始を受けていなくても、前の scale は 1 として扱う", () => {
    const before = viewportOf(measuredLive());
    story(
      update,
      given(measuredLive()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.3, ...POINT })),
      model((m) => expectViewport(viewportOf(m), zoomAtPoint(before, POINT, 1.3))),
    );
  });

  it("倍率は 0.5〜2 に収まる", () => {
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 100, ...POINT })),
      model((m) => expect(viewportOf(m).zoom).toBeCloseTo(USER_MAX_ZOOM, 9)),
    );
  });

  it("still ではズームしない", () => {
    story(
      update,
      given({ ...measuredLive(), mode: "still" as const }),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.5, ...POINT })),
      model((m) => expect(m.zoomScale).toBe(1)),
    );
  });
});
