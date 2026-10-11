import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import { PauseAudio, PlayAudio, SeekAudio, WriteAudioSettings } from "../src/app/review/command.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init, Model, makeUpdate } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { AUDIO_RATE, AUDIO_RATES, initialPlayback, PLAYBACK_RATE, PLAYBACK_RATES } from "../src/reviewPlayback.ts";

// 見返しの録音つきの再生（Issue #824）の update。再生・一時停止・終わり・時刻の同期（書く側）と、録音なしの時計。
// 反映 1: 時刻 10、反映 2: 時刻 30。会議の長さは 30

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

const audioContext = makeContext(events, { maybeAudioUrl: Option.some("blob:review-audio") });
const plainContext = makeContext(events);
const audioUpdate = makeUpdate(audioContext);
const plainUpdate = makeUpdate(plainContext);

const stateAt = (context: typeof audioContext, time: number, playing: boolean): Model => {
  const start = init(context);
  return { ...start, playback: { ...start.playback, time, playing } };
};
const summary = (commands: ReadonlyArray<{ name: string; args?: unknown }> | undefined) => (commands ?? []).map((c) => ({ name: c.name, args: c.args }));
const SETTINGS = { name: "WriteAudioSettings", args: { rate: AUDIO_RATE, muted: false, volume: 1 } };

describe("録音つきの初期状態と Context", () => {
  it("録音つきは速さ 1 で止まって始まり、速さの並びは AUDIO_RATES", () => {
    const m = init(audioContext);
    expect(m.playback).toEqual(initialPlayback(30, AUDIO_RATE));
    expect(m.playback.rate).toBe(1);
    expect(audioContext.playback.rates).toEqual(AUDIO_RATES);
  });

  it("録音なしは今までどおり（速さ 30、PLAYBACK_RATES）", () => {
    expect(init(plainContext).playback).toEqual(initialPlayback(30));
    expect(init(plainContext).playback.rate).toBe(PLAYBACK_RATE);
    expect(plainContext.playback.rates).toEqual(PLAYBACK_RATES);
  });
});

describe("再生", () => {
  it("途中の時刻（10）で止まっているとき、再生すると設定を書いてから鳴らす。時刻は変えず、シークはしない", () => {
    const result = audioUpdate(stateAt(audioContext, 10, false), Message.ClickedToggle());
    expect(result.model.playback.playing).toBe(true);
    expect(result.model.playback.time).toBe(10);
    expect(summary(result.commands)).toEqual([SETTINGS, { name: "PlayAudio", args: undefined }]);
  });

  it("会議の終わり（30）から再生すると、0 へ戻して設定を書き、鳴らす（この順）", () => {
    const result = audioUpdate(stateAt(audioContext, 30, false), Message.ClickedToggle());
    expect(result.model.playback.playing).toBe(true);
    expect(result.model.playback.time).toBe(0);
    expect(summary(result.commands)).toEqual([{ name: "SeekAudio", args: { time: 0 } }, SETTINGS, { name: "PlayAudio", args: undefined }]);
  });

  it("続いた Model の上で、再生 → 結果の Message を解く、と進んでも再生中のまま", () => {
    story(
      audioUpdate,
      given(stateAt(audioContext, 10, false)),
      message(Message.ClickedToggle()),
      Command.resolveAll([WriteAudioSettings, Message.CompletedWriteAudioSettings()], [PlayAudio, Message.SucceededPlayAudio()]),
      model((m) => {
        expect(m.playback.playing).toBe(true);
        expect(m.playback.time).toBe(10);
      }),
    );
  });

  it("終わりからの再生も、Seek の結果を解いたあと 0 から再生中", () => {
    story(
      audioUpdate,
      given(stateAt(audioContext, 30, false)),
      message(Message.ClickedToggle()),
      Command.resolveAll(
        [SeekAudio, Message.CompletedSeekAudio()],
        [WriteAudioSettings, Message.CompletedWriteAudioSettings()],
        [PlayAudio, Message.SucceededPlayAudio()],
      ),
      model((m) => {
        expect(m.playback).toMatchObject({ time: 0, playing: true });
      }),
    );
  });
});

