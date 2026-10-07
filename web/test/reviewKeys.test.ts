import { describe, expect, it } from "vitest";
import { AUDIO_HOTKEYS, REVIEW_HOTKEYS, reviewKeyEvent, SKIP_SECONDS, type ReviewKeyAction } from "../src/reviewKeys.ts";
import { initialPlayback, playbackReducer, type PlaybackEvent } from "../src/reviewPlayback.ts";

// 見返しのキーから再生の出来事への対応（DOM なし）。
const none = { meta: false, ctrl: false, alt: false };
const ctx = { duration: 100, reflectionTimes: [10, 40, 70], rates: [10, 30, 60, 120] };
const ev = (action: ReviewKeyAction, time = 50, duration = 100) => reviewKeyEvent(action, none, time, duration);

describe("見返しのキーの一覧（REVIEW_HOTKEYS）", () => {
  it("Space・K・J・L・, . < > Home End の 10 個で、C は含めない（C は SessionView の登録を使う）", () => {
    expect(REVIEW_HOTKEYS.map(([hotkey]) => hotkey)).toEqual(["Space", "K", "J", "L", ",", ".", "<", ">", "Home", "End"]);
    expect(REVIEW_HOTKEYS.map(([hotkey]) => hotkey.toUpperCase())).not.toContain("C");
  });

  it("キーごとの動き: Space・K は toggle、J は back、L は forward、, は prev、. は next、< は slower、> は faster、Home は start、End は end", () => {
    expect(Object.fromEntries(REVIEW_HOTKEYS)).toEqual({
      Space: "toggle",
      K: "toggle",
      J: "back",
      L: "forward",
      ",": "prev",
      ".": "next",
      "<": "slower",
      ">": "faster",
      Home: "start",
      End: "end",
    });
  });

  it("飛ばす秒数は 10 秒", () => {
    expect(SKIP_SECONDS).toBe(10);
  });
});

describe("reviewKeyEvent: 時刻を動かす操作（movesTime: true、operate を通す）", () => {
  it("toggle・prev・next は同名の出来事", () => {
    expect(ev("toggle")).toEqual({ event: { type: "toggle" }, movesTime: true });
    expect(ev("prev")).toEqual({ event: { type: "prev" }, movesTime: true });
    expect(ev("next")).toEqual({ event: { type: "next" }, movesTime: true });
  });

  it("J は今の時刻の 10 秒前、L は 10 秒後への seek", () => {
    expect(ev("back", 50)).toEqual({ event: { type: "seek", time: 40 }, movesTime: true });
    expect(ev("forward", 50)).toEqual({ event: { type: "seek", time: 60 }, movesTime: true });
  });

  it("Home は 0 秒、End は会議の長さへの seek（今の時刻に依らない）", () => {
    expect(ev("start", 33, 100)).toEqual({ event: { type: "seek", time: 0 }, movesTime: true });
    expect(ev("end", 33, 100)).toEqual({ event: { type: "seek", time: 100 }, movesTime: true });
    expect(ev("end", 33, 250)).toEqual({ event: { type: "seek", time: 250 }, movesTime: true });
  });
});

describe("reviewKeyEvent: 速さは時刻を動かす操作に含めない（operate を通さない）", () => {
  it("< は slower、> は faster で、movesTime は false", () => {
    expect(ev("slower")).toEqual({ event: { type: "slower" }, movesTime: false });
    expect(ev("faster")).toEqual({ event: { type: "faster" }, movesTime: false });
  });

  it("movesTime が false なのは slower・faster だけ", () => {
    const actions = REVIEW_HOTKEYS.map(([, action]) => action);
    const notMoving = actions.filter((a) => ev(a)?.movesTime === false);
    expect(new Set(notMoving)).toEqual(new Set(["slower", "faster"]));
  });
});

