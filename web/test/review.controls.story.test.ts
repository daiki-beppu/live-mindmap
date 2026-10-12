import * as Menu from "@foldkit/ui/menu";
import * as Slider from "@foldkit/ui/slider";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { init, Model, makeUpdate, snapshotOf } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { makeSubscriptions } from "../src/app/review/subscription.ts";
import { AUDIO_RATES, PLAYBACK_RATES } from "../src/reviewPlayback.ts";
import { argsOf, audioContext, commandNames, DURATION, ownCommandNames, plainContext, stateAt } from "./reviewHarness.ts";

// 見返しの操作の行（Issue #825）の update（Story）。シーク・音量・速さを、Slider と Menu の OutMessage だけで受けることと、
// 押して離したらフォーカスを外すこと、字幕・右の列のボタンの状態を見る。
// 会議の長さは 200 秒、録音つきの速さの並びは AUDIO_RATES（0.5〜2）、録音なしは PLAYBACK_RATES（10〜120）

const audioUpdate = makeUpdate(audioContext);
const plainUpdate = makeUpdate(plainContext);

// 子（Slider・Menu）への Message。包む Message は見返しのもの、中身は @foldkit/ui の Message
const seek = (message: Slider.Message) => Message.GotSeekSliderMessage({ message });
const volume = (message: Slider.Message) => Message.GotVolumeSliderMessage({ message });
const rateMenu = (message: Menu.Message) => Message.GotRateMenuMessage({ message });
const key = (direction: "StepDecrement" | "StepIncrement" | "PageDecrement" | "PageIncrement" | "Min" | "Max", value: number) => Slider.Message.PressedKeyboardNavigation({ direction, value });
const selectRate = (rates: readonly number[], index: number) => rateMenu(Menu.Message.SelectedItem({ index, item: String(rates[index]) }));

// 続いた Model の上で Message を順に流し、各段の結果を返す
const run = (update: ReturnType<typeof makeUpdate>, start: ReturnType<typeof stateAt>, ...messages: Message[]) => {
  let model = start;
  return messages.map((message) => {
    const result = update(model, message);
    model = result.model;
    return result;
  });
};

describe("見返しの Model: 操作の行の状態", () => {
  it("最初は字幕も右の列も出していて（右の列の出し入れは表示面の見る状態が持つ）、スライダーを押していない", () => {
    const m = init(audioContext);
    expect(m.captionsHidden).toBe(false);
    expect(m.mapSurface.viewing.sideHidden).not.toBe(true);
    expect(m.isPressingSlider).toBe(false);
    expect(Option.isNone(m.maybeSeekPointer)).toBe(true);
    expect(Schema.is(Model)(m)).toBe(true);
  });

  it("どの Message のあとも、Model は本物の Schema を通る", () => {
    const messages: Message[] = [
      seek(key("Min", 200)),
      seek(Slider.Message.PressedThumb({ originValue: 0 })),
      seek(Slider.Message.MovedDragPointer({ value: 40 })),
      seek(Slider.Message.ReleasedDragPointer()),
      volume(key("StepDecrement", 1)),
      Message.ClickedMute(),
      selectRate(AUDIO_RATES, 3),
      Message.ToggledCaptions({ isOpen: false }),
      Message.ClickedSide(),
      Message.MovedSeekPointer({ fraction: 0.5 }),
      Message.LeftSeekPointer(),
      Message.PressedSliderPointer(),
      Message.ReleasedSliderPointer(),
      Message.CancelledSliderPointer(),
      Message.CompletedReleaseFocus(),
      Message.CompletedReleaseFocusAfterMenuClose(),
    ];
    for (const result of run(audioUpdate, stateAt(audioContext, 200), ...messages)) expect(Schema.is(Model)(result.model)).toBe(true);
  });
});

