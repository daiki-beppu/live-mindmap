import { Effect, Schema } from "effect";
import { Command, Dom } from "foldkit";
import type { SpeakerNameBody } from "../../../../server/src/serverProtocol.ts";
import { postToServer } from "../serverRequest.ts";
import { Message } from "./message.ts";

export const RequestSpeakerName = Command.define("RequestSpeakerName", {
  args: { label: Schema.String, name: Schema.String },
  messages: [Message.CompletedRequestSpeakerName],
  execute: ({ label, name }) =>
    postToServer("/session/speaker-name", { label, name } satisfies typeof SpeakerNameBody["Encoded"]).pipe(Effect.ignore({ log: "Debug", message: "話者の名前を server に送れない" }), Effect.as(Message.CompletedRequestSpeakerName())),
});

// autofocus は文書で最初の 1 回しか効かないので、押すたびにフォーカスを移す
export const FocusSpeakerNameInput = Command.define("FocusSpeakerNameInput", {
  args: { id: Schema.String },
  messages: [Message.CompletedFocusSpeakerNameInput],
  execute: ({ id }) => Dom.focus(`#${id}`).pipe(Effect.ignore({ log: "Debug", message: "名前の入力欄にフォーカスできない" }), Effect.as(Message.CompletedFocusSpeakerNameInput())),
});
