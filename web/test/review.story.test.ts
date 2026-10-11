import { HashMap, Option, Schema } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init, Model, makeUpdate, snapshotOf } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { initialPlayback, PLAYBACK_RATES } from "../src/reviewPlayback.ts";
import { snapshotAt, topicNameOf } from "../src/reviewTimeline.ts";
import * as MapSurface from "../src/app/mapSurface/main.ts";
import { cameraFocus, fitViewport, screenPoint, USER_MAX_ZOOM } from "../src/camera.ts";
import { NODE_WIDTH } from "../src/layout.ts";

// 見返しの Foldkit プログラム（Issue #823）の update。Model に持つのは再生の状態と表示面の実測だけ。
// 時刻 → その時刻のマップ（Snapshot）は、時間軸（Model の外の Context）から毎回導く。反映の時刻への移動（prev・next）は playbackReducer の規則

// 反映 1: 時刻 10（r1）で「採用」、反映 2: 時刻 30（r2）で「予算」と論点。会議の長さは 30
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
const update = makeUpdate(context);
const at = (time: number): Model => {
  const start = init(context);
  return { ...start, playback: { ...start.playback, time } };
};
const topicsOf = (snapshot: Snapshot): string[] => snapshot.nodes.filter((n) => n.kind === "議題" || n.kind === "論点").map((n) => n.text);
const topicsAt = (time: number): string[] => topicsOf(snapshotOf(context, at(time)));

describe("見返しの Model: 本物の Schema で、再生の状態だけを持つ", () => {
  // 操作の行（#825）の状態（Slider・Menu・Tooltip の子の Model、ポインタの位置、押している最中か、字幕と右の列を隠しているか）が加わる。
  // 時間軸・Snapshot・配置・章・印は導いた値なので、これからも Model に入れない
  const FIELDS = ["captionsHidden", "isPressingSlider", "mapSurface", "maybeSeekPointer", "playback", "rateMenu", "seekSlider", "sideHidden", "tooltips", "volumeSlider"];
  it("欄は 再生の状態・表示面の実測・操作の行の状態 だけ（時間軸・Snapshot・配置・章・印を持たない）", () => {
    expect(Object.keys(Model.fields).sort()).toEqual(FIELDS);
    expect(Object.keys(init(context)).sort()).toEqual(FIELDS);
  });

  it("最初は会議の終わりの時刻で止まり、表示面は未測定（Option の None と空の HashMap）", () => {
    const m = init(context);
    expect(m.playback).toEqual(initialPlayback(30));
    expect(m.playback.time).toBe(30);
    expect(m.playback.playing).toBe(false);
    expect(Option.isNone(m.mapSurface.size)).toBe(true);
    expect(HashMap.size(m.mapSurface.nodeHeights)).toBe(0);
  });

  it("本物の Model は通り、壊した playback・null の size・素のオブジェクトの nodeHeights は通らない", () => {
    const is = Schema.is(Model);
    const m = init(context);
    expect(is(m)).toBe(true);
    expect(is({ ...m, playback: { ...m.playback, time: "10" } })).toBe(false);
    expect(is({ ...m, playback: { ...m.playback, playing: 1 } })).toBe(false);
    expect(is({ ...m, playback: { time: 10 } })).toBe(false);
    expect(is({ ...m, mapSurface: { ...m.mapSurface, size: null } })).toBe(false);
    expect(is({ ...m, mapSurface: { ...m.mapSurface, nodeHeights: { A: 40 } } })).toBe(false);
  });
});