describe("シーク: Slider の ChangedValue だけで時刻が動く", () => {
  it("Home（Min）で 0 へ動く。録音なしは Command を返さない", () => {
    const result = plainUpdate(stateAt(plainContext, 100), seek(key("Min", 100)));
    expect(result.model.playback.time).toBe(0);
    expect(commandNames(result.commands)).toEqual([]);
  });

  it("End（Max）で会議の長さ（200）へ動く", () => {
    const result = plainUpdate(stateAt(plainContext, 0), seek(key("Max", 0)));
    expect(result.model.playback.time).toBe(DURATION);
  });

  it("矢印（StepIncrement）で進み、会議の長さを超えない", () => {
    const result = plainUpdate(stateAt(plainContext, 100), seek(key("StepIncrement", 100)));
    expect(result.model.playback.time).toBeGreaterThan(100);
    expect(result.model.playback.time).toBeLessThanOrEqual(DURATION);
    const atEnd = plainUpdate(stateAt(plainContext, DURATION), seek(key("StepIncrement", DURATION)));
    expect(atEnd.model.playback.time).toBe(DURATION);
  });

  it("矢印（StepDecrement）で戻り、0 を下回らない", () => {
    const result = plainUpdate(stateAt(plainContext, 100), seek(key("StepDecrement", 100)));
    expect(result.model.playback.time).toBeLessThan(100);
    expect(result.model.playback.time).toBeGreaterThanOrEqual(0);
    expect(plainUpdate(stateAt(plainContext, 0), seek(key("StepDecrement", 0))).model.playback.time).toBe(0);
  });

  it("録音つきは、動いた先を <audio> の currentTime に書く（SeekAudio だけ。書かないと次の通知で元の時刻へ戻る）", () => {
    const home = audioUpdate(stateAt(audioContext, 100), seek(key("Min", 100)));
    expect(home.model.playback.time).toBe(0);
    expect(commandNames(home.commands)).toEqual(["SeekAudio"]);
    expect(argsOf(home.commands, "SeekAudio")).toEqual([{ time: 0 }]);
    const end = audioUpdate(stateAt(audioContext, 100), seek(key("Max", 100)));
    expect(argsOf(end.commands, "SeekAudio")).toEqual([{ time: DURATION }]);
  });

  it("再生中のシークでも、再生・速さ・ミュート・音量は変わらない", () => {
    const start = stateAt(audioContext, 100, { playing: true, rate: 1.5, muted: true, volume: 0.4 });
    const result = audioUpdate(start, seek(key("Min", 100)));
    expect(result.model.playback).toEqual({ time: 0, playing: true, rate: 1.5, muted: true, volume: 0.4 });
  });

  it("動かない値（すでに End にいて End）は ChangedValue が出ないので、Model も Command も変わらない", () => {
    const start = stateAt(audioContext, DURATION);
    const result = audioUpdate(start, seek(key("Max", DURATION)));
    expect(result.model.playback).toEqual(start.playback);
    expect(commandNames(result.commands)).toEqual([]);
  });

  it("トラックの押下（PressedPointer）で、その位置の時刻へ飛ぶ。録音つきは SeekAudio", () => {
    const [pressed] = run(audioUpdate, stateAt(audioContext, 100), seek(Slider.Message.PressedPointer({ value: 42, originValue: 100 })));
    expect(pressed!.model.playback.time).toBe(42);
    expect(argsOf(pressed!.commands, "SeekAudio")).toEqual([{ time: 42 }]);
  });

  it("つまみを押して引くと、引いた位置へ時刻が動く。離しても時刻はそのまま（離したことでは何も出ない）", () => {
    const [pressed, moved, movedAgain, released] = run(
      audioUpdate,
      stateAt(audioContext, 100),
      seek(Slider.Message.PressedThumb({ originValue: 100 })),
      seek(Slider.Message.MovedDragPointer({ value: 50 })),
      seek(Slider.Message.MovedDragPointer({ value: 120 })),
      seek(Slider.Message.ReleasedDragPointer()),
    );
    expect(pressed!.model.playback.time).toBe(100);
    expect(commandNames(pressed!.commands)).toEqual([]);
    expect(moved!.model.playback.time).toBe(50);
    expect(argsOf(moved!.commands, "SeekAudio")).toEqual([{ time: 50 }]);
    expect(movedAgain!.model.playback.time).toBe(120);
    expect(argsOf(movedAgain!.commands, "SeekAudio")).toEqual([{ time: 120 }]);
    expect(released!.model.playback.time).toBe(120);
    expect(commandNames(released!.commands)).toEqual([]);
  });

  it("引いている途中の Esc（CancelledDrag）で、引く前の時刻へ戻る。録音つきは戻した先を書く", () => {
    const results = run(
      audioUpdate,
      stateAt(audioContext, 100),
      seek(Slider.Message.PressedThumb({ originValue: 100 })),
      seek(Slider.Message.MovedDragPointer({ value: 30 })),
      seek(Slider.Message.CancelledDrag()),
    );
    expect(results[1]!.model.playback.time).toBe(30);
    expect(results[2]!.model.playback.time).toBe(100);
    expect(argsOf(results[2]!.commands, "SeekAudio")).toEqual([{ time: 100 }]);
  });

  it("引いていないときの MovedDragPointer は時刻を動かさない（ポインタが離れたあとに遅れて届いても戻らない）", () => {
    const start = stateAt(audioContext, 100);
    const result = audioUpdate(start, seek(Slider.Message.MovedDragPointer({ value: 10 })));
    expect(result.model.playback.time).toBe(100);
    expect(commandNames(result.commands)).toEqual([]);
  });

  it("時刻が動くと、その時刻のマップ（Snapshot）が追従する", () => {
    const topics = (m: ReturnType<typeof stateAt>, context: typeof audioContext) => snapshotOf(context, m).nodes.filter((n) => n.kind === "議題").map((n) => n.text);
    const [toStart, toEnd] = run(plainUpdate, stateAt(plainContext, 100), seek(key("Min", 100)), seek(key("Max", 0)));
    expect(topics(toStart!.model, plainContext)).toEqual([]);
    expect(topics(toEnd!.model, plainContext)).toEqual(["A", "B"]);
  });
});

