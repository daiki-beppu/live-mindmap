import { HashMap, Option, Schema } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init, Model, makeUpdate, snapshotOf } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { initialPlayback, PLAYBACK_RATES } from "../src/reviewPlayback.ts";
import { snapshotAt } from "../src/reviewTimeline.ts";

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