describe("見返しの Snapshot: 時刻から導く", () => {
  it("時刻ごとに、その時刻までに反映されたマップになる（0・10・29・30）", () => {
    expect(topicsAt(0)).toEqual([]);
    expect(topicsAt(10)).toEqual(["採用"]);
    expect(topicsAt(29)).toEqual(["採用"]);
    expect(topicsAt(30)).toEqual(["採用", "予算", "上限をどうするか"]);
  });

  it("既存の snapshotAt と同じ結果（時間軸の規則を作り直していない）", () => {
    for (const time of [0, 10, 29, 30]) expect(snapshotOf(context, at(time))).toEqual(snapshotAt(context.timeline, time));
  });

  it("同じ区間の時刻では、同じ Snapshot を返す", () => {
    expect(snapshotOf(context, at(10))).toBe(snapshotOf(context, at(29)));
    expect(snapshotOf(context, at(10))).not.toBe(snapshotOf(context, at(30)));
  });
});

describe("見返しの update: 反映の時刻への移動", () => {
  it("1 つの続いた Model の上で、前へ・次へと動かすと、時刻とその時刻の Snapshot が追従する", () => {
    const seen: string[][] = [];
    const record = (m: Model) => seen.push(topicsOf(snapshotOf(context, m)));
    story(
      update,
      given(init(context)),
      model((m) => {
        expect(m.playback.time).toBe(30);
        record(m);
      }),
      message(Message.ClickedPrev()),
      model((m) => {
        expect(m.playback.time).toBe(10);
        record(m);
      }),
      message(Message.ClickedPrev()),
      model((m) => {
        expect(m.playback.time).toBe(10); // 手前に反映が無いので動かない
        record(m);
      }),
      message(Message.ClickedNext()),
      model((m) => {
        expect(m.playback.time).toBe(30);
        record(m);
      }),
      message(Message.ClickedNext()),
      model((m) => {
        expect(m.playback.time).toBe(30); // 先に反映が無いので動かない
        record(m);
      }),
    );
    expect(seen).toEqual([["採用", "予算", "上限をどうするか"], ["採用"], ["採用"], ["採用", "予算", "上限をどうするか"], ["採用", "予算", "上限をどうするか"]]);
  });

  it("反映と反映の間の時刻からは、手前・先の反映の時刻へ動く", () => {
    story(
      update,
      given(at(20)),
      message(Message.ClickedNext()),
      model((m) => expect(m.playback.time).toBe(30)),
    );
    story(
      update,
      given(at(20)),
      message(Message.ClickedPrev()),
      model((m) => expect(m.playback.time).toBe(10)),
    );
  });

  it("最初の反映より前の時刻（0）から次へ動くと、最初の反映の時刻になる", () => {
    story(
      update,
      given(at(0)),
      message(Message.ClickedNext()),
      model((m) => expect(m.playback.time).toBe(10)),
    );
  });

  it("移動は時刻だけを変える。playing・rate・muted・volume と表示面の実測は変わらず、Command も無い", () => {
    const start = { ...at(30), playback: { time: 30, playing: true, rate: PLAYBACK_RATES[3]!, muted: true, volume: 0.4 } };
    const result = update(start, Message.ClickedPrev());
    expect(result.model.playback).toEqual({ time: 10, playing: true, rate: PLAYBACK_RATES[3], muted: true, volume: 0.4 });
    expect(result.model.mapSurface).toEqual(start.mapSurface);
    expect(result.commands ?? []).toEqual([]);
  });
});

describe("見返しの update: 表示面の実測", () => {
  it("GotMapSurfaceMessage で、画面の大きさとノードの高さが入り、再生の状態は変わらない", () => {
    story(
      update,
      given(at(10)),
      message(Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, t1: 64 } }) })),
      model((m) => {
        expect(m.mapSurface.size).toEqual(Option.some({ width: 800, height: 600 }));
        expect(Object.fromEntries(HashMap.toEntries(m.mapSurface.nodeHeights))).toEqual({ root: 40, t1: 64 });
        expect(m.playback).toEqual(at(10).playback);
      }),
    );
  });

  it("実測の後に時刻を動かしても、実測は残り、Snapshot は新しい時刻のものになる", () => {
    story(
      update,
      given(at(10)),
      message(Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40 } }) })),
      message(Message.ClickedNext()),
      model((m) => {
        expect(m.playback.time).toBe(30);
        expect(m.mapSurface.size).toEqual(Option.some({ width: 800, height: 600 }));
        expect(HashMap.has(m.mapSurface.nodeHeights, "root")).toBe(true);
        expect(topicsOf(snapshotOf(context, m))).toEqual(["採用", "予算", "上限をどうするか"]);
      }),
    );
  });
});