describe("音量: Slider の ChangedValue とミュートのボタン", () => {
  it("矢印（StepDecrement）で 0.05 刻みに下がり、<audio> に設定を書く（音量の変化だけ）", () => {
    const result = audioUpdate(stateAt(audioContext, 100), volume(key("StepDecrement", 1)));
    expect(result.model.playback.volume).toBe(0.95);
    expect(result.model.playback.muted).toBe(false);
    expect(commandNames(result.commands)).toEqual(["WriteAudioSettings"]);
    expect(argsOf(result.commands, "WriteAudioSettings")).toEqual([{ rate: 1, muted: false, volume: 0.95 }]);
  });

  it("Home（Min）で 0、End（Max）で 1 になる", () => {
    expect(audioUpdate(stateAt(audioContext, 100, { volume: 0.4 }), volume(key("Min", 0.4))).model.playback.volume).toBe(0);
    expect(audioUpdate(stateAt(audioContext, 100, { volume: 0.4 }), volume(key("Max", 0.4))).model.playback.volume).toBe(1);
  });

  it("ミュート中は見える値が 0 なので、矢印で上げるとミュートが外れ、0.05 になる", () => {
    const start = stateAt(audioContext, 100, { muted: true, volume: 0.4 });
    const result = audioUpdate(start, volume(key("StepIncrement", 0)));
    expect(result.model.playback).toMatchObject({ muted: false, volume: 0.05 });
    expect(argsOf(result.commands, "WriteAudioSettings")).toEqual([{ rate: 1, muted: false, volume: 0.05 }]);
  });

  it("つまみを引くと音量が追従し、そのたびに <audio> へ書く", () => {
    const [pressed, moved] = run(audioUpdate, stateAt(audioContext, 100), volume(Slider.Message.PressedThumb({ originValue: 1 })), volume(Slider.Message.MovedDragPointer({ value: 0.5 })));
    expect(commandNames(pressed!.commands)).toEqual([]);
    expect(moved!.model.playback.volume).toBe(0.5);
    expect(argsOf(moved!.commands, "WriteAudioSettings")).toEqual([{ rate: 1, muted: false, volume: 0.5 }]);
  });

  it("音量を動かしても、時刻・再生・速さは変わらない", () => {
    const start = stateAt(audioContext, 100, { playing: true, rate: 1.5 });
    const result = audioUpdate(start, volume(key("Min", 1)));
    expect(result.model.playback).toEqual({ ...start.playback, volume: 0 });
  });

  it("ミュートのボタンで、ミュートを入れる／外す。外すと、ミュート前の音量に戻る", () => {
    const [muted, unmuted] = run(audioUpdate, stateAt(audioContext, 100, { volume: 0.4 }), Message.ClickedMute(), Message.ClickedMute());
    expect(muted!.model.playback).toMatchObject({ muted: true, volume: 0.4 });
    expect(argsOf(muted!.commands, "WriteAudioSettings")).toEqual([{ rate: 1, muted: true, volume: 0.4 }]);
    expect(unmuted!.model.playback).toMatchObject({ muted: false, volume: 0.4 });
    expect(argsOf(unmuted!.commands, "WriteAudioSettings")).toEqual([{ rate: 1, muted: false, volume: 0.4 }]);
  });

  it("ミュートのボタンを押すと、フォーカスも外す（ReleaseFocus）", () => {
    const result = audioUpdate(stateAt(audioContext, 100), Message.ClickedMute());
    expect(commandNames(result.commands)).toEqual(["ReleaseFocus", "WriteAudioSettings"]);
  });
});

