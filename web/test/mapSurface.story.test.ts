import { HashMap, Option, Schema } from "effect";
import { expectNoOutMessage, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { blinkRestartsOf, displayedPositions, init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message, OutMessage } from "../src/app/mapSurface/message.ts";
import { CLICK_ZOOM_FACTOR, pinchZoomFactor, USER_MAX_ZOOM, USER_MIN_ZOOM, zoomAtPoint } from "../src/camera.ts";
import { foldView } from "../src/folding.ts";
import { layout } from "../src/layout.ts";
import { interpolate, startPositions } from "../src/motion.ts";

// マップの表示面（Issue #814）の update。Mount が出す Message 1 つで、画面の大きさとノードの実測を受ける。
// Model に持つのは見せ方（mode）・Snapshot・画面の大きさ・ノードの実測と、パンの状態（isMac・pointer・nodePress・scrollAxisLock）と、人が置いた位置の履歴で決まるカメラの欄だけで、配置・畳んだ後の木・カメラの目標は持たない（毎回導く）。
// カメラ（Issue #819）の欄は viewport（今見せているビューポート）と、出来事の履歴で決まる事実（placedRound・keepAnchor・pendingShift）と、見返しの 10 秒を計り直す idleStamp

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題"): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [] });
const snapshot: Snapshot = { nodes: [node("root", null, "会議"), node("A", "root"), node("P", "A", "論点")], round: 1, changes: [], remarks: [] };

const initial = (mode: MapSurfaceModel["mode"] = "still", isMac = false): MapSurfaceModel => init(snapshot, mode, isMac);
const MODEL_FIELDS = [
  "gestureScale",
  "idleStamp",
  "isMac",
  "keepAnchor",
  "mode",
  "motion",
  "nodeHeights",
  "nodePress",
  "pendingShift",
  "placedRound",
  "pointer",
  "scrollAxisLock",
  "size",
  "snapshot",
  "speakerNames",
  "viewing",
  "viewport",
];
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

  it("update の後も Model の欄は決まった 17 個だけ（配置・畳んだ後の木・カメラの目標を足さない。pan・zoomScale は無い）", () => {
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
  it("欄は mode・snapshot・size・nodeHeights と、パンの isMac・pointer・nodePress・scrollAxisLock と、補間の motion と、見る状態の viewing と、ズームの gestureScale と、カメラの viewport・placedRound・keepAnchor・pendingShift・idleStamp と、話者の名前の表 speakerNames（Issue #1026）の 17 個だけ", () => {
    expect(Object.keys(Model.fields).sort()).toEqual(MODEL_FIELDS);
  });

  it("本物の Model は通り、「無い」を null で書いた Model・知らない mode は通らない。mode は still・live・review の 3 つ", () => {
    const is = Schema.is(Model);
    expect(is(initial("still"))).toBe(true);
    expect(is(initial("live"))).toBe(true);
    expect(is(initial("review"))).toBe(true);
    expect(is({ ...initial(), size: null })).toBe(false);
    expect(is({ ...initial(), mode: "zoom" })).toBe(false);
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

  it("初期は viewport (0, 0, 倍率 1)・pointer と nodePress と scrollAxisLock は None。isMac は init の引数のまま", () => {
    const m = initial("live", true);
    expect(m.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
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
    expect(is({ ...initial(), viewport: { x: "1", y: 0, zoom: 1 } })).toBe(false);
    expect(is({ ...initial(), viewport: { x: Number.NaN, y: 0, zoom: 1 } })).toBe(false);
    expect(is({ ...initial(), viewport: { x: 0, y: 0 } })).toBe(false);
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

// 画面上の移動量の比較。測っていない Model の viewport は原点・倍率 1 から始まるので、移動量はそのまま viewport の x・y になる（倍率は変わらない）。-0 と 0 は区別しない
const expectPan = (m: MapSurfaceModel, x: number, y: number) => {
  expect(m.viewport.x).toBeCloseTo(x, 9);
  expect(m.viewport.y).toBeCloseTo(y, 9);
  expect(m.viewport.zoom).toBe(1);
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

  it("Mac の ⌘ だけの wheel は、パンもズームもしない。動かしていないので自動のカメラも止めない", () => {
    const before = measuredLive(true);
    story(
      update,
      given(before),
      message(wheel({ deltaX: 40, deltaY: 100, metaKey: true, x: 300, y: 200 })),
      model((m) => {
        expect(m.viewport).toEqual(before.viewport);
        expect(m.viewing).toEqual({ mode: "auto" });
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
  it("スクロール・軸固定・ドラッグのどれでも viewport は変わらない（見る状態も変えない）", () => {
    story(
      update,
      given(initial("still")),
      message(wheel({ deltaX: 40, deltaY: 100 })),
      message(wheel({ deltaX: 30, deltaY: 5, shiftKey: true, metaKey: true, timeStamp: 1000 })),
      message(pressPane()),
      message(movePointer(130, 90)),
      model((m) => {
        expectPan(m, 0, 0);
        expect(m.viewing).toEqual({ mode: "auto" });
      }),
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

// ズーム（Issue #816）。ビューポートは Model の viewport で、見せる値と update が使う値は同じ。結果は zoomAtPoint と同じ（今の @xyflow／MapView と同じだけ変わる）。
// 測った後の viewport は、自動のカメラが全体を収めた位置（この Snapshot に今の議題は無い）
const measuredLive = (isMac = false): MapSurfaceModel => update(initial("live", isMac), Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, A: 64, P: 88 } })).model;
// still は同じ寸法を測った Model（全体を収めた viewport。ズームもパンも受けない）
const stillMeasured = (): MapSurfaceModel => update(initial("still"), Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, A: 64, P: 88 } })).model;
const POINT = { x: 300, y: 200 };
const expectViewport = (actual: { x: number; y: number; zoom: number }, expected: { x: number; y: number; zoom: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 6);
};
const clickWith = (over: Partial<typeof Message.ClickedMapSurfaceWithModifier.Type> = {}) =>
  Message.ClickedMapSurfaceWithModifier({ ...POINT, ctrlKey: false, metaKey: false, altKey: false, ...over });

describe("mapSurface の update: Ctrl＋ホイール（ピンチ）でズーム（live）", () => {
  it("測っただけなら viewport は全体を収める位置になり（倍率は 1 でない）、gestureScale は None、見る状態は自動のまま", () => {
    const m = measuredLive();
    expect(Option.isNone(m.gestureScale)).toBe(true);
    expect(m.viewport.zoom).not.toBe(1);
    expect(m.viewing).toEqual({ mode: "auto" });
  });

  it("ポインタの位置を中心に、pinchZoomFactor の倍率で変わる。結果は zoomAtPoint と同じ", () => {
    const before = measuredLive().viewport;
    const factor = pinchZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: true }, false);
    expect(factor).toBeGreaterThan(1);
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, deltaY: -100, ...POINT })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, factor))),
    );
  });

  it("縮小（deltaY が正）も同じ式", () => {
    const before = measuredLive().viewport;
    const factor = pinchZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: true }, false);
    expect(factor).toBeLessThan(1);
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, deltaY: 100, ...POINT })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, factor))),
    );
  });

  it("Mac の Ctrl 付きは 10 倍、行単位は 0.05 倍で効く", () => {
    const before = measuredLive(true).viewport;
    const factor = pinchZoomFactor({ deltaY: -3, deltaMode: 1, ctrlKey: true }, true);
    story(
      update,
      given(measuredLive(true)),
      message(wheel({ ctrlKey: true, deltaY: -3, deltaMode: 1, ...POINT })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, factor))),
    );
  });

  it("続けるほど足し上がり（倍率が掛かる）、点の下のワールド座標は動かない", () => {
    const before = measuredLive().viewport;
    const f1 = pinchZoomFactor({ deltaY: -50, deltaMode: 0, ctrlKey: true }, false);
    const f2 = pinchZoomFactor({ deltaY: -30, deltaMode: 0, ctrlKey: true }, false);
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, deltaY: -50, ...POINT })),
      message(wheel({ ctrlKey: true, deltaY: -30, ...POINT })),
      model((m) => {
        expectViewport(m.viewport, zoomAtPoint(zoomAtPoint(before, POINT, f1), POINT, f2));
        const v = m.viewport;
        expect((POINT.x - v.x) / v.zoom).toBeCloseTo((POINT.x - before.x) / before.zoom, 6);
      }),
    );
  });

  it("倍率は 0.5〜2 に収まる", () => {
    story(
      update,
      given(measuredLive()),
      ...Array.from({ length: 20 }, () => message(wheel({ ctrlKey: true, deltaY: -500, ...POINT }))),
      model((m) => expect(m.viewport.zoom).toBeCloseTo(USER_MAX_ZOOM, 9)),
    );
    story(
      update,
      given(measuredLive()),
      ...Array.from({ length: 20 }, () => message(wheel({ ctrlKey: true, deltaY: 500, ...POINT }))),
      model((m) => expect(m.viewport.zoom).toBeCloseTo(USER_MIN_ZOOM, 9)),
    );
  });

  it("ズームしてからパンすると、パンの量だけ平行移動し、倍率は変わらない", () => {
    const zoomedModel = update(measuredLive(), wheel({ ctrlKey: true, deltaY: -100, ...POINT })).model;
    const zoomed = zoomedModel.viewport;
    expect(zoomed.zoom).not.toBe(measuredLive().viewport.zoom);
    story(
      update,
      given(zoomedModel),
      message(wheel({ deltaX: 40, deltaY: 100 })),
      model((m) => expectViewport(m.viewport, { x: zoomed.x - 20, y: zoomed.y - 50, zoom: zoomed.zoom })),
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
    const before = stillMeasured();
    story(
      update,
      given(before),
      message(wheel({ ctrlKey: true, deltaY: -100, ...POINT })),
      model((m) => expect(m.viewport).toEqual(before.viewport)),
    );
  });

  it("⌘/Ctrl＋Shift の軸固定は先に働き、ズームしない", () => {
    story(
      update,
      given(measuredLive()),
      message(wheel({ ctrlKey: true, shiftKey: true, deltaX: 30, deltaY: 5, timeStamp: 1000, ...POINT })),
      model((m) => {
        const before = measuredLive().viewport;
        expectViewport(m.viewport, { x: before.x - 30, y: before.y, zoom: before.zoom });
      }),
    );
  });
});

