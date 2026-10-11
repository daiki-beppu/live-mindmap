// ライブの受信（Issue #828）の Subscription。/ws の WebSocket を開き、「つながった」「frame を受けた」「切れた」の事実を Message にして届けるだけで、
// 状態は更新しない。切れたら RECONNECT_MS 後につなぎ直すのも、この 1 本の stream の中で行う（止めれば、待ちも socket も片付く）。
// frame は境界で Schema で decode し、decode できないもの（壊れた JSON・知らない type・形の合わないもの）は無視する
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import type { Model } from "./main.ts";
import { LiveFrame, Message } from "./message.ts";

export const RECONNECT_MS = 1000;

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(LiveFrame));

const liveFeedUrl = (): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// 1 回の接続。切れたら DisconnectedLiveFeed を出して終わる。止められたときは socket を閉じ、その後の通知は Message にしない
const connection: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const ws = new WebSocket(liveFeedUrl());
      ws.onopen = () => void Queue.offerUnsafe(queue, Message.ConnectedLiveFeed());
      ws.onmessage = (event) => {
        const frame = decodeFrame(String(event.data));
        if (Option.isSome(frame)) Queue.offerUnsafe(queue, Message.ReceivedLiveFrame({ frame: frame.value }));
      };
      ws.onclose = () => {
        Queue.offerUnsafe(queue, Message.DisconnectedLiveFeed());
        Queue.endUnsafe(queue);
      };
      return ws;
    }),
    (ws) =>
      Effect.sync(() => {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }),
  ),
);

export const liveFeedStream: Stream.Stream<Message> = Stream.forever(Stream.concat(connection, Stream.drain(Stream.fromEffect(Effect.sleep(RECONNECT_MS)))));

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  liveFeed: Subscription.persistentEntry(liveFeedStream),
}));
