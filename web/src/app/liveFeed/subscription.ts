// ライブの受信（Issue #828）の Subscription。/ws の WebSocket を開き、「つながった」「frame を受けた」「切れた」の事実を Message にして届けるだけで、
// 状態は更新しない。切れたら RECONNECT_MS 後につなぎ直すのも、この 1 本の stream の中で行う（止めれば、待ちも socket も片付く）。
// frame は境界で Schema で decode し、decode できないもの（壊れた JSON・知らない type・形の合わないもの）は無視する。
// 時間はこの Subscription が計る（Issue #1022）。frame を受けた時刻は Clock から付け、字幕の期限は sleep して届ける。update は時刻を読まない
import { Clock, Effect, Option, Queue, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { nextCaptionDeadline } from "../../captions.ts";
import type { Model } from "./main.ts";
import { LiveFrame, Message } from "./message.ts";

export const RECONNECT_MS = 1000;

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(LiveFrame));

const liveFeedUrl = (): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// socket から届く事実。受けた時刻は、Stream に流れた後に Clock から付ける
type SocketEvent = { kind: "connected" } | { kind: "frame"; frame: LiveFrame } | { kind: "disconnected" };

// 1 回の接続。切れたら disconnected を出して終わる。止められたときは socket を閉じ、その後の通知は流さない
const connection: Stream.Stream<SocketEvent> = Stream.callback<SocketEvent>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const ws = new WebSocket(liveFeedUrl());
      ws.onopen = () => void Queue.offerUnsafe(queue, { kind: "connected" });
      ws.onmessage = (event) => {
        const frame = decodeFrame(String(event.data));
        if (Option.isSome(frame)) Queue.offerUnsafe(queue, { kind: "frame", frame: frame.value });
      };
      ws.onclose = () => {
        Queue.offerUnsafe(queue, { kind: "disconnected" });
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

const toMessage = (event: SocketEvent): Effect.Effect<Message> => {
  if (event.kind === "connected") return Effect.succeed(Message.ConnectedLiveFeed());
  if (event.kind === "disconnected") return Effect.succeed(Message.DisconnectedLiveFeed());
  return Effect.map(Clock.currentTimeMillis, (receivedAt) => Message.ReceivedLiveFrame({ frame: event.frame, receivedAt }));
};

export const liveFeedStream: Stream.Stream<Message> = Stream.forever(
  Stream.concat(Stream.mapEffect(connection, toMessage), Stream.drain(Stream.fromEffect(Effect.sleep(RECONNECT_MS)))),
);

// 字幕の期限まで待って、来たことを 1 回届ける。期限が無ければ何も流さない
export const captionDeadlineStream = (deadline: number | null): Stream.Stream<Message> =>
  deadline === null
    ? Stream.empty
    : Stream.fromEffect(
        Effect.gen(function* () {
          yield* Effect.sleep(Math.max(0, deadline - (yield* Clock.currentTimeMillis)));
          return Message.ReachedCaptionDeadline({ at: yield* Clock.currentTimeMillis });
        }),
      );

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  liveFeed: Subscription.persistentEntry(liveFeedStream),
  // 次の期限が変わるたびに、待ちを張り直す
  captionDeadline: entry(
    { deadline: Schema.NullOr(Schema.Finite) },
    {
      modelToDependencies: (model) => ({ deadline: nextCaptionDeadline(model.captions) ?? null }),
      dependenciesToStream: ({ deadline }) => captionDeadlineStream(deadline),
    },
  ),
}));