// 人が置いた viewport は絶対の値で、画面の大きさが変わっても動かない（全体を収める位置との比ではない）。倍率は 0.5〜2 のまま
describe("mapSurface の update: 画面の大きさが変わっても、人が置いた viewport は動かない（live）", () => {
  const SMALL = { width: 300, height: 200 };
  const LARGE = { width: 4000, height: 3000 };
  const measuredAt = (size: { width: number; height: number }): MapSurfaceModel => update(initial("live"), Message.MeasuredMapSurface({ ...size, nodeHeights: { root: 40, A: 64, P: 88 } })).model;
  const resizeTo = (m: MapSurfaceModel, size: { width: number; height: number }): MapSurfaceModel => update(m, Message.MeasuredMapSurface({ ...size, nodeHeights: {} })).model;
  const clickTimes = (m: MapSurfaceModel, n: number, over: Partial<typeof Message.ClickedMapSurfaceWithModifier.Type>): MapSurfaceModel =>
    Array.from({ length: n }).reduce<MapSurfaceModel>((acc) => update(acc, clickWith(over)).model, m);

  it("拡大した後に画面を大きくしても、viewport は変わらず、倍率は 2 のまま", () => {
    const zoomedIn = clickTimes(measuredAt(SMALL), 8, { ctrlKey: true });
    expect(zoomedIn.viewport.zoom).toBeCloseTo(USER_MAX_ZOOM, 6);
    expect(zoomedIn.viewing.mode).toBe("manual");
    expect(resizeTo(zoomedIn, LARGE).viewport).toEqual(zoomedIn.viewport);
  });

  it("縮小した後に画面を小さくしても、viewport は変わらず、倍率は 0.5 のまま", () => {
    const zoomedOut = clickTimes(measuredAt(LARGE), 8, { ctrlKey: true, altKey: true });
    expect(zoomedOut.viewport.zoom).toBeCloseTo(USER_MIN_ZOOM, 6);
    expect(resizeTo(zoomedOut, SMALL).viewport).toEqual(zoomedOut.viewport);
  });

  it("大きさが変わった後の次のズームは、見せていた viewport からの zoomAtPoint と一致する", () => {
    const zoomedIn = clickTimes(measuredAt(SMALL), 8, { ctrlKey: true });
    const resized = resizeTo(zoomedIn, LARGE);
    const after = update(resized, clickWith({ ctrlKey: true, altKey: true })).model;
    expectViewport(after.viewport, zoomAtPoint(resized.viewport, POINT, 1 / CLICK_ZOOM_FACTOR));
  });
});

