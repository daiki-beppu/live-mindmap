// 見返しの Foldkit プログラム（Issue #823・#825）: Model・update・view の根。
// Model に持つのは再生の状態（PlaybackState）、表示面の実測（size・nodeHeights）、操作の行の状態（Slider・Menu・Tooltip の子の Model、ポインタの位置、押している最中か、字幕と右の列を隠しているか）。
// 時間軸・章・印と、その時刻のマップ（Snapshot）は導いた値なので Model の外に置く（時間軸・章・印は Context、Snapshot は playback.time から毎回導く）
import { Menu, Slider, Tooltip } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import { AUDIO_RATE, initialPlayback, PlaybackState, playbackReducer, type PlaybackEvent } from "../../reviewPlayback.ts";
import { snapshotAt, topicNameOf } from "../../reviewTimeline.ts";
import * as MapSurface from "../mapSurface/main.ts";
import type { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import { PauseAudio, PlayAudio, ReleaseFocus, ReleaseFocusAfterMenuClose, REVIEW_AUDIO_ID, SeekAudio, WriteAudioSettings } from "./command.ts";
import type { Context } from "./context.ts";
import { controlsView, RATE_MENU_ID, RateMenu, SEEK_SLIDER_ID, tooltipId, VOLUME_SLIDER_ID } from "./controls.ts";
import { Message, type TooltipKey } from "./message.ts";
import { ObserveAudio } from "./mount.ts";

export const Model = Schema.Struct({
  playback: PlaybackState,
  // 表示面の状態のうち、見返しが導く mode・snapshot を除いたもの（実測・パン・補間・見る状態）
  mapSurface: Schema.Struct({
    size: MapSurface.Model.fields.size,
    nodeHeights: MapSurface.Model.fields.nodeHeights,
    isMac: MapSurface.Model.fields.isMac,
    pan: MapSurface.Model.fields.pan,
    pointer: MapSurface.Model.fields.pointer,
    nodePress: MapSurface.Model.fields.nodePress,
    scrollAxisLock: MapSurface.Model.fields.scrollAxisLock,
    motion: MapSurface.Model.fields.motion,
    viewing: MapSurface.Model.fields.viewing,
    zoomScale: MapSurface.Model.fields.zoomScale,
    gestureScale: MapSurface.Model.fields.gestureScale,
    camera: MapSurface.Model.fields.camera,
  }),
  seekSlider: Slider.Model,
  volumeSlider: Slider.Model,
  rateMenu: Menu.Model,
  // ボタンごとの Tooltip（欄名は TooltipKey）
  tooltips: Schema.Struct({
    prev: Tooltip.Model,
    toggle: Tooltip.Model,
    next: Tooltip.Model,
    mute: Tooltip.Model,
    captions: Tooltip.Model,
    rate: Tooltip.Model,
    side: Tooltip.Model,
  }),
  // シークバーの上のポインタの位置（左端 0・右端 1 の割合）。乗っていないときは None
  maybeSeekPointer: Schema.Option(Schema.Finite),
  // スライダー（シーク・音量）を押している最中か。離したらフォーカスを外すために、押した事実を覚える
  isPressingSlider: Schema.Boolean,
  // 字幕・右の列を隠しているか。ボタンの押した状態（aria-pressed）とアイコンに使う
  captionsHidden: Schema.Boolean,
  sideHidden: Schema.Boolean,
});
export type Model = typeof Model.Type;

// シークバーは 1 秒刻み、音量は 0.05 刻み（音量は今の React 版と同じ）
const SEEK_STEP_SECONDS = 1;
const VOLUME_STEP = 0.05;

// シーク・音量のスライダーの設定。init と、中断で Idle に戻すときで同じものを使う
const seekSliderInit = (context: Context): Slider.Model => Slider.init({ id: SEEK_SLIDER_ID, min: 0, max: context.playback.duration, step: SEEK_STEP_SECONDS });
const volumeSliderInit = (): Slider.Model => Slider.init({ id: VOLUME_SLIDER_ID, min: 0, max: 1, step: VOLUME_STEP });

export const init = (context: Context): Model => {
  const { mode: _mode, snapshot: _snapshot, ...mapSurface } = MapSurface.init(snapshotAt(context.timeline, context.playback.duration), "live", context.isMac);
  // ツールチップは、ポインタを乗せたらすぐ出す（今の CSS の :hover と同じ）。フォーカスでは Tooltip が遅れずに出す
  const tooltip = (key: keyof Model["tooltips"]) => Tooltip.init({ id: tooltipId(key), showDelay: 0 });
  return {
    playback: initialPlayback(context.playback.duration, Option.isSome(context.maybeAudioUrl) ? AUDIO_RATE : undefined),
    mapSurface,
    seekSlider: seekSliderInit(context),
    volumeSlider: volumeSliderInit(),
    rateMenu: Menu.init({ id: RATE_MENU_ID }),
    tooltips: { prev: tooltip("prev"), toggle: tooltip("toggle"), next: tooltip("next"), mute: tooltip("mute"), captions: tooltip("captions"), rate: tooltip("rate"), side: tooltip("side") },
    maybeSeekPointer: Option.none(),
    isPressingSlider: false,
    captionsHidden: false,
    sideHidden: false,
  };
};

export const snapshotOf = (context: Context, model: Model): Snapshot => snapshotAt(context.timeline, model.playback.time);

const surfaceOf = (context: Context, model: Model): MapSurface.Model => ({ mode: "live", snapshot: snapshotOf(context, model), ...model.mapSurface });

type Return = Update.Return<Model, Message>;

export const makeUpdate = (context: Context) => {
  const foldMapSurface = Update.foldChild({
    update: MapSurface.update,
    read: (model: Model) => Option.some(surfaceOf(context, model)),
    // 見返しには補間を進める Subscription が無く、補間を始めると始まりの位置で止まるので、motion は保存しない
    write: (model: Model, { mode: _mode, snapshot: _snapshot, ...next }: MapSurface.Model) => modifyFields(model, { mapSurface: () => modifyFields(next, { motion: () => Option.none() }) }),
    toParentMessage: (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message }),
    // 選択は表示面の viewing が持つので、ノードが選ばれたこと（SelectedNode）は見返しでは受け流す
    foldOutMessage: () => (model: Model) => ({ model }),
  });
  // 子（Slider・Menu・Tooltip）は foldChild で組み込み、結果は OutMessage（ChangedValue・Selected）だけを variant の名前で受ける。子の内部の Message は見ない
  const foldSeekSlider = Update.foldChild({
    update: Slider.update,
    read: (model: Model) => Option.some(model.seekSlider),
    write: (model: Model, seekSlider: Slider.Model) => modifyFields(model, { seekSlider: () => seekSlider }),
    toParentMessage: (message: Slider.Message) => Message.GotSeekSliderMessage({ message }),
    foldOutMessage: (outMessage: Slider.OutMessage) =>
      Slider.OutMessage.match(outMessage, { ChangedValue: ({ value }) => (model: Model) => moved(model, { type: "seek", time: value }) }),
  });
  const foldVolumeSlider = Update.foldChild({
    update: Slider.update,
    read: (model: Model) => Option.some(model.volumeSlider),
    write: (model: Model, volumeSlider: Slider.Model) => modifyFields(model, { volumeSlider: () => volumeSlider }),
    toParentMessage: (message: Slider.Message) => Message.GotVolumeSliderMessage({ message }),
    foldOutMessage: (outMessage: Slider.OutMessage) =>
      Slider.OutMessage.match(outMessage, { ChangedValue: ({ value }) => (model: Model) => changedSettings(model, { type: "setVolume", volume: value }) }),
  });
  const foldRateMenu = Update.foldChild({
    update: RateMenu.update,
    read: (model: Model) => Option.some(model.rateMenu),
    write: (model: Model, rateMenu: Menu.Model) => modifyFields(model, { rateMenu: () => rateMenu }),
    toParentMessage: (message: Menu.Message) => Message.GotRateMenuMessage({ message }),
    // 選ばれた項目の位置で速さを引く（項目は速さの並びの順）。選んだらフォーカスを外す
    foldOutMessage: (outMessage: Menu.OutMessage<string>) =>
      Menu.OutMessage.match(outMessage, {
        Selected: ({ index }) => (model: Model) => {
          const rate = context.playback.rates[index];
          return rate === undefined ? { model } : changedSettings(model, { type: "setRate", rate }, [ReleaseFocusAfterMenuClose()]);
        },
      }),
  });
  const foldTooltip = Update.foldChildAt({
    update: Tooltip.update,
    readAt: (model: Model, key: TooltipKey) => Option.some(model.tooltips[key]),
    writeAt: (model: Model, key: TooltipKey, tooltip: Tooltip.Model) => modifyFields(model, { tooltips: (tooltips) => ({ ...tooltips, [key]: tooltip }) }),
    toParentMessage: (key: TooltipKey, message: Tooltip.Message) => Message.GotTooltipMessage({ tooltipId: key, message }),
    // 吹き出しが出た・隠れた（Shown・Hidden）ことは、見返しでは受け流す
    foldOutMessage: () => () => (model: Model) => ({ model }),
  });
  // 時刻が変わったときだけ <audio> の currentTime に書く（書かないと、次の timeupdate で元の時刻へ戻る）
  const reduce = (model: Model, event: PlaybackEvent): Model => modifyFields(model, { playback: (playback) => playbackReducer(playback, event, context.playback) });
  const hasAudio = Option.isSome(context.maybeAudioUrl);
  const moved = (model: Model, event: PlaybackEvent): Return => {
    const next = reduce(model, event);
    if (hasAudio && next.playback.time !== model.playback.time) return { model: next, commands: [SeekAudio({ time: next.playback.time })] };
    return { model: next };
  };
  const toggled = (model: Model): Return => {
    const next = reduce(model, { type: "toggle" });
    if (!hasAudio) return { model: next };
    if (!next.playback.playing) return { model: next, commands: [PauseAudio()] };
    const { rate, muted, volume } = next.playback;
    const play = [WriteAudioSettings({ rate, muted, volume }), PlayAudio()];
    if (next.playback.time !== model.playback.time) return { model: next, commands: [SeekAudio({ time: next.playback.time }), ...play] };
    return { model: next, commands: play };
  };
  // 録音が会議より長いときは、会議の長さで止めた Model に合わせて <audio> も止める
  const heardTime = (model: Model, time: number): Return => {
    const next = reduce(model, { type: "audioTime", time });
    if (model.playback.playing && !next.playback.playing) return { model: next, commands: [PauseAudio()] };
    return { model: next };
  };
  // AbortError は別の play()/pause() に割り込まれただけなので無視する。止めたあとに届いた失敗で再生が始まらないよう、今も再生中のときだけ止める
  const failedPlay = (model: Model, isAborted: boolean): Return =>
    !isAborted && model.playback.playing ? { model: reduce(model, { type: "toggle" }) } : { model };
  // 速さ・ミュート・音量の変化は、録音つきなら <audio> にも書く。extra は同じ操作で返したい Command（フォーカスを外すなど）
  const changedSettings = (model: Model, event: PlaybackEvent, extra: ReadonlyArray<ReturnType<typeof ReleaseFocus> | ReturnType<typeof ReleaseFocusAfterMenuClose>> = []): Return => {
    const next = reduce(model, event);
    const { rate, muted, volume } = next.playback;
    const commands = [...(hasAudio ? [WriteAudioSettings({ rate, muted, volume })] : []), ...extra];
    return commands.length === 0 ? { model: next } : { model: next, commands };
  };
  // 押したあと、フォーカスを外す
  const released = (model: Model): Return => ({ model, commands: [ReleaseFocus()] });
  return (model: Model, message: Message): Return =>
    Message.match<Return>(message, {
      ClickedPrev: () => moved(model, { type: "prev" }),
      ClickedNext: () => moved(model, { type: "next" }),
      ClickedToggle: () => toggled(model),
      TickedFrame: ({ ms }) => ({ model: reduce(model, { type: "elapsed", seconds: ms / 1000 }) }),
      UpdatedAudioTime: ({ time }) => heardTime(model, time),
      EndedAudio: () => ({ model: reduce(model, { type: "ended" }) }),
      FailedPlayAudio: ({ isAborted }) => failedPlay(model, isAborted),
      SucceededPlayAudio: () => ({ model }),
      CompletedPauseAudio: () => ({ model }),
      CompletedSeekAudio: () => ({ model }),
      CompletedWriteAudioSettings: () => ({ model }),
      GotMapSurfaceMessage: ({ message }) => foldMapSurface(model, message),
      GotSeekSliderMessage: ({ message }) => foldSeekSlider(model, message),
      GotVolumeSliderMessage: ({ message }) => foldVolumeSlider(model, message),
      GotRateMenuMessage: ({ message }) => foldRateMenu(model, message),
      GotTooltipMessage: ({ tooltipId, message }) => foldTooltip(model, tooltipId, message),
      ClickedMute: () => changedSettings(model, { type: "toggleMute" }, [ReleaseFocus()]),
      ToggledCaptions: ({ isOpen }) => released(modifyFields(model, { captionsHidden: () => !isOpen })),
      ClickedSide: () => released(modifyFields(model, { sideHidden: (hidden) => !hidden })),
      MovedSeekPointer: ({ fraction }) => ({ model: modifyFields(model, { maybeSeekPointer: () => Option.some(fraction) }) }),
      LeftSeekPointer: () => ({ model: modifyFields(model, { maybeSeekPointer: () => Option.none() }) }),
      PressedSliderPointer: () => ({ model: modifyFields(model, { isPressingSlider: () => true }) }),
      // 押していないところで離しても（ほかの場所のクリックの pointerup）、フォーカスは外さない
      ReleasedSliderPointer: () => (model.isPressingSlider ? released(modifyFields(model, { isPressingSlider: () => false })) : { model }),
      // 中断された。値は中断時点のまま、子の Slider を Idle に戻してドラッグを終える（押していないところで中断しても何もしない）
      CancelledSliderPointer: () =>
        model.isPressingSlider
          ? {
              model: modifyFields(model, { isPressingSlider: () => false, seekSlider: () => seekSliderInit(context), volumeSlider: () => volumeSliderInit() }),
              commands: [ReleaseFocus()],
            }
          : { model },
      CompletedReleaseFocus: () => ({ model }),
      CompletedReleaseFocusAfterMenuClose: () => ({ model }),
    });
};

export const makeView = (context: Context) => (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("review")],
    [
      h.div(
        [h.Class("review__session")],
        [h.submodel({ slotId: "map-surface", view: MapSurface.view, model: surfaceOf(context, model), toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }) })],
      ),
      controlsView(context, model, topicNameOf(snapshotOf(context, model)), h),
      ...Option.match(context.maybeAudioUrl, {
        onNone: () => [],
        onSome: (url) => [h.audio([h.Id(REVIEW_AUDIO_ID), h.Src(url), h.Preload("auto"), h.OnMount(ObserveAudio())])],
      }),
    ],
  );