describe("速さ: Menu の Selected だけで速さが変わる", () => {
  it("録音つきは、選んだ項目の位置の速さ（AUDIO_RATES[4] = 1.5）になり、<audio> に書き、フォーカスを外す", () => {
    const result = audioUpdate(stateAt(audioContext, 100), selectRate(AUDIO_RATES, 4));
    expect(result.model.playback.rate).toBe(1.5);
    expect(ownCommandNames(result.commands)).toEqual(["ReleaseFocusAfterMenuClose", "WriteAudioSettings"]);
    expect(argsOf(result.commands, "WriteAudioSettings")).toEqual([{ rate: 1.5, muted: false, volume: 1 }]);
  });

  it("録音なしは、PLAYBACK_RATES[2] = 60 になる。<audio> には書かず、フォーカスは外す", () => {
    const result = plainUpdate(stateAt(plainContext, 100), selectRate(PLAYBACK_RATES, 2));
    expect(result.model.playback.rate).toBe(60);
    expect(ownCommandNames(result.commands)).toEqual(["ReleaseFocusAfterMenuClose"]);
  });

  it("速さを替えても、時刻・再生・ミュート・音量は変わらない", () => {
    const start = stateAt(audioContext, 100, { playing: true, muted: true, volume: 0.4 });
    const result = audioUpdate(start, selectRate(AUDIO_RATES, 0));
    expect(result.model.playback).toEqual({ ...start.playback, rate: 0.5 });
  });

  it("選ぶ前に Menu を開いただけでは、速さは変わらない", () => {
    const start = stateAt(audioContext, 100);
    const result = audioUpdate(start, rateMenu(Menu.Message.Opened({ maybeActiveItemIndex: Option.none() })));
    expect(result.model.playback).toEqual(start.playback);
    expect(ownCommandNames(result.commands)).toEqual([]);
  });
});

// 子の Slider のドラッグ用の購読（lift した入れ物）が、今の Model で文書のイベントを開くか
const dragActivity = (subscription: ReturnType<typeof makeSubscriptions>["seekDragPointer"], model: ReturnType<typeof stateAt>) =>
  Option.getOrThrow(subscription.modelToDependencies(model).maybeDependencies).dragActivity;