// 見る状態（Issue #818）は表示面の Model.viewing に持ち、見返しの Model.mapSurface に持ち越される（時刻を動かしても残る）
describe("見返しの update: 表示面の見る状態", () => {
  it("初期は自動のカメラ・選択なしで、本物の Model に通る", () => {
    expect(init(context).mapSurface.viewing).toEqual({ mode: "auto" });
    expect(Schema.is(Model)(init(context))).toBe(true);
  });

  it("表示面のノードを click して選ぶと mapSurface.viewing に入り、時刻を動かしても残る", () => {
    story(
      update,
      given(at(30)),
      message(Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.ClickedNodeButton({ nodeId: "t2", clientX: 0, clientY: 0 }) })),
      model((m) => expect(m.mapSurface.viewing).toEqual({ mode: "auto", selection: { id: "t2", byKey: false } })),
      message(Message.ClickedPrev()),
      model((m) => {
        expect(m.playback.time).toBe(10);
        expect(m.mapSurface.viewing).toEqual({ mode: "auto", selection: { id: "t2", byKey: false } });
      }),
    );
  });
});

// カメラ（Issue #819）。見返しの表示面は mode が review で、人が動かして止めた後、触らずに 10 秒たつ（ElapsedIdleTime）と自動に戻る。
// 表示面の新しい欄（viewport・idleStamp など）は、見返しの Model.mapSurface に持ち越される（時刻を動かしても残る）
describe("見返しの update: 表示面のカメラ", () => {
  const surface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
  const measured = (m: Model): Model => update(m, surface(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, t1: 40, t2: 40, p1: 40 } }))).model;
  const scrolled = (m: Model): Model =>
    update(m, surface(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 40, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 }))).model;

  it("人が動かすと見る状態が manual になり、viewport と idleStamp が mapSurface に残る。時刻を動かしても残る", () => {
    const base = measured(at(30));
    story(
      update,
      given(base),
      message(surface(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 40, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 }))),
      model((m) => {
        expect(m.mapSurface.viewing.mode).toBe("manual");
        expect(m.mapSurface.viewport.x).toBeCloseTo(base.mapSurface.viewport.x - 20, 9);
        expect(m.mapSurface.viewport.y).toBeCloseTo(base.mapSurface.viewport.y - 50, 9);
        expect(m.mapSurface.idleStamp).not.toBe(base.mapSurface.idleStamp);
      }),
      message(Message.ClickedPrev()),
      model((m) => {
        expect(m.playback.time).toBe(10);
        expect(m.mapSurface.viewing.mode).toBe("manual");
        expect(m.mapSurface.viewport).toEqual(scrolled(base).mapSurface.viewport);
        expect(m.mapSurface.idleStamp).toBe(scrolled(base).mapSurface.idleStamp);
      }),
    );
  });

  it("止めている間に 10 秒が過ぎる（ElapsedIdleTime）と、自動に戻り、viewport は寄せ直される", () => {
    const moved = scrolled(measured(at(30)));
    expect(moved.mapSurface.viewing.mode).toBe("manual");
    story(
      update,
      given(moved),
      message(surface(MapSurfaceMessage.ElapsedIdleTime())),
      model((m) => {
        expect(m.mapSurface.viewing).toEqual({ mode: "auto" });
        expect(m.mapSurface.viewport).not.toEqual(moved.mapSurface.viewport);
      }),
    );
  });

  it("自動のままなら、ElapsedIdleTime は何も変えない", () => {
    const base = measured(at(30));
    story(
      update,
      given(base),
      message(surface(MapSurfaceMessage.ElapsedIdleTime())),
      model((m) => {
        expect(m.mapSurface.viewing).toEqual({ mode: "auto" });
        expect(m.mapSurface.viewport).toEqual(base.mapSurface.viewport);
      }),
    );
  });

  // 時刻の変更で Snapshot が別のものになったら、表示面へ ChangedSnapshot を渡して補間を捨てた結果が viewport になる
  const expectedAfter = (before: Model, to: number) =>
    MapSurface.skipMotion(
      MapSurface.update({ mode: "review", snapshot: snapshotAt(context.timeline, before.playback.time), ...before.mapSurface }, MapSurfaceMessage.ChangedSnapshot({ snapshot: snapshotAt(context.timeline, to) })).model,
    );
  const expectFollowed = (before: Model, after: Model, to: number) => {
    const expected = expectedAfter(before, to);
    expect(after.playback.time).toBe(to);
    expect(after.mapSurface.viewport.x).toBeCloseTo(expected.viewport.x, 9);
    expect(after.mapSurface.viewport.y).toBeCloseTo(expected.viewport.y, 9);
    expect(after.mapSurface.viewport.zoom).toBeCloseTo(expected.viewport.zoom, 9);
    expect(after.mapSurface.viewport).not.toEqual(before.mapSurface.viewport);
  };

  it("自動・測定済みで prev すると、viewport が移動先の Snapshot へ寄せ直される", () => {
    const before = measured(at(30));
    expect(topicNameOf(snapshotOf(context, before))).not.toBe(topicNameOf(snapshotAt(context.timeline, 10)));
    story(update, given(before), message(Message.ClickedPrev()), model((m) => expectFollowed(before, m, 10)));
  });

  it("自動・測定済みで next すると、viewport が移動先の Snapshot へ寄せ直される", () => {
    const before = measured(at(10));
    story(update, given(before), message(Message.ClickedNext()), model((m) => expectFollowed(before, m, 30)));
  });

  it("自動・測定済みで再生が進んで Snapshot が変わると（TickedFrame）、viewport が寄せ直される", () => {
    const start = measured(at(5));
    const before = { ...start, playback: { ...start.playback, playing: true, rate: 1 } };
    story(update, given(before), message(Message.TickedFrame({ ms: 5000 })), model((m) => expectFollowed(before, m, 10)));
  });

  it("自動・測定済みで曲が終わると（EndedAudio）、viewport が寄せ直される", () => {
    const start = measured(at(10));
    const before = { ...start, playback: { ...start.playback, playing: true, rate: 1 } };
    story(update, given(before), message(Message.EndedAudio()), model((m) => expectFollowed(before, m, 30)));
  });

  it("Snapshot が変わらない時刻変更と、時刻を変えない操作では mapSurface を変えない", () => {
    const before = measured(at(10));
    const start = { ...before, playback: { ...before.playback, playing: true, rate: 1 } };
    story(update, given(start), message(Message.TickedFrame({ ms: 19000 })), model((m) => {
      expect(m.playback.time).toBe(29);
      expect(m.mapSurface).toEqual(before.mapSurface);
    }));
    expect(update(before, Message.ClickedMute()).model.mapSurface).toEqual(before.mapSurface);
  });
});

