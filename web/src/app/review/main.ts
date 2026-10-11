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
  mapSurface: Schema.Struct({ size: MapSurface.Model.fields.size, nodeHeights: MapSurface.Model.fields.nodeHeights }),
});
export type Model = typeof Model.Type;

export const init = (context: Context): Model => {
  const surface = MapSurface.init(snapshotAt(context.timeline, context.playback.duration), "live");
  return { playback: initialPlayback(context.playback.duration), mapSurface: { size: surface.size, nodeHeights: surface.nodeHeights } };
};

export const snapshotOf = (context: Context, model: Model): Snapshot => snapshotAt(context.timeline, model.playback.time);

const surfaceOf = (context: Context, model: Model): MapSurface.Model => ({ mode: "live", snapshot: snapshotOf(context, model), ...model.mapSurface });

type Return = Update.Return<Model, Message>;

export const makeUpdate = (context: Context) => {
  const foldMapSurface = Update.foldChild({
    update: MapSurface.update,
    read: (model: Model) => Option.some(surfaceOf(context, model)),
    write: (model: Model, next: MapSurface.Model) => modifyFields(model, { mapSurface: () => ({ size: next.size, nodeHeights: next.nodeHeights }) }),
    toParentMessage: (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message }),
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
