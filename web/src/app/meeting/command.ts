import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import type { SelfPauseBody } from "../../../../server/src/serverProtocol.ts";
import { postToServer } from "../serverRequest.ts";
import { Message } from "./message.ts";

export const RequestSelfPause = Command.define("RequestSelfPause", {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedRequestSelfPause],
  execute: ({ paused }) =>
    postToServer("/session/self-pause", { paused } satisfies typeof SelfPauseBody["Encoded"]).pipe(Effect.ignore({ log: "Debug", message: "自分の一時停止を server に送れない" }), Effect.as(Message.CompletedRequestSelfPause())),
});