describe("mapSurface の update: ⌘/Ctrl＋クリックでズーム（live）", () => {
  it("Ctrl＋クリックで、押した点を中心に CLICK_ZOOM_FACTOR（1.5）倍", () => {
    const before = measuredLive().viewport;
    story(
      update,
      given(measuredLive()),
      message(clickWith({ ctrlKey: true })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, CLICK_ZOOM_FACTOR))),
    );
  });

  it("⌘＋クリックも同じ", () => {
    const before = measuredLive().viewport;
    story(
      update,
      given(measuredLive()),
      message(clickWith({ metaKey: true })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, CLICK_ZOOM_FACTOR))),
    );
  });

  it("Alt 付きなら縮小（1.5 で割る）", () => {
    const before = measuredLive().viewport;
    story(
      update,
      given(measuredLive()),
      message(clickWith({ metaKey: true, altKey: true })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, 1 / CLICK_ZOOM_FACTOR))),
    );
  });

  it("ノードの選択（OutMessage）は出さない", () => {
    story(update, given(measuredLive()), message(clickWith({ ctrlKey: true })), expectNoOutMessage());
  });

  it("still ではズームしない", () => {
    story(
      update,
      given(stillMeasured()),
      message(clickWith({ ctrlKey: true })),
      model((m) => expect(m.viewport).toEqual(stillMeasured().viewport)),
    );
  });
});

