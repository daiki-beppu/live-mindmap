// 見返しの Foldkit プログラム（Issue #823）: Model・update・view の根。
// Model に持つのは再生の状態（PlaybackState）と表示面の実測（size・nodeHeights）だけ。時間軸と、その時刻のマップ（Snapshot）は導いた値なので
// Model の外に置く（時間軸は Context、Snapshot は playback.time から毎回導く）
import { Option, Schema } from "effect";
import { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import { AUDIO_RATE, initialPlayback, PlaybackState, playbackReducer, type PlaybackEvent } from "../../reviewPlayback.ts";
import { snapshotAt } from "../../reviewTimeline.ts";
import * as MapSurface from "../mapSurface/main.ts";
import type { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import { PauseAudio, PlayAudio, REVIEW_AUDIO_ID, SeekAudio, WriteAudioSettings } from "./command.ts";
import type { Context } from "./context.ts";
import { Message } from "./message.ts";
import { ObserveAudio } from "./mount.ts";

export const Model = Schema.Struct({
  playback: PlaybackState,
  // 表示面の状態のうち、見返しが導く mode・snapshot を除いたもの（実測・パン・補間の状態）
  mapSurface: Schema.Struct({
    size: MapSurface.Model.fields.size,
    nodeHeights: MapSurface.Model.fields.nodeHeights,
    isMac: MapSurface.Model.fields.isMac,
    pan: MapSurface.Model.fields.pan,
    pointer: MapSurface.Model.fields.pointer,
    nodePress: MapSurface.Model.fields.nodePress,
    scrollAxisLock: MapSurface.Model.fields.scrollAxisLock,
    motion: MapSurface.Model.fields.motion,
  }),
});
export type Model = typeof Model.Type;

export const init = (context: Context): Model => {
  const { mode: _mode, snapshot: _snapshot, ...mapSurface } = MapSurface.init(snapshotAt(context.timeline, context.playback.duration), "live", context.isMac);
  return { playback: initialPlayback(context.playback.duration, Option.isSome(context.maybeAudioUrl) ? AUDIO_RATE : undefined), mapSurface };
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
    // ノードが選ばれたこと（SelectedNode）は、選択を扱う issue（#818）まで見返しでは受け流す
    foldOutMessage: () => (model: Model) => ({ model }),
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
    });
};

export const makeView = (context: Context) => (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("review")],
    [
      h.submodel({ slotId: "map-surface", view: MapSurface.view, model: surfaceOf(context, model), toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }) }),
      ...Option.match(context.maybeAudioUrl, {
        onNone: () => [],
        onSome: (url) => [h.audio([h.Id(REVIEW_AUDIO_ID), h.Src(url), h.Preload("auto"), h.OnMount(ObserveAudio())])],
      }),
    ],
  );
