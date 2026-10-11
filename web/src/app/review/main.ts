// 見返しの Foldkit プログラム（Issue #823）: Model・update・view の根。
// Model に持つのは再生の状態（PlaybackState）と表示面の実測（size・nodeHeights）だけ。時間軸と、その時刻のマップ（Snapshot）は導いた値なので
// Model の外に置く（時間軸は Context、Snapshot は playback.time から毎回導く）
import { Option, Schema } from "effect";
import { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import { initialPlayback, PlaybackState, playbackReducer } from "../../reviewPlayback.ts";
import { snapshotAt } from "../../reviewTimeline.ts";
import * as MapSurface from "../mapSurface/main.ts";
import type { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import type { Context } from "./context.ts";
import { Message } from "./message.ts";

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
  }),
});
export type Model = typeof Model.Type;

export const init = (context: Context): Model => {
  const { mode: _mode, snapshot: _snapshot, ...mapSurface } = MapSurface.init(snapshotAt(context.timeline, context.playback.duration), "live", context.isMac);
  return { playback: initialPlayback(context.playback.duration), mapSurface };
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
  return (model: Model, message: Message): Return =>
    Message.match<Return>(message, {
      ClickedPrev: () => ({ model: modifyFields(model, { playback: (playback) => playbackReducer(playback, { type: "prev" }, context.playback) }) }),
      ClickedNext: () => ({ model: modifyFields(model, { playback: (playback) => playbackReducer(playback, { type: "next" }, context.playback) }) }),
      GotMapSurfaceMessage: ({ message }) => foldMapSurface(model, message),
    });
};

export const makeView = (context: Context) => (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("review")],
    [h.submodel({ slotId: "map-surface", view: MapSurface.view, model: surfaceOf(context, model), toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }) })],
  );
