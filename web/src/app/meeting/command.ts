import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import type { SelfPauseBody } from "../../../../server/src/serverProtocol.ts";
import { Message } from "./message.ts";

export const RequestSelfPause = Command.define("RequestSelfPause", {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedRequestSelfPause],
  execute: ({ paused }) =>
    Effect.tryPromise({
      try: () => fetch("/session/self-pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused } satisfies typeof SelfPauseBody["Encoded"]) }),
      catch: (error) => error,
    }).pipe(Effect.ignore({ log: "Debug", message: "自分の一時停止を server に送れない" }), Effect.as(Message.CompletedRequestSelfPause())),
});
