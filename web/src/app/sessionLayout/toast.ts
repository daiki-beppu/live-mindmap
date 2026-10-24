import { Array, Option, Schema } from "effect";
import { make } from "@foldkit/ui/toast";

export const Notice = make(Schema.Struct({ text: Schema.String }));
export type NoticeModel = typeof Notice.Model.Type;

export const shownText = (toast: NoticeModel): Option.Option<string> =>
  Array.findLast(toast.entries, (entry) => entry.animation.isShowing).pipe(Option.map((entry) => entry.payload.text));
