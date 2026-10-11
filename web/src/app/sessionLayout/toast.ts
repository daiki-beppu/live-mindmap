// セッションの画面（Issue #820）の知らせを持つ Toast（headless）。文だけを payload に持つ。
// 状態（entries・show / dismiss・duration の時間切れ）だけを Toast に任せる。描くのは main.ts の view で、Toast.view の包み要素は使わない
import { Array, Option, Schema } from "effect";
import { make } from "@foldkit/ui/toast";

export const Notice = make(Schema.Struct({ text: Schema.String }));
export type NoticeModel = typeof Notice.Model.Type;

// いま出ている文。消し始めた entry は除く（文を入れ替える間に 2 つの知らせが同時に DOM に出ないように）
export const shownText = (toast: NoticeModel): Option.Option<string> =>
  Array.findLast(toast.entries, (entry) => entry.animation.isShowing).pipe(Option.map((entry) => entry.payload.text));
