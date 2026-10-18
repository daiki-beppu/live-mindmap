// 会議中の画面が server へ送る Command（Issue #1069）。結果は Message で update に戻す
import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import type { SelfPauseBody } from "../../../../server/src/serverProtocol.ts";
import { Message } from "./message.ts";

// 自分の休止・再開の指示。paused は求める状態（画面に見えている状態の逆）。トグルではなく状態を指定する形で送る。
// 開発用サーバーの proxy と本番の配信のどちらでも同じオリジンの操作用ポートへ届く。
// 送れなかった・断られたときも画面は変えない（休止の状態は /ws の frame だけで変わる）ので、結果は区別せず完了として返す
export const RequestSelfPause = Command.define("RequestSelfPause", {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedRequestSelfPause],
  execute: ({ paused }) =>
    Effect.tryPromise({
      try: () => fetch("/session/self-pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused } satisfies typeof SelfPauseBody["Encoded"]) }),
      catch: (error) => error,
    }).pipe(Effect.ignore, Effect.as(Message.CompletedRequestSelfPause())),
});
