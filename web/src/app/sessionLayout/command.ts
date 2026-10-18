// 字幕の名前の欄が server へ送る Command（Issue #1026）。結果は Message で update に戻す
import { Effect, Schema } from "effect";
import { Command, Dom } from "foldkit";
import type { SpeakerNameBody } from "../../../../server/src/serverProtocol.ts";
import { Message } from "./message.ts";

// 話者のラベル（相手 B）に名前を手で付ける指示。開発用サーバーの proxy と本番の配信のどちらでも同じオリジンの操作用ポートへ届く。
// 送れなかった・断られたときも画面は変えない（名前は /ws の speaker-names の frame だけで変わる）ので、結果は区別せず完了として返す
export const RequestSpeakerName = Command.define("RequestSpeakerName", {
  args: { label: Schema.String, name: Schema.String },
  messages: [Message.CompletedRequestSpeakerName],
  execute: ({ label, name }) =>
    Effect.tryPromise({
      try: () => fetch("/session/speaker-name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label, name } satisfies typeof SpeakerNameBody["Encoded"]) }),
      catch: (error) => error,
    }).pipe(Effect.ignore, Effect.as(Message.CompletedRequestSpeakerName())),
});

// 名前の入力のフォーカス。押したらそのまま打てるようにする（autofocus は文書で最初の 1 回しか効かないので、押すたびにフォーカスを移す）。
// 描画の後に走るので、入力は欄の中にできている
export const FocusSpeakerNameInput = Command.define("FocusSpeakerNameInput", {
  args: { id: Schema.String },
  messages: [Message.CompletedFocusSpeakerNameInput],
  execute: ({ id }) => Dom.focus(`#${id}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusSpeakerNameInput())),
});