// 見返しは補間を進める Tick を持たないので、子の update が補間（motion）を始めても、保存する Model は最終配置になる。
// カメラの計算と view の描画が同じ最終配置を使うことを、保存された Model から view と同じ式（displayedPositions → screenPoint）で描く位置を求めて確かめる。
// 時間軸はこの describe の中だけで使う: 議題 t1（論点 q1・q2）の後に、今の議題 t2 が来る（t1 は今の議題でないので、丸で開閉できる）
describe("見返しの update: 開閉の後の最終配置とカメラ", () => {
  const ctx = makeContext([
    { at: "a", type: "start", title: "定例" },
    remark("r1", 10, "採用の話をします。"),
    diff(["r1"], [add("t1", "root", "議題", "採用", ["r1"]), add("q1", "t1", "論点", "一つ目", ["r1"]), add("q2", "t1", "論点", "二つ目", ["r1"])]),
    remark("r2", 30, "予算です。"),
    diff(["r2"], [add("t2", "root", "議題", "予算", ["r2"]), add("p1", "t2", "論点", "上限をどうするか", ["r2"])]),
  ]);
  const upd = makeUpdate(ctx);
  const surfaceOf = (m: Model): MapSurface.Model => ({ mode: "review", snapshot: snapshotOf(ctx, m), ...m.mapSurface });
  const got = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
  const idOf = (text: string): string => snapshotAt(ctx.timeline, 30).nodes.find((n) => n.text === text)!.id;
  const T1 = idOf("採用");
  const HEIGHTS = { root: 40, [T1]: 40, [idOf("一つ目")]: 40, [idOf("二つ目")]: 200, [idOf("予算")]: 40, [idOf("上限をどうするか")]: 40 };
  const measureMsg = (nodeHeights: Record<string, number> = HEIGHTS) => got(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights }));
  const keyMsg = (k: "F") => got(MapSurfaceMessage.PressedViewKey({ key: k, metaKey: false, ctrlKey: false, altKey: false }));
  const wheelMsg = got(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 40, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 }));
  const clickDot = (nodeId: string) => got(MapSurfaceMessage.ClickedFoldDot({ nodeId }));
  const run = (start: Model, ...messages: Message[]): Model => messages.reduce((m, next) => upd(m, next).model, start);
  const initial = (): Model => {
    const start = init(ctx);
    return { ...start, playback: { ...start.playback, time: 30 } };
  };
  // view と同じ式で描く、ノードの画面座標
  const drawnAt = (m: Model, id: string) => {
    const surface = surfaceOf(m);
    return screenPoint(surface.viewport, MapSurface.displayedPositions(surface)[id]!);
  };
  const expectDrawnAt = (m: Model, id: string, point: { x: number; y: number }) => {
    const at = drawnAt(m, id);
    expect(at.x).toBeCloseTo(point.x, 6);
    expect(at.y).toBeCloseTo(point.y, 6);
  };
  // 前提: 子の update は補間を始め、t1 のいずれかのノードの始まりの位置と目標の位置が違う（保存の前の結果）
  const expectChildStartsMotion = (m: Model, message: Message) => {
    if (message._tag !== "GotMapSurfaceMessage") throw new Error("GotMapSurfaceMessage を渡す");
    const child = MapSurface.update(surfaceOf(m), message.message).model;
    expect(Option.isSome(child.motion)).toBe(true);
    const target = MapSurface.displayedPositions({ ...child, motion: Option.none() });
    const shown = MapSurface.displayedPositions(child);
    expect(Object.keys(target).some((id) => Math.abs(target[id]!.x - shown[id]!.x) + Math.abs(target[id]!.y - shown[id]!.y) > 1e-3)).toBe(true);
  };

  it("止めている間（manual）に丸を押すと、押したノードの画面座標は押す前と同じ。位置を保っている間に高さが変わっても同じ。motion は保存しない", () => {
    const start = run(initial(), measureMsg(), wheelMsg);
    expect(start.mapSurface.viewing.mode).toBe("manual");
    const point = drawnAt(start, T1);
    expectChildStartsMotion(start, clickDot(T1));
    story(
      upd,
      given(start),
      message(clickDot(T1)),
      model((m) => {
        expect(Option.isNone(m.mapSurface.motion)).toBe(true);
        expect(m.mapSurface.viewport.zoom).toBe(start.mapSurface.viewport.zoom);
        expectDrawnAt(m, T1, point);
      }),
      message(measureMsg({ ...HEIGHTS, [T1]: 120 })),
      model((m) => {
        expect(Option.isNone(m.mapSurface.motion)).toBe(true);
        expectDrawnAt(m, T1, point);
      }),
    );
    // 前提: 高さを測り直す Message も、子の update では補間を始める
    expectChildStartsMotion(run(start, clickDot(T1)), measureMsg({ ...HEIGHTS, [T1]: 120 }));
  });

  it("全体を見ている間（overview）の開閉も、押したノードの画面座標は押す前と同じ", () => {
    const start = run(initial(), measureMsg(), keyMsg("F"));
    expect(start.mapSurface.viewing.mode).toBe("overview");
    const point = drawnAt(start, T1);
    expectChildStartsMotion(start, clickDot(T1));
    story(
      upd,
      given(start),
      message(clickDot(T1)),
      model((m) => {
        expect(m.mapSurface.viewing.mode).toBe("overview");
        expect(Option.isNone(m.mapSurface.motion)).toBe(true);
        expect(m.mapSurface.viewport.zoom).toBe(start.mapSurface.viewport.zoom);
        expectDrawnAt(m, T1, point);
      }),
    );
  });
});