describe("押して離したらフォーカスを外す", () => {
  it("スライダーを押して（PressedSliderPointer）離す（ReleasedSliderPointer）と ReleaseFocus を返す。離したあとの 2 回目は返さない", () => {
    const [pressed, released, again] = run(audioUpdate, stateAt(audioContext, 100), Message.PressedSliderPointer(), Message.ReleasedSliderPointer(), Message.ReleasedSliderPointer());
    expect(commandNames(pressed!.commands)).toEqual([]);
    expect(commandNames(released!.commands)).toEqual(["ReleaseFocus"]);
    expect(commandNames(again!.commands)).toEqual([]);
  });

  it("押していないところで離しても（ほかの場所のクリックの pointerup）、フォーカスは外さない", () => {
    const result = audioUpdate(stateAt(audioContext, 100), Message.ReleasedSliderPointer());
    expect(commandNames(result.commands)).toEqual([]);
  });

  it("離したことは Slider の中の Message（ReleasedDragPointer）では知らない: 引いて離しても、それだけでは ReleaseFocus は出ない", () => {
    const results = run(
      audioUpdate,
      stateAt(audioContext, 100),
      seek(Slider.Message.PressedThumb({ originValue: 100 })),
      seek(Slider.Message.MovedDragPointer({ value: 60 })),
      seek(Slider.Message.ReleasedDragPointer()),
    );
    for (const result of results) expect(commandNames(result.commands)).not.toContain("ReleaseFocus");
  });

  it("引いている途中の pointercancel（CancelledSliderPointer）で、シーク・音量とも引くのをやめ、ドラッグ用の文書の購読が Idle に戻る。フォーカスを外し、時刻と音量は中断時点のまま", () => {
    const subscriptions = makeSubscriptions(audioContext);
    const start = stateAt(audioContext, 100);
    const [pressedSeek, pressedVolume, pressedSlider, moved, cancelled] = run(
      audioUpdate,
      start,
      seek(Slider.Message.PressedThumb({ originValue: 100 })),
      volume(Slider.Message.PressedThumb({ originValue: 1 })),
      Message.PressedSliderPointer(),
      seek(Slider.Message.MovedDragPointer({ value: 60 })),
      Message.CancelledSliderPointer(),
    );
    expect(commandNames(pressedSeek!.commands)).toEqual([]);
    expect(commandNames(pressedVolume!.commands)).toEqual([]);
    expect(dragActivity(subscriptions.seekDragPointer, pressedSlider!.model)).toBe("Active");
    expect(dragActivity(subscriptions.volumeDragPointer, pressedSlider!.model)).toBe("Active");
    expect(commandNames(cancelled!.commands)).toEqual(["ReleaseFocus"]);
    expect(dragActivity(subscriptions.seekDragPointer, cancelled!.model)).toBe("Idle");
    expect(dragActivity(subscriptions.volumeDragPointer, cancelled!.model)).toBe("Idle");
    expect(cancelled!.model.isPressingSlider).toBe(false);
    expect(cancelled!.model.playback.time).toBe(moved!.model.playback.time);
    expect(cancelled!.model.playback.volume).toBe(1);
    // 中断のあとに届いた pointermove は、Idle の子が受け流すので何も出ない
    const after = audioUpdate(cancelled!.model, seek(Slider.Message.MovedDragPointer({ value: 10 })));
    expect(after.model.playback.time).toBe(cancelled!.model.playback.time);
    expect(commandNames(after.commands)).toEqual([]);
  });

  it("押していないところで pointercancel が届いても、何も変えず Command も出さない", () => {
    const start = stateAt(audioContext, 100);
    const result = audioUpdate(start, Message.CancelledSliderPointer());
    expect(result.model).toEqual(start);
    expect(commandNames(result.commands)).toEqual([]);
  });

  it("ReleaseFocus の結果（CompletedReleaseFocus）は Model を変えず、Command も出さない", () => {
    const start = stateAt(audioContext, 100);
    const result = audioUpdate(start, Message.CompletedReleaseFocus());
    expect(result.model).toEqual(start);
    expect(commandNames(result.commands)).toEqual([]);
  });

  it("字幕のボタン（ToggledCaptions）を押すと、隠す／出すが替わり、フォーカスを外す", () => {
    const [hidden, shown] = run(plainUpdate, stateAt(plainContext, 100), Message.ToggledCaptions({ isOpen: false }), Message.ToggledCaptions({ isOpen: true }));
    expect(hidden!.model.captionsHidden).toBe(true);
    expect(commandNames(hidden!.commands)).toEqual(["ReleaseFocus"]);
    expect(shown!.model.captionsHidden).toBe(false);
    expect(commandNames(shown!.commands)).toEqual(["ReleaseFocus"]);
  });

  it("右の列のボタン（ClickedSide）を押すと、隠す／出すが替わり、フォーカスを外す。字幕には触らない", () => {
    const [hidden, shown] = run(plainUpdate, stateAt(plainContext, 100), Message.ClickedSide(), Message.ClickedSide());
    expect(hidden!.model.mapSurface.viewing.sideHidden).toBe(true);
    expect(hidden!.model.captionsHidden).toBe(false);
    expect(commandNames(hidden!.commands)).toEqual(["ReleaseFocus"]);
    expect(shown!.model.mapSurface.viewing.sideHidden).not.toBe(true);
    expect(commandNames(shown!.commands)).toEqual(["ReleaseFocus"]);
  });
});

describe("章名と時刻のプレビュー: ポインタの位置は再生の状態に触れない", () => {
  it("MovedSeekPointer / LeftSeekPointer は playback を変えず、Command も出さない", () => {
    const start = stateAt(audioContext, 100, { playing: true });
    const [moved, left] = run(audioUpdate, start, Message.MovedSeekPointer({ fraction: 0.75 }), Message.LeftSeekPointer());
    for (const result of [moved!, left!]) {
      expect(result.model.playback).toEqual(start.playback);
      expect(commandNames(result.commands)).toEqual([]);
    }
  });
});
