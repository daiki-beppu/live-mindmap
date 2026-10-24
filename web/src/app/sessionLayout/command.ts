import { Effect, Schema } from "effect";
import { Command, Dom } from "foldkit";
import type { SpeakerNameBody } from "../../../../server/src/serverProtocol.ts";
import { Message } from "./message.ts";

export const RequestSpeakerName = Command.define("RequestSpeakerName", {
  args: { label: Schema.String, name: Schema.String },
  messages: [Message.CompletedRequestSpeakerName],
  execute: ({ label, name }) =>
    Effect.tryPromise({
      try: () => fetch("/session/speaker-name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label, name } satisfies typeof SpeakerNameBody["Encoded"]) }),
      catch: (error) => error,
    }).pipe(Effect.ignore, Effect.as(Message.CompletedRequestSpeakerName())),
});

// autofocus は文書で最初の 1 回しか効かないので、押すたびにフォーカスを移す
export const FocusSpeakerNameInput = Command.define("FocusSpeakerNameInput", {
  args: { id: Schema.String },
  messages: [Message.CompletedFocusSpeakerNameInput],
  execute: ({ id }) => Dom.focus(`#${id}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusSpeakerNameInput())),
});