// 今の議題が無い時刻（議題の外のノードだけがある）の自動のカメラは、全体を収める。高さの測り直しで目標の位置が動いても、描く最終配置に収める
describe("見返しの update: 今の議題が無い自動のカメラ", () => {
  const ctx = makeContext([
    { at: "a", type: "start", title: "定例" },
    remark("r1", 10, "雑談です。"),
    diff(["r1"], [add("x1", "root", "論点", "天気", ["r1"]), add("x2", "root", "論点", "移動", ["r1"])]),
  ]);
  const upd = makeUpdate(ctx);
  const surfaceOf = (m: Model): MapSurface.Model => ({ mode: "review", snapshot: snapshotOf(ctx, m), ...m.mapSurface });
  const got = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
  const start = init(ctx);
  const ids = snapshotAt(ctx.timeline, start.playback.time).nodes.map((n) => n.id);

  it("測り直しで目標の位置が動いても、viewport は motion を捨てた最終配置で収めた位置と一致する", () => {
    const heights = (h: number) => Object.fromEntries(ids.map((id) => [id, id === "root" ? 40 : h]));
    const first = upd(start, got(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: heights(40) }))).model;
    const message = got(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: heights(300) }));
    // 前提: 今の議題が無く、子の update では補間が始まって収め直しが始まりの位置で行われる
    expect(cameraFocus(snapshotOf(ctx, first))).toBeNull();
    expect(first.mapSurface.viewing.mode).toBe("auto");
    const child = MapSurface.update(surfaceOf(first), (message as { message: MapSurfaceMessage }).message).model;
    expect(Option.isSome(child.motion)).toBe(true);
    const next = upd(first, message).model;
    expect(Option.isNone(next.mapSurface.motion)).toBe(true);
    const surface = surfaceOf(next);
    const positions = MapSurface.displayedPositions(surface);
    const rects = surface.snapshot.nodes.map((n) => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights(300)[n.id]! }));
    const expected = fitViewport(rects, { width: 800, height: 600 }, 0.5, USER_MAX_ZOOM)!;
    expect(next.mapSurface.viewport.x).toBeCloseTo(expected.x, 6);
    expect(next.mapSurface.viewport.y).toBeCloseTo(expected.y, 6);
    expect(next.mapSurface.viewport.zoom).toBeCloseTo(expected.zoom, 6);
    // 前提: 補間中の位置で収めた viewport とは別の値になる入力である
    const childFit = MapSurface.update({ ...surfaceOf(first) }, (message as { message: MapSurfaceMessage }).message).model.viewport;
    expect(Math.abs(childFit.x - expected.x) + Math.abs(childFit.y - expected.y) + Math.abs(childFit.zoom - expected.zoom)).toBeGreaterThan(1e-3);
  });
});