describe("mapSurface の update: Safari の gesture でズーム（live）", () => {
  it("開始の後、scale の変化の比で、点を中心にズームする。scale は開始からの累積なので、1.2 → 1.5 は 1.2 倍 → 1.25 倍", () => {
    const before = measuredLive().viewport;
    const step1 = zoomAtPoint(before, POINT, 1.2);
    const step2 = zoomAtPoint(step1, POINT, 1.5 / 1.2);
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.2, ...POINT })),
      model((m) => expectViewport(m.viewport, step1)),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.5, ...POINT })),
      model((m) => expectViewport(m.viewport, step2)),
    );
  });

  it("縮小（scale < 1）も同じ式", () => {
    const before = measuredLive().viewport;
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 0.8, ...POINT })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, 0.8))),
    );
  });

  it("新しく始めると、scale は 1 から数え直す", () => {
    const before = measuredLive().viewport;
    const step1 = zoomAtPoint(before, POINT, 1.5);
    const step2 = zoomAtPoint(step1, POINT, 1.2);
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.5, ...POINT })),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.2, ...POINT })),
      model((m) => expectViewport(m.viewport, step2)),
    );
  });

  it("開始を受けていなくても、前の scale は 1 として扱う", () => {
    const before = measuredLive().viewport;
    story(
      update,
      given(measuredLive()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.3, ...POINT })),
      model((m) => expectViewport(m.viewport, zoomAtPoint(before, POINT, 1.3))),
    );
  });

  it("倍率は 0.5〜2 に収まる", () => {
    story(
      update,
      given(measuredLive()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 100, ...POINT })),
      model((m) => expect(m.viewport.zoom).toBeCloseTo(USER_MAX_ZOOM, 9)),
    );
  });

  it("still ではズームしない", () => {
    story(
      update,
      given(stillMeasured()),
      message(Message.StartedMapSurfaceGesture()),
      message(Message.ChangedMapSurfaceGesture({ scale: 1.5, ...POINT })),
      model((m) => expect(m.viewport).toEqual(stillMeasured().viewport)),
    );
  });
});

describe("mapSurface の update: キーの一覧の開閉（ToggledKeyList）", () => {
  it("idleStamp が 1 進むだけで、ほかの欄はすべて等しい（OutMessage も出ない）", () => {
    const before = measuredLive();
    story(
      update,
      given(before),
      message(Message.ToggledKeyList()),
      model((m) => expect(m).toEqual({ ...before, idleStamp: before.idleStamp + 1 })),
      expectNoOutMessage(),
    );
  });
});

