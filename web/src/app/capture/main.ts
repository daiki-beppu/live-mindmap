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

export const init = (snapshot: Snapshot): Model => ({ mapSurface: MapSurface.init(snapshot, "still", false) });

type Return = Update.Return<Model, Message>;

const toMapSurface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });

const foldMapSurface = Update.foldChild({
  update: MapSurface.update,
  read: (model: Model) => Option.some(model.mapSurface),
  write: (model: Model, mapSurface: MapSurface.Model): Model => modifyFields(model, { mapSurface: () => mapSurface }),
  toParentMessage: toMapSurface,
  foldOutMessage: () => (model: Model): Return => ({ model }),
});

export const update = (model: Model, message: Message): Return => Message.match<Return>(message, { GotMapSurfaceMessage: ({ message: child }) => foldMapSurface(model, child) });

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const attribute = Option.match(MapSurface.fitsAllOf(model.mapSurface), {
    onNone: () => [],
    onSome: (fits) => [h.Attribute(fits ? CAPTURE_READY_ATTRIBUTE : CAPTURE_OVERFLOW_ATTRIBUTE, "")],
  });
  return h.div([h.Class("capture w-full h-full"), ...attribute], [h.submodel({ slotId: "map-surface", view: MapSurface.view, model: model.mapSurface, toParentMessage: toMapSurface })]);
};