describe("reviewKeyEvent: ⌘・Ctrl・Option と一緒のキーは受けない", () => {
  const actions = [...new Set(REVIEW_HOTKEYS.map(([, action]) => action))];

  it.each([
    ["⌘", { meta: true, ctrl: false, alt: false }],
    ["Ctrl", { meta: false, ctrl: true, alt: false }],
    ["Option", { meta: false, ctrl: false, alt: true }],
  ])("%s を押しながらでは、どのキーも null", (_name, mods) => {
    for (const action of actions) expect(reviewKeyEvent(action, mods, 50, 100)).toBeNull();
  });

  it("修飾キーなしなら、どの動きも null にならない", () => {
    for (const action of actions) expect(ev(action)).not.toBeNull();
  });
});

describe("reviewKeyEvent の出来事を playbackReducer に通した結果", () => {
  const run = (time: number, action: ReviewKeyAction) => {
    const out = ev(action, time, ctx.duration);
    return playbackReducer({ ...initialPlayback(ctx.duration), time }, out!.event as PlaybackEvent, ctx);
  };

  it("J: 5 秒のとき 0 秒より前にはならない。L: 長さ−5 秒のとき会議の長さを超えない", () => {
    expect(run(5, "back").time).toBe(0);
    expect(run(95, "forward").time).toBe(100);
  });

  it("J・L: 範囲の内側ではちょうど 10 秒動く", () => {
    expect(run(50, "back").time).toBe(40);
    expect(run(50, "forward").time).toBe(60);
  });

  it("Home は 0 秒、End は会議の長さの時点になる", () => {
    expect(run(37, "start").time).toBe(0);
    expect(run(37, "end").time).toBe(100);
  });

  it(", は 1 つ前の反映、. は 1 つ後の反映の時刻へ移る", () => {
    expect(run(50, "prev").time).toBe(40);
    expect(run(50, "next").time).toBe(70);
  });

  it("< は速さを 1 段下げ、> は 1 段上げる（時刻は変わらない）", () => {
    const base = { ...initialPlayback(ctx.duration), time: 20 };
    const slower = playbackReducer(base, ev("slower")!.event, ctx);
    const faster = playbackReducer(base, ev("faster")!.event, ctx);
    expect(slower).toMatchObject({ time: 20, rate: 10 });
    expect(faster).toMatchObject({ time: 20, rate: 60 });
  });
});

describe("M（ミュート）: 音声つきの見返しだけの登録", () => {
  it("AUDIO_HOTKEYS は M → mute の 1 つだけ", () => {
    expect(AUDIO_HOTKEYS).toEqual([["M", "mute"]]);
  });

  it("REVIEW_HOTKEYS（音声なしでも登録される）には M を混ぜない", () => {
    expect(REVIEW_HOTKEYS.map(([hotkey]) => hotkey.toUpperCase())).not.toContain("M");
    expect(REVIEW_HOTKEYS.map(([, action]) => action as string)).not.toContain("mute");
  });

  it("mute は toggleMute の出来事で、時刻を動かす操作ではない（operate を通さない）", () => {
    expect(ev("mute")).toEqual({ event: { type: "toggleMute" }, movesTime: false });
  });

  it.each([
    ["⌘", { meta: true, ctrl: false, alt: false }],
    ["Ctrl", { meta: false, ctrl: true, alt: false }],
    ["Option", { meta: false, ctrl: false, alt: true }],
  ])("%s を押しながらの M は受けない（修飾キーなしなら受ける）", (_name, mods) => {
    expect(reviewKeyEvent("mute", none, 50, 100)).not.toBeNull();
    expect(reviewKeyEvent("mute", mods, 50, 100)).toBeNull();
  });

  it("出来事を playbackReducer に通すと、ミュートが切り替わり、時刻・進行・速さは変わらない。もう一度で戻る", () => {
    const base = { ...initialPlayback(ctx.duration), time: 20, playing: true };
    const muted = playbackReducer(base, ev("mute")!.event, ctx);
    expect(muted).toMatchObject({ muted: true, volume: 1, time: 20, playing: true, rate: base.rate });
    expect(playbackReducer(muted, ev("mute")!.event, ctx)).toEqual(base);
  });
});