describe("一時停止", () => {
  it("再生中に切り替えると止まり、PauseAudio が出る。時刻は変わらない", () => {
    const result = audioUpdate(stateAt(audioContext, 10, true), Message.ClickedToggle());
    expect(result.model.playback).toMatchObject({ time: 10, playing: false });
    expect(summary(result.commands)).toEqual([{ name: "PauseAudio", args: undefined }]);
  });

  it("再生 → 一時停止と続けて進める", () => {
    story(
      audioUpdate,
      given(stateAt(audioContext, 10, false)),
      message(Message.ClickedToggle()),
      Command.resolveAll([WriteAudioSettings, Message.CompletedWriteAudioSettings()], [PlayAudio, Message.SucceededPlayAudio()]),
      model((m) => expect(m.playback.playing).toBe(true)),
      message(Message.ClickedToggle()),
      Command.resolve(PauseAudio, Message.CompletedPauseAudio()),
      model((m) => expect(m.playback).toMatchObject({ time: 10, playing: false })),
    );
  });
});

describe("play() の失敗", () => {
  it("AbortError 以外の失敗では、再生中だった状態を止めに戻す。Command は出ない", () => {
    const result = audioUpdate(stateAt(audioContext, 10, true), Message.FailedPlayAudio({ isAborted: false }));
    expect(result.model.playback).toMatchObject({ time: 10, playing: false });
    expect(summary(result.commands)).toEqual([]);
  });

  it("AbortError の失敗は無視する（再生中のまま）", () => {
    const start = stateAt(audioContext, 10, true);
    const result = audioUpdate(start, Message.FailedPlayAudio({ isAborted: true }));
    expect(result.model).toEqual(start);
    expect(summary(result.commands)).toEqual([]);
  });

  it("止めたあとに遅れて届いた失敗では、再生は始まらない", () => {
    const start = stateAt(audioContext, 10, false);
    for (const isAborted of [false, true]) {
      const result = audioUpdate(start, Message.FailedPlayAudio({ isAborted }));
      expect(result.model.playback).toEqual(start.playback);
    }
  });

  it("再生 → 失敗の続きで止まり、再び再生できる", () => {
    story(
      audioUpdate,
      given(stateAt(audioContext, 10, false)),
      message(Message.ClickedToggle()),
      Command.resolveAll([WriteAudioSettings, Message.CompletedWriteAudioSettings()], [PlayAudio, Message.FailedPlayAudio({ isAborted: false })]),
      model((m) => expect(m.playback).toMatchObject({ time: 10, playing: false })),
      message(Message.ClickedToggle()),
      Command.resolveAll([WriteAudioSettings, Message.CompletedWriteAudioSettings()], [PlayAudio, Message.SucceededPlayAudio()]),
      model((m) => expect(m.playback.playing).toBe(true)),
    );
  });
});

describe("終わり", () => {
  it("再生中に EndedAudio が届くと、時刻は会議の長さ（30）で止まる。Command は出ない", () => {
    const result = audioUpdate(stateAt(audioContext, 12, true), Message.EndedAudio());
    expect(result.model.playback).toMatchObject({ time: 30, playing: false });
    expect(summary(result.commands)).toEqual([]);
  });

  it("録音が会議より長いとき、会議の長さを超えた時刻の通知では、30 で止めて PauseAudio を出す", () => {
    const result = audioUpdate(stateAt(audioContext, 20, true), Message.UpdatedAudioTime({ time: 35 }));
    expect(result.model.playback).toMatchObject({ time: 30, playing: false });
    expect(summary(result.commands)).toEqual([{ name: "PauseAudio", args: undefined }]);
  });

  it("ちょうど会議の長さ（30）の通知も止める", () => {
    const result = audioUpdate(stateAt(audioContext, 20, true), Message.UpdatedAudioTime({ time: 30 }));
    expect(result.model.playback).toMatchObject({ time: 30, playing: false });
    expect(summary(result.commands)).toEqual([{ name: "PauseAudio", args: undefined }]);
  });

  it("終わりで止まったあと、もう一度再生すると 0 から鳴る", () => {
    story(
      audioUpdate,
      given(stateAt(audioContext, 12, true)),
      message(Message.EndedAudio()),
      model((m) => expect(m.playback).toMatchObject({ time: 30, playing: false })),
      message(Message.ClickedToggle()),
      Command.resolveAll(
        [SeekAudio, Message.CompletedSeekAudio()],
        [WriteAudioSettings, Message.CompletedWriteAudioSettings()],
        [PlayAudio, Message.SucceededPlayAudio()],
      ),
      model((m) => expect(m.playback).toMatchObject({ time: 0, playing: true })),
    );
  });
});