// 反映番号が変わった後も点滅の対象のノードがあるとき、点滅を最初から再生し直す Command（RestartBlink）を求める入口（blinkRestartsOf）
describe("mapSurface: 反映番号が変わったら点滅をやり直す（blinkRestartsOf）", () => {
  const change = (nodeId: string, round: number): Snapshot["changes"][number] => ({ change: "更新", node: nodeId, kind: "論点", text: nodeId, round, at: 0 }) as Snapshot["changes"][number];
  // 直接変わるノード P（今の議題 B の下）と、畳まれた済みの議題 A の中の A1（畳んだ A が点滅の対象になる）
  const nodesOf = (): SnapshotNode[] => [
    node("root", null, "会議"),
    { ...node("A", "root"), talkStatus: "済み" },
    node("A1", "A", "論点"),
    node("B", "root"),
    node("P", "B", "論点"),
  ];
  const snapAt = (round: number, changed: string[]): Snapshot => ({ nodes: nodesOf(), round, changes: changed.map((id) => change(id, round)), remarks: [], currentTopic: "B", now: 10 });
  const surfaceAt = (round: number, changed: string[], mode: MapSurfaceModel["mode"] = "review"): MapSurfaceModel =>
    update(init(snapAt(round, changed), mode, false), Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, A: 40, A1: 40, B: 40, P: 40 } })).model;
  const names = (commands: ReadonlyArray<{ name: string }>) => commands.map((c) => c.name);

  it("直接変わったノードが、反映をまたいでも点滅の対象のとき RestartBlink を返す", () => {
    expect(names(blinkRestartsOf(surfaceAt(2, ["P"]), surfaceAt(3, ["P"])))).toEqual(["RestartBlink"]);
  });

  it("畳んだノード（shownAs）が、反映をまたいでも点滅の対象のとき RestartBlink を返す", () => {
    expect(names(blinkRestartsOf(surfaceAt(2, ["A1"]), surfaceAt(3, ["A1"])))).toEqual(["RestartBlink"]);
  });

  it("反映番号が変わらない（選択・カメラ・補間の Tick などの再描画）では返さない", () => {
    const before = surfaceAt(2, ["P"]);
    expect(blinkRestartsOf(before, before)).toEqual([]);
    expect(blinkRestartsOf(before, update(before, Message.ClickedNodeButton({ nodeId: "P", clientX: 0, clientY: 0 })).model)).toEqual([]);
    expect(blinkRestartsOf(before, update(before, Message.TickedAnimationFrame({ deltaMs: 16 })).model)).toEqual([]);
  });

  it("反映番号が変わっても、変わった後に点滅の対象が無ければ返さない", () => {
    expect(blinkRestartsOf(surfaceAt(2, ["P"]), surfaceAt(3, []))).toEqual([]);
  });

  it("測定前（size が None）と still では返さない", () => {
    const unmeasured = init(snapAt(3, ["P"]), "review", false);
    expect(blinkRestartsOf(surfaceAt(2, ["P"]), unmeasured)).toEqual([]);
    expect(blinkRestartsOf(surfaceAt(2, ["P"], "still"), surfaceAt(3, ["P"], "still"))).toEqual([]);
  });

  it("CompletedRestartBlink は何も変えない", () => {
    const before = surfaceAt(3, ["P"]);
    story(update, given(before), message(Message.CompletedRestartBlink()), model((m) => expect(m).toEqual(before)));
  });
});

// 狭い幅の根拠のシートの閉じるボタン（Issue #969）。Esc と違い、選びだけを外す
describe("mapSurface の update: 根拠のシートの閉じるボタン（ClickedEvidenceClose）", () => {
  it("選んでいたノードの選びが外れ、カメラのモードと人の開閉は残る", () => {
    const before: MapSurfaceModel = { ...measuredLive(), viewing: { mode: "manual", topic: "A", humanOpened: new Set(["A"]), selection: { id: "P", byKey: false } } };
    story(
      update,
      given(before),
      message(Message.ClickedEvidenceClose()),
      model((m) => expect(m.viewing).toEqual({ mode: "manual", topic: "A", humanOpened: new Set(["A"]) })),
    );
  });

  it("選んでいないときに押しても、選びは無いまま", () => {
    story(
      update,
      given(measuredLive()),
      message(Message.ClickedEvidenceClose()),
      model((m) => expect("selection" in m.viewing).toBe(false)),
    );
  });
});
