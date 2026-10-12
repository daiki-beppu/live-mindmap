// 撮影（map.png）の Foldkit プログラム（Issue #827）: サーバーが渡したスナップショットの、静止した 1 枚を描く。
// 畳まず、補間せず、人の操作も受けない（still）。変わったノードの強調・仮のノード・右の列・字幕は出さない。
// Model は表示面の Model 1 つ（mode は still、snapshot は起動時に渡されたもので変わらない）。
// ready / overflow の属性は、表示面の Model から毎回導く（Model には持たない）
import { Option, Schema } from "effect";
import { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { CAPTURE_OVERFLOW_ATTRIBUTE, CAPTURE_READY_ATTRIBUTE } from "../../../../server/src/core/capture.ts";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import * as MapSurface from "../mapSurface/main.ts";
import type { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import { Message } from "./message.ts";

export const Model = Schema.Struct({
  mapSurface: MapSurface.Model,
});
export type Model = typeof Model.Type;

// still は wheel・gesture を受けないので、Mac かどうかは使わない（false）
export const init = (snapshot: Snapshot): Model => ({ mapSurface: MapSurface.init(snapshot, "still", false) });

type Return = Update.Return<Model, Message>;

const toMapSurface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });

const foldMapSurface = Update.foldChild({
  update: MapSurface.update,
  read: (model: Model) => Option.some(model.mapSurface),
  write: (model: Model, mapSurface: MapSurface.Model): Model => modifyFields(model, { mapSurface: () => mapSurface }),
  toParentMessage: toMapSurface,
  // ノードが選ばれたこと（SelectedNode）は、撮影では受け流す（still は選択を描かない）
  foldOutMessage: () => (model: Model): Return => ({ model }),
});

export const update = (model: Model, message: Message): Return => Message.match<Return>(message, { GotMapSurfaceMessage: ({ message: child }) => foldMapSurface(model, child) });

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  // 全ノードが測られ、全体を収めようとした後に、全体が画面に入れば ready、入らなければ overflow。測り終えるまでは付けない
  const attribute = Option.match(MapSurface.fitsAllOf(model.mapSurface), {
    onNone: () => [],
    onSome: (fits) => [h.Attribute(fits ? CAPTURE_READY_ATTRIBUTE : CAPTURE_OVERFLOW_ATTRIBUTE, "")],
  });
  return h.div([h.Class("capture w-full h-full"), ...attribute], [h.submodel({ slotId: "map-surface", view: MapSurface.view, model: model.mapSurface, toParentMessage: toMapSurface })]);
};