describe("時刻の同期（<audio> から受ける側）", () => {
  it("再生中の時刻の通知は、そのまま時刻になる。Command は出ない", () => {
    const result = audioUpdate(stateAt(audioContext, 5, true), Message.UpdatedAudioTime({ time: 10 }));
    expect(result.model.playback).toMatchObject({ time: 10, playing: true });
    expect(summary(result.commands)).toEqual([]);
  });

  it("止まっている間の通知は無視する（シーク先や止めた時刻から戻らない）", () => {
    const start = stateAt(audioContext, 10, false);
    const result = audioUpdate(start, Message.UpdatedAudioTime({ time: 3 }));
    expect(result.model.playback).toEqual(start.playback);
    expect(summary(result.commands)).toEqual([]);
  });
});

describe("時刻の同期（人が動かして <audio> へ書く側）", () => {
  it("録音つきで止まっている間の前へ・次へは、動いた先を currentTime に書く", () => {
    const prev = audioUpdate(stateAt(audioContext, 30, false), Message.ClickedPrev());
    expect(prev.model.playback.time).toBe(10);
    expect(summary(prev.commands)).toEqual([{ name: "SeekAudio", args: { time: 10 } }]);
    const next = audioUpdate(stateAt(audioContext, 10, false), Message.ClickedNext());
    expect(next.model.playback.time).toBe(30);
    expect(summary(next.commands)).toEqual([{ name: "SeekAudio", args: { time: 30 } }]);
  });

  it("再生中の前へも書く（書かないと次の通知で元の時刻へ戻る）", () => {
    const result = audioUpdate(stateAt(audioContext, 30, true), Message.ClickedPrev());
    expect(result.model.playback).toMatchObject({ time: 10, playing: true });
    expect(summary(result.commands)).toEqual([{ name: "SeekAudio", args: { time: 10 } }]);
  });

  it("時刻が動かないときは書かない（手前・先に反映が無い）", () => {
    const prev = audioUpdate(stateAt(audioContext, 10, false), Message.ClickedPrev());
    expect(prev.model.playback.time).toBe(10);
    expect(summary(prev.commands)).toEqual([]);
    const next = audioUpdate(stateAt(audioContext, 30, false), Message.ClickedNext());
    expect(next.model.playback.time).toBe(30);
    expect(summary(next.commands)).toEqual([]);
  });

  it("Seek の結果の Message は Model を変えない", () => {
    story(
      audioUpdate,
      given(stateAt(audioContext, 30, false)),
      message(Message.ClickedPrev()),
      Command.resolve(SeekAudio, Message.CompletedSeekAudio()),
      model((m) => expect(m.playback).toMatchObject({ time: 10, playing: false })),
    );
  });
});

describe("録音なしの時計（今と同じ）", () => {
  it("切り替えは再生の状態だけを変え、<audio> への Command を出さない", () => {
    const start = stateAt(plainContext, 10, false);
    const on = plainUpdate(start, Message.ClickedToggle());
    expect(on.model.playback).toMatchObject({ time: 10, playing: true });
    expect(summary(on.commands)).toEqual([]);
    const off = plainUpdate(on.model, Message.ClickedToggle());
    expect(off.model.playback.playing).toBe(false);
    expect(summary(off.commands)).toEqual([]);
  });

  it("終わりからの再生は 0 から始まる。Command は出ない", () => {
    const result = plainUpdate(stateAt(plainContext, 30, false), Message.ClickedToggle());
    expect(result.model.playback).toMatchObject({ time: 0, playing: true });
    expect(summary(result.commands)).toEqual([]);
  });

  it("フレームの ms を経過秒にして進める（200ms × 速さ 30 = 6 秒）", () => {
    const result = plainUpdate(stateAt(plainContext, 0, true), Message.TickedFrame({ ms: 200 }));
    expect(result.model.playback.time).toBeCloseTo(6, 10);
    expect(summary(result.commands)).toEqual([]);
  });

  it("会議の長さに達したら 30 で止まる", () => {
    const result = plainUpdate(stateAt(plainContext, 29, true), Message.TickedFrame({ ms: 1000 }));
    expect(result.model.playback).toMatchObject({ time: 30, playing: false });
  });

  it("止まっている間のフレームは時刻を変えない", () => {
    const start = stateAt(plainContext, 12, false);
    expect(plainUpdate(start, Message.TickedFrame({ ms: 500 })).model.playback).toEqual(start.playback);
  });

  it("再生 → フレーム → 終わりまで、続いた Model で進む", () => {
    story(
      plainUpdate,
      given(stateAt(plainContext, 0, false)),
      message(Message.ClickedToggle()),
      message(Message.TickedFrame({ ms: 500 })),
      model((m) => expect(m.playback.time).toBeCloseTo(15, 10)),
      message(Message.TickedFrame({ ms: 500 })),
      model((m) => expect(m.playback).toMatchObject({ time: 30, playing: false })),
    );
  });
});
